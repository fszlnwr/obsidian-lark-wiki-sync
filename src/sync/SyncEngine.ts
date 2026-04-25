import { App, FileSystemAdapter, normalizePath, TFile } from "obsidian";
import type { LarkWikiSyncSettings, WikiSpaceConfig } from "../settings";
import type { LarkCli } from "../lark/LarkCli";
import type { StateStore, FileSyncState } from "../state/StateStore";
import { hashString } from "../util/hash";
import { extractImageTokens, larkToObsidianMarkdown } from "../util/larkToObsidianMd";

const ATTACHMENTS_SUBFOLDER = "_attachments";

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  skipped: number;
}

export interface SyncOptions {
  dryRun?: boolean;
}

/**
 * SyncEngine orchestrates pull/push/merge across one or more wiki spaces.
 *
 * Per space:
 *   1. Walk the node tree (paginated, recursive).
 *   2. For each docx node:
 *      a. Fetch raw Lark markdown, download referenced images, transform to
 *         Obsidian-flavoured markdown, compute remoteHash.
 *      b. Look up FileSyncState for the corresponding local path.
 *      c. Classify against the lastSyncedHash (3-way diff) and apply the
 *         appropriate action.
 *
 * Spaces are processed independently — a failure in one space does not stop
 * the others; the error is logged and counted, then we move on.
 */
export class SyncEngine {
  constructor(
    private app: App,
    private settings: LarkWikiSyncSettings,
    private lark: LarkCli,
    private state: StateStore,
  ) {}

  async run(opts: SyncOptions = {}): Promise<SyncResult> {
    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, skipped: 0 };

    const spaces = this.settings.spaces ?? [];
    if (spaces.length === 0) {
      throw new Error("No wiki spaces configured. Open settings to add one.");
    }

    for (const space of spaces) {
      try {
        const partial = await this.syncOneSpace(space, opts);
        result.pulled += partial.pulled;
        result.pushed += partial.pushed;
        result.conflicts += partial.conflicts;
        result.skipped += partial.skipped;
      } catch (err) {
        console.error(
          `LarkWikiSync: space "${space.spaceName || space.spaceId}" failed:`,
          err,
        );
        // surface to user, but keep going for the remaining spaces
        result.conflicts++; // bookkeeping bucket; "errors" would be a 5th field
      }
    }

    if (!opts.dryRun) {
      this.settings.lastSyncedAt = new Date().toISOString();
      await this.state.save();
    }

