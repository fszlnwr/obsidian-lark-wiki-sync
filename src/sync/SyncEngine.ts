import { App, FileSystemAdapter, normalizePath, TFile } from "obsidian";
import type { LarkWikiSyncSettings, WikiSpaceConfig } from "../settings";
import type { LarkCli } from "../lark/LarkCli";
import type { StateStore, FileSyncState } from "../state/StateStore";
import { hashString } from "../util/hash";
import { extractImageTokens, larkToObsidianMarkdown } from "../util/larkToObsidianMd";
import { obsidianToLarkMarkdown } from "../util/obsidianToLarkMd";

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
  /** Markdown as it lives in the vault (Obsidian-form). Hashed for state. */
  localMd: string;
  /** Markdown rewritten to Lark-flavor (pipe tables → <lark-table>, etc.). Sent to lark-cli. */
  pushMd: string;
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

export type PlanDecision = "applyAll" | "pullsOnly" | "cancel";

export interface ProgressEvent {
  phase: "list" | "classify" | "pull" | "push" | "conflict";
  spaceName: string;
  /** Items processed in the current phase. */
  current?: number;
  /** Total items expected in the current phase, if known. */
  total?: number;
  /** Optional file path or label for the item being processed. */
  label?: string;
}

export interface RunOptions {
  dryRun?: boolean;
  /**
   * Called once after `plan()` returns so the UI can show a preview of what
   * will be done. The callback returns one of three actions:
   *   - "applyAll":   apply every pull, push, conflict, and reconcile.
   *   - "pullsOnly":  apply pulls + reconciles + conflicts; skip pushes.
   *   - "cancel":     do nothing.
   * If undefined, behaviour is "applyAll".
   */
  confirmPlan?: (plan: SyncPlan) => Promise<PlanDecision>;
  /** Called as the engine progresses through phases. Best-effort, not exact. */
  onProgress?: (e: ProgressEvent) => void;
  /** Limit sync to a single space (matched by spaceId). */
  onlySpaceId?: string;
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
    const plan = await this.plan(opts);

    if (opts.confirmPlan) {
      const decision = await opts.confirmPlan(plan);
      if (decision === "cancel") {
        return emptyResult();
      }
      if (decision === "pullsOnly") {
        plan.pushes = [];
      }
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

    return this.apply(plan, opts);
  }

  /**
   * Walk every configured space, classify every node, and return a plan
   * without writing anything anywhere. Network reads (list + fetch +
   * download attachments) DO happen here — only mutations are deferred.
   */
  async plan(opts: RunOptions = {}): Promise<SyncPlan> {
    const plan: SyncPlan = {
      pulls: [],
      pushes: [],
      conflicts: [],
      reconciles: [],
      skipped: 0,
    };

    let spaces = this.settings.spaces ?? [];
    if (opts.onlySpaceId) {
      spaces = spaces.filter((s) => s.spaceId === opts.onlySpaceId);
    }
    if (spaces.length === 0) {
      throw new Error("No wiki spaces configured. Open settings to add one.");
    }

    for (const space of spaces) {
      try {
        await this.planOneSpace(space, plan, opts);
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
  async apply(plan: SyncPlan, opts: RunOptions = {}): Promise<SyncResult> {
    const emit = (e: ProgressEvent) => opts.onProgress?.(e);
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

    for (let i = 0; i < plan.pulls.length; i++) {
      const p = plan.pulls[i];
      emit({
        phase: "pull",
        spaceName: p.space.spaceName || p.space.spaceId,
        current: i + 1,
        total: plan.pulls.length,
        label: p.node.title,
      });
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

    for (let i = 0; i < plan.pushes.length; i++) {
      const p = plan.pushes[i];
      emit({
        phase: "push",
        spaceName: p.space.spaceName || p.space.spaceId,
        current: i + 1,
        total: plan.pushes.length,
        label: p.node.title,
      });
      try {
        await this.lark.updateDoc(p.node.obj_token, p.pushMd, "overwrite");
        // Hash the obsidian-form, not the lark-form — that's what the next
        // pull will see after we re-transform Lark's stored content.
        this.recordSync(p.localPath, p.node.node_token, p.node.obj_token, p.localHash);
        result.pushed++;
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        console.error(`LarkWikiSync: push failed for ${p.localPath}:`, err);
        result.errors.push({ phase: "push", file: p.localPath, message });
      }
    }

    for (let i = 0; i < plan.conflicts.length; i++) {
      const c = plan.conflicts[i];
      emit({
        phase: "conflict",
        spaceName: c.space.spaceName || c.space.spaceId,
        current: i + 1,
        total: plan.conflicts.length,
        label: c.node.title,
      });
      try {
        await this.handleConflict(c);
        result.conflicts++;
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        console.error(`LarkWikiSync: conflict handling failed for ${c.localPath}:`, err);
        result.errors.push({ phase: "conflict", file: c.localPath, message });
      }
    }

    const now = new Date().toISOString();
    this.settings.lastSyncedAt = now;

    // Stamp per-space lastSyncedAt for any space that had any executed action.
    const touched = new Set<string>();
    for (const p of plan.pulls) touched.add(p.space.spaceId);
    for (const p of plan.pushes) touched.add(p.space.spaceId);
    for (const c of plan.conflicts) touched.add(c.space.spaceId);
    for (const r of plan.reconciles) touched.add(r.space.spaceId);
    for (const space of this.settings.spaces) {
      if (touched.has(space.spaceId)) space.lastSyncedAt = now;
    }

    await this.state.save();

    return result;
  }

  // ---------------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------------

  private async planOneSpace(
    space: WikiSpaceConfig,
    plan: SyncPlan,
    opts: RunOptions = {},
  ): Promise<void> {
    const emit = (e: ProgressEvent) => opts.onProgress?.(e);
    const spaceLabel = space.spaceName || space.spaceId;

    emit({ phase: "list", spaceName: spaceLabel });
    const nodes = await this.lark.listAllDescendants(
      space.spaceId,
      space.rootNode || undefined,
    );

    const effectiveRoot = this.effectiveRoot(space);
    const attachmentsRel = `${effectiveRoot}/${ATTACHMENTS_SUBFOLDER}`;
    const attachmentsAbs = this.resolveAttachmentsAbsolutePath(space);
    const existingAttachments = await this.scanAttachmentsCache(attachmentsRel);

    let classified = 0;
    const totalDocx = nodes.filter((n) => n.obj_type === "docx").length;

    for (const node of nodes) {
      if (node.obj_type !== "docx") continue;

      classified++;
      emit({
        phase: "classify",
        spaceName: spaceLabel,
        current: classified,
        total: totalDocx,
        label: node.title,
      });

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
          const knownImages = new Set(Object.values(existingAttachments));
          const pushMd = obsidianToLarkMarkdown(localMd!, {
            knownImageFilenames: knownImages,
          });
          plan.pushes.push({
            space,
            node,
            localPath,
            localMd: localMd!,
            pushMd,
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
        // No attachments cache here; pass an empty set so only token-shaped
        // image embeds are rewritten.
        const pushMd = obsidianToLarkMarkdown(c.localMd, { knownImageFilenames: new Set() });
        await this.lark.updateDoc(c.node.obj_token, pushMd, "overwrite");
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

function emptyResult(): SyncResult {
  return { pulled: 0, pushed: 0, conflicts: 0, skipped: 0, reconciled: 0, errors: [] };
}
