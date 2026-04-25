import { App, FileSystemAdapter, normalizePath, TFile } from "obsidian";
import type { LarkWikiSyncSettings, WikiSpaceConfig } from "../settings";
import type { LarkCli } from "../lark/LarkCli";
import type { StateStore, FileSyncState } from "../state/StateStore";
import { hashString } from "../util/hash";
import { extractImageTokens, larkToObsidianMarkdown } from "../util/larkToObsidianMd";

const ATTACHMENTS_SUBFOLDER = "_attachments";

export interface SyncError {
  phase: "pull" | "push" | "conflict" | "fetch" | "plan";
  file: string;
  message: string;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  skipped: number;
  reconciled: number;
  errors: SyncError[];
}

/** Items intended for execution after planning. */
export interface PendingPull {
  space: WikiSpaceConfig;
  node: { node_token: string; obj_token: string; title: string };
  localPath: string;
  remoteMd: string;
  remoteHash: string;
}

export interface PendingPush {
  space: WikiSpaceConfig;
  node: { node_token: string; obj_token: string; title: string };
  localPath: string;
  localMd: string;
  localHash: string;
}

export interface PendingConflict {
  space: WikiSpaceConfig;
  node: { node_token: string; obj_token: string; title: string };
  localPath: string;
  localMd: string;
  remoteMd: string;
  prev: FileSyncState;
}

/** Reconcile = "we have a local file matching remote exactly but no state — adopt it." */
export interface PendingReconcile {
  space: WikiSpaceConfig;
  node: { node_token: string; obj_token: string };
  localPath: string;
  hash: string;
}

export interface SyncPlan {
  pulls: PendingPull[];
  pushes: PendingPush[];
  conflicts: PendingConflict[];
  reconciles: PendingReconcile[];
  skipped: number;
}

export interface RunOptions {
  dryRun?: boolean;
  /**
   * If returned promise resolves false, queued pushes are skipped (the rest of
   * the plan still applies). If undefined, no confirmation is asked.
   */
  confirmPushes?: (pushes: PendingPush[]) => Promise<boolean>;
}

export class SyncEngine {
  constructor(
    private app: App,
    private settings: LarkWikiSyncSettings,
    private lark: LarkCli,
    private state: StateStore,
  ) {}

  // ---------------------------------------------------------------------------
  // Top-level entry
  // ---------------------------------------------------------------------------

  async run(opts: RunOptions = {}): Promise<SyncResult> {
    const plan = await this.plan();

    if (opts.confirmPushes && plan.pushes.length > 0) {
      const ok = await opts.confirmPushes(plan.pushes);
      if (!ok) plan.pushes = [];
    }

    if (opts.dryRun) {
      return {
        pulled: plan.pulls.length,
        pushed: plan.pushes.length,
        conflicts: plan.conflicts.length,
        skipped: plan.skipped,
        reconciled: plan.reconciles.length,
        errors: [],
      };
    }

    return this.apply(plan);
  }

  /**
   * Walk every configured space, classify every node, and return a plan
   * without writing anything anywhere. Network reads (list + fetch +
   * download attachments) DO happen here — only mutations are deferred.
   */
  async plan(): Promise<SyncPlan> {
    const plan: SyncPlan = {
      pulls: [],
      pushes: [],
      conflicts: [],
      reconciles: [],
      skipped: 0,
    };

    const spaces = this.settings.spaces ?? [];
    if (spaces.length === 0) {
      throw new Error("No wiki spaces configured. Open settings to add one.");
    }

    for (const space of spaces) {
      try {
        await this.planOneSpace(space, plan);
      } catch (err) {
        console.error(
          `LarkWikiSync: planning failed for "${space.spaceName || space.spaceId}":`,
          err,
        );
        throw err; // bubble up so the user sees a Notice
      }
    }
    return plan;
  }