    return result;
  }

  private async syncOneSpace(
    space: WikiSpaceConfig,
    opts: SyncOptions,
  ): Promise<SyncResult> {
    const result: SyncResult = { pulled: 0, pushed: 0, conflicts: 0, skipped: 0 };

    const nodes = await this.lark.listAllDescendants(
      space.spaceId,
      space.rootNode || undefined,
    );

    const effectiveRoot = this.effectiveRoot(space);
    const attachmentsRel = `${effectiveRoot}/${ATTACHMENTS_SUBFOLDER}`;
    const attachmentsAbs = this.resolveAttachmentsAbsolutePath(space);
    const existingAttachments = await this.scanAttachmentsCache(attachmentsRel);

    for (const node of nodes) {
      if (node.obj_type !== "docx") continue;

      const localPath = this.mapNodeToLocalPath(space, node);
      const existing = this.state.get(localPath);

      try {
        const rawMd = await this.lark.fetchDoc(node.obj_token);
        const imageMap = await this.resolveImageMap(
          rawMd,
          attachmentsRel,
          attachmentsAbs,
          existingAttachments,
        );
        const remoteMd = larkToObsidianMarkdown(rawMd, { imageMap });
        const remoteHash = hashString(remoteMd);

        const localFile = this.app.vault.getAbstractFileByPath(localPath);
        const localMd =
          localFile instanceof TFile ? await this.app.vault.read(localFile) : null;
        const localHash = localMd ? hashString(localMd) : null;

        if (!existing && !localFile) {
          if (!opts.dryRun) {
            await this.writeLocal(localPath, remoteMd);
            this.recordSync(localPath, node.node_token, node.obj_token, remoteHash);
          }
          result.pulled++;
          continue;
        }

        if (!existing && localFile) {
          result.conflicts++;
          console.warn(
            `LarkWikiSync: untracked local file collides with remote node: ${localPath}`,
          );
          continue;
        }

        const base = existing!.lastSyncedHash;
        const localChanged = localHash !== null && localHash !== base;
        const remoteChanged = remoteHash !== base;

        if (!localChanged && !remoteChanged) {
          result.skipped++;
          continue;
        }

        if (remoteChanged && !localChanged) {
          if (!opts.dryRun) {
            await this.writeLocal(localPath, remoteMd);
            this.recordSync(localPath, node.node_token, node.obj_token, remoteHash);
          }
          result.pulled++;
          continue;
        }

        if (!remoteChanged && localChanged) {
          if (this.settings.direction === "pull") {
            result.skipped++;
            continue;
          }
          if (!opts.dryRun) {
            await this.lark.updateDoc(node.obj_token, localMd!, "replace_all");
            this.recordSync(localPath, node.node_token, node.obj_token, localHash!);
          }
          result.pushed++;
          continue;
        }

        result.conflicts++;
        if (!opts.dryRun) {
          await this.handleConflict(localPath, node, localMd!, remoteMd, existing!);
        }
      } catch (err) {
        console.error(`LarkWikiSync: failed on ${localPath}`, err);
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Per-space path helpers
  // ---------------------------------------------------------------------------

  /**
   * Vault-relative root for the given space, e.g. `📥 Lark/Nexus Wiki`.
   * Falls back to just `localRoot` if the space name isn't set yet
   * (legacy migration path).
   */
  private effectiveRoot(space: WikiSpaceConfig): string {
    const sanitize = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_");
    const parts = [this.settings.localRoot];
    if (space.spaceName) parts.push(sanitize(space.spaceName));
    return parts.join("/");
  }

  private resolveAttachmentsAbsolutePath(space: WikiSpaceConfig): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Lark Wiki Sync requires Obsidian desktop (FileSystemAdapter).");
    }
    return `${adapter.getBasePath()}/${this.effectiveRoot(space)}/${ATTACHMENTS_SUBFOLDER}`;
  }

  private mapNodeToLocalPath(
    space: WikiSpaceConfig,
    node: {
      title: string;
      node_token: string;
      obj_type: string;
      parentPath?: string[];
    },
  ): string {
    const sanitize = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_");
    const segments = [
      this.effectiveRoot(space),
      ...(node.parentPath ?? []).map(sanitize),
      `${sanitize(node.title)}.md`,
    ];
    return normalizePath(segments.join("/"));
  }

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  private async scanAttachmentsCache(relFolder: string): Promise<Record<string, string>> {
    const cache: Record<string, string> = {};
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(relFolder))) return cache;
    const listing = await adapter.list(relFolder);
    for (const filePath of listing.files) {
      const filename = filePath.split("/").pop();
      if (!filename) continue;
      const dot = filename.indexOf(".");
      const token = dot > 0 ? filename.slice(0, dot) : filename;
      cache[token] = filename;
    }
    return cache;
  }

  private async resolveImageMap(
    rawMd: string,
    relFolder: string,
    absFolder: string,
    cache: Record<string, string>,
  ): Promise<Record<string, string>> {
    const tokens = extractImageTokens(rawMd);
    if (tokens.length === 0) return {};

    const map: Record<string, string> = {};
    const toDownload: string[] = [];
    for (const token of tokens) {
      if (cache[token]) {
        map[token] = cache[token];
      } else {
        toDownload.push(token);
      }
    }
    if (toDownload.length === 0) return map;

    await this.ensureFolder(relFolder);

    for (const token of toDownload) {
      try {
        const filename = await this.lark.downloadMedia(token, absFolder);
        if (filename) {
          cache[token] = filename;
          map[token] = filename;
        }
      } catch (err) {
        console.warn(`LarkWikiSync: failed to download image ${token}`, err);
      }
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Vault I/O
  // ---------------------------------------------------------------------------

  private async writeLocal(path: string, content: string): Promise<void> {
    const folder = path.substring(0, path.lastIndexOf("/"));
    if (folder) await this.ensureFolder(folder);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(path, content);
    }
  }

  private async ensureFolder(folder: string): Promise<void> {
    const parts = folder.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!(await this.app.vault.adapter.exists(cur))) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (err) {
          if (!(await this.app.vault.adapter.exists(cur))) throw err;
        }
      }
    }
  }

  private recordSync(
    localPath: string,
    nodeToken: string,
    docToken: string,
    hash: string,
  ): void {
    const entry: FileSyncState = {
      localPath,
      nodeToken,
      docToken,
      lastSyncedHash: hash,
      lastSyncedAt: new Date().toISOString(),
    };
    this.state.upsert(entry);
  }

  private async handleConflict(
    localPath: string,
    node: { node_token: string; obj_token: string; title: string },
    localMd: string,
    remoteMd: string,
    _prev: FileSyncState,
  ): Promise<void> {
    switch (this.settings.conflictPolicy) {
      case "prefer-local": {
        await this.lark.updateDoc(node.obj_token, localMd, "replace_all");
        this.recordSync(localPath, node.node_token, node.obj_token, hashString(localMd));
        return;
      }
      case "prefer-remote": {
        await this.writeLocal(localPath, remoteMd);
        this.recordSync(localPath, node.node_token, node.obj_token, hashString(remoteMd));
        return;
      }
      case "ask":
      default: {
        // TODO(v0.3): open a three-way diff modal. For now, write a sidecar
        // so neither side is destroyed.
        const conflictPath = `${localPath}.remote.conflict.md`;
        await this.writeLocal(conflictPath, remoteMd);
        console.warn(
          `LarkWikiSync: conflict on ${localPath}. Remote saved to ${conflictPath}; manual merge required.`,
        );
        return;
      }
    }
  }
}
