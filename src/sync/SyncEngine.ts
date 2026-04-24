import { App, normalizePath, TFile } from "obsidian";
import type { LarkWikiSyncSettings } from "../settings";
import type { LarkCli } from "../lark/LarkCli";
import type { StateStore, FileSyncState } from "../state/StateStore";
import { hashString } from "../util/hash";

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

    const nodes = await this.lark.listNodes(
      this.settings.wikiSpaceId,
      this.settings.wikiRootNode || undefined,
    );

    for (const node of nodes) {
      if (node.obj_type !== "docx") continue; // v0.1 only handles docx nodes

      const localPath = this.mapNodeToLocalPath(node);
      const existing = this.state.get(localPath);

      try {
        const remoteMd = await this.lark.fetchDoc(node.obj_token);
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
  // Helpers
  // ---------------------------------------------------------------------------

  private mapNodeToLocalPath(node: {
    title: string;
    node_token: string;
    obj_type: string;
  }): string {
    const safeTitle = node.title.replace(/[\\/:*?"<>|]/g, "_");
    return normalizePath(`${this.settings.localRoot}/${safeTitle}.md`);
  }

  private async writeLocal(path: string, content: string): Promise<void> {
    const folder = path.substring(0, path.lastIndexOf("/"));
    if (folder && !(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.createFolder(folder);
    }
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(path, content);
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
