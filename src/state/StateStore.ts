import { App, normalizePath } from "obsidian";

/**
 * Per-file sync state. Used to detect three-way diffs:
 *
 *   common ancestor = lastSyncedHash
 *   local           = current vault file hash
 *   remote          = current Lark Doc hash
 */
export interface FileSyncState {
  /** Vault-relative path. */
  localPath: string;

  /** Lark wiki node token. */
  nodeToken: string;

  /** Lark doc token (the actual editable doc the wiki node points to). */
  docToken: string;

  /** Hash of the content at last successful sync. */
  lastSyncedHash: string;

  /** ISO timestamp of last successful sync for this file. */
  lastSyncedAt: string;
}

export interface StateShape {
  files: Record<string, FileSyncState>; // keyed by localPath
}

const DEFAULT_STATE: StateShape = { files: {} };

/**
 * Stores per-file sync metadata in the plugin's data directory.
 * Lives at `.obsidian/plugins/<id>/sync-state.json`.
 */
export class StateStore {
  private state: StateShape = DEFAULT_STATE;

  constructor(private app: App, private pluginId: string) {}

  private get path(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${this.pluginId}/sync-state.json`);
  }

  async load(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(this.path))) {
        this.state = structuredClone(DEFAULT_STATE);
        return;
      }
      const raw = await adapter.read(this.path);
      this.state = JSON.parse(raw) as StateShape;
    } catch (err) {
      console.warn("LarkWikiSync: failed to load sync state, starting fresh.", err);
      this.state = structuredClone(DEFAULT_STATE);
    }
  }

  async save(): Promise<void> {
    const adapter = this.app.vault.adapter;
    await adapter.write(this.path, JSON.stringify(this.state, null, 2));
  }

  get(localPath: string): FileSyncState | undefined {
    return this.state.files[localPath];
  }

  upsert(entry: FileSyncState): void {
    this.state.files[entry.localPath] = entry;
  }

  remove(localPath: string): void {
    delete this.state.files[localPath];
  }

  all(): FileSyncState[] {
    return Object.values(this.state.files);
  }

  async reset(): Promise<void> {
    this.state = structuredClone(DEFAULT_STATE);
    await this.save();
  }
}