  /** Execute a (possibly user-edited) plan. */
  async apply(plan: SyncPlan): Promise<SyncResult> {
    const result: SyncResult = {
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      skipped: plan.skipped,
      reconciled: 0,
      errors: [],
    };

    for (const r of plan.reconciles) {
      this.recordSync(r.localPath, r.node.node_token, r.node.obj_token, r.hash);
      result.reconciled++;
    }

    for (const p of plan.pulls) {
      try {
        await this.writeLocal(p.localPath, p.remoteMd);
        this.recordSync(p.localPath, p.node.node_token, p.node.obj_token, p.remoteHash);
        result.pulled++;
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        console.error(`LarkWikiSync: pull failed for ${p.localPath}:`, err);
        result.errors.push({ phase: "pull", file: p.localPath, message });
      }
    }

    for (const p of plan.pushes) {
      try {
        await this.lark.updateDoc(p.node.obj_token, p.localMd, "replace_all");
        this.recordSync(p.localPath, p.node.node_token, p.node.obj_token, p.localHash);
        result.pushed++;
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        console.error(`LarkWikiSync: push failed for ${p.localPath}:`, err);
        result.errors.push({ phase: "push", file: p.localPath, message });
      }
    }

    for (const c of plan.conflicts) {
      try {
        await this.handleConflict(c);
        result.conflicts++;
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        console.error(`LarkWikiSync: conflict handling failed for ${c.localPath}:`, err);
        result.errors.push({ phase: "conflict", file: c.localPath, message });
      }
    }

    this.settings.lastSyncedAt = new Date().toISOString();
    await this.state.save();

    return result;
  }

  // ---------------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------------

  private async planOneSpace(space: WikiSpaceConfig, plan: SyncPlan): Promise<void> {
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
      const existing = this.state.get(node.node_token);

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

        // No prior state — this is a first-sync discovery for this node.
        if (!existing) {
          if (!localFile) {
            // New pull.
            plan.pulls.push({ space, node, localPath, remoteMd, remoteHash });
            continue;
          }
          if (localHash === remoteHash) {
            // Local file matches remote exactly: silently adopt it.
            plan.reconciles.push({
              space,
              node: { node_token: node.node_token, obj_token: node.obj_token },
              localPath,
              hash: remoteHash,
            });
            continue;
          }
          // Local file exists with different content — genuine collision.
          plan.conflicts.push({
            space,
            node,
            localPath,
            localMd: localMd!,
            remoteMd,
            prev: {
              localPath,
              nodeToken: node.node_token,
              docToken: node.obj_token,
              lastSyncedHash: "",
              lastSyncedAt: "",
            },
          });
          continue;
        }

        const base = existing.lastSyncedHash;
        const localChanged = localHash !== null && localHash !== base;
        const remoteChanged = remoteHash !== base;

        if (!localChanged && !remoteChanged) {
          plan.skipped++;
          continue;
        }

        if (remoteChanged && !localChanged) {
          plan.pulls.push({ space, node, localPath, remoteMd, remoteHash });
          continue;
        }

        if (!remoteChanged && localChanged) {
          if (this.settings.direction === "pull") {
            plan.skipped++;
            continue;
          }
          plan.pushes.push({
            space,
            node,
            localPath,
            localMd: localMd!,
            localHash: localHash!,
          });
          continue;
        }

        plan.conflicts.push({
          space,
          node,
          localPath,
          localMd: localMd!,
          remoteMd,
          prev: existing,
        });
      } catch (err) {
        console.error(`LarkWikiSync: classify failed on ${localPath}`, err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Per-space path helpers
  // ---------------------------------------------------------------------------

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

  private async handleConflict(c: PendingConflict): Promise<void> {
    switch (this.settings.conflictPolicy) {
      case "prefer-local": {
        await this.lark.updateDoc(c.node.obj_token, c.localMd, "replace_all");
        this.recordSync(c.localPath, c.node.node_token, c.node.obj_token, hashString(c.localMd));
        return;
      }
      case "prefer-remote": {
        await this.writeLocal(c.localPath, c.remoteMd);
        this.recordSync(c.localPath, c.node.node_token, c.node.obj_token, hashString(c.remoteMd));
        return;
      }
      case "ask":
      default: {
        // TODO(v0.2): three-way diff modal. Until then, write a sidecar so
        // neither side is destroyed.
        const conflictPath = `${c.localPath}.remote.conflict.md`;
        await this.writeLocal(conflictPath, c.remoteMd);
        console.warn(
          `LarkWikiSync: conflict on ${c.localPath}. Remote saved to ${conflictPath}; manual merge required.`,
        );
        return;
      }
    }
  }
}
