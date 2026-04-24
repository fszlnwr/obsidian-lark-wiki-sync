import { App, FileSystemAdapter, normalizePath, TFile } from "obsidian";
import type { LarkWikiSyncSettings } from "../settings";
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
 * SyncEngine orchestrates the actual pull/push/merge logic.
 *
 * High-level algorithm (v0.1 pull-only):
 *
 *   1. List wiki nodes under the configured root.
 *   2. For each node that maps to a doc:
 *      a. Fetch remote markdown + compute remoteHash.
 *      b. Look up FileSyncState for the corresponding local path.
 *      c. If no state: this is a new pull — write file + record hash.
 *      d. If state exists:
 *         - localHash == lastSyncedHash && remoteHash != lastSyncedHash → remote-only change → pull.
 *         - localHash != lastSyncedHash && remoteHash == lastSyncedHash → local-only change → push.
 *         - both changed → conflict (apply conflict policy).
 *         - neither changed → skip.
 *   3. Handle deletions (node removed on Lark, file removed in vault) in later versions.
 *
 * For v0.0.1 this file contains the scaffold + pull path only.
 * Push + conflict resolution are stubbed and should be filled in next.
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

    if (!this.settings.wikiSpaceId) {
      throw new Error("No Wiki space configured. Run the setup wizard.");
    }

    const nodes = await this.lark.listAllDescendants(
      this.settings.wikiSpaceId,
      this.settings.wikiRootNode || undefined,
    );

    // Effective root nests each space under its own subfolder so multiple
    // synced spaces stay self-contained.
    const effectiveRoot = this.effectiveRoot();

    // Pre-scan the attachments folder once so repeat syncs don't re-download
    // already-cached images.
    const attachmentsRel = `${effectiveRoot}/${ATTACHMENTS_SUBFOLDER}`;
    const attachmentsAbs = this.resolveAttachmentsAbsolutePath();
    const existingAttachments = await this.scanAttachmentsCache(attachmentsRel);

    for (const node of nodes) {
      if (node.obj_type !== "docx") continue; // v0.1 only handles docx nodes

      const localPath = this.mapNodeToLocalPath(node);
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

        // Classify the 4 cases
        if (!existing && !localFile) {
          // brand new pull
          if (!opts.dryRun) {
            await this.writeLocal(localPath, remoteMd);
            this.recordSync(localPath, node.node_token, node.obj_token, remoteHash);
          }
          result.pulled++;
          continue;
        }

        if (!existing && localFile) {
          // local exists but never tracked — treat as conflict
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
          // push path (stub for v0.0.1)
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

        // Both changed → conflict
        result.conflicts++;
        if (!opts.dryRun) {
          await this.handleConflict(localPath, node, localMd!, remoteMd, existing!);
        }
      } catch (err) {
        console.error(`LarkWikiSync: failed on ${localPath}`, err);
      }
    }

    if (!opts.dryRun) {
      this.settings.lastSyncedAt = new Date().toISOString();
      await this.state.save();
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  /**
   * Vault-relative root for the currently configured space, e.g.
   * `📥 Lark/Nexus Wiki`. Falls back to just `localRoot` if the space name
   * isn't set yet (upgrade path for pre-0.0.9 configs).
   */
  private effectiveRoot(): string {
    const sanitize = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_");
    const parts = [this.settings.localRoot];
    if (this.settings.wikiSpaceName) parts.push(sanitize(this.settings.wikiSpaceName));
    return parts.join("/");
  }

  private resolveAttachmentsAbsolutePath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Lark Wiki Sync requires Obsidian desktop (FileSystemAdapter).");
    }
    return `${adapter.getBasePath()}/${this.effectiveRoot()}/${ATTACHMENTS_SUBFOLDER}`;
  }

  /**
   * Read the attachments folder once per sync and build a `token → filename`
   * cache so we don't re-download files we already have. Filenames on disk
   * are `<token>.<ext>` (the token is always the prefix before the dot).
   */
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
          // Obsidian wikilinks resolve by filename globally, so we don't need
          // the _attachments/ prefix here — tokens are unique across the vault.
          map[token] = filename;
        }
      } catch (err) {
        console.warn(`LarkWikiSync: failed to download image ${token}`, err);
      }
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private mapNodeToLocalPath(node: {
    title: string;
    node_token: string;
    obj_type: string;
    parentPath?: string[];
  }): string {
    const sanitize = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_");
    const segments = [
      this.effectiveRoot(),
      ...(node.parentPath ?? []).map(sanitize),
      `${sanitize(node.title)}.md`,
    ];
    return normalizePath(segments.join("/"));
  }

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
          // race: another op may have created it in parallel; re-check
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
    prev: FileSyncState,
  ): Promise<void> {
    // v0.1 policy implementations
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
        // TODO: open a three-way diff modal. For now, write a .conflict marker file
        // so user doesn't lose either side.
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
