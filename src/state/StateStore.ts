import { App, normalizePath } from "obsidian";

/**
 * Per-file sync state. Used for the 3-way diff classification:
 *
 *   common ancestor = lastSyncedHash
 *   local           = current vault file hash
 *   remote          = current Lark doc hash (after Lark→Obsidian transform)
 *
 * Keyed by Lark `nodeToken` so the state survives changes in local path
 * mapping (e.g. renaming `localRoot`, switching to per-space subfolders).
 * `localPath` is recorded but only used for cleanup / logging.
 */
export interface FileSyncState {
  localPath: string;
  nodeToken: string;
  docToken: string;
  lastSyncedHash: string;
  lastSyncedAt: string;
}

export interface StateShape {
  /** Keyed by `nodeToken`. */
  files: Record<string, FileSyncState>;
  /** Schema version — bumped each time the key/shape changes. */
  schemaVersion: number;
}

const SCHEMA_VERSION = 2;
const DEFAULT_STATE: StateShape = { files: {}, schemaVersion: SCHEMA_VERSION };

export class StateStore {
  private state: StateShape = structuredClone(DEFAULT_STATE);

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
      const parsed = JSON.parse(raw) as Partial<StateShape> & {
        files?: Record<string, FileSyncState>;
      };
      this.state = this.migrate(parsed);
    } catch (err) {
      console.warn("LarkWikiSync: failed to load sync state, starting fresh.", err);
      this.state = structuredClone(DEFAULT_STATE);
    }
  }

  /**
   * Pre-0.0.11 state was keyed by `localPath`. Re-key by `nodeToken` so the
   * state survives path-mapping changes. Each entry already carries
   * `nodeToken` inline so this is a pure rekeying — no data is lost.
   */
  private migrate(raw: { files?: Record<string, FileSyncState>; schemaVersion?: number }): StateShape {
    if (raw?.schemaVersion === SCHEMA_VERSION && raw.files) {
      return { files: raw.files, schemaVersion: SCHEMA_VERSION };
    }
    const files: Record<string, FileSyncState> = {};
    for (const entry of Object.values(raw?.files ?? {})) {
      if (!entry?.nodeToken) continue; // unsalvageable
      files[entry.nodeToken] = entry;
    }
    const migratedCount = Object.keys(files).length;
    const droppedCount = Object.keys(raw?.files ?? {}).length - migratedCount;
    if (droppedCount > 0) {
      console.warn(
        `LarkWikiSync: state migration dropped ${droppedCount} unrecognised entries.`,
      );
    }
    console.info(`LarkWikiSync: state migrated to schema v${SCHEMA_VERSION} (${migratedCount} entries).`);
    return { files, schemaVersion: SCHEMA_VERSION };
  }

  async save(): Promise<void> {
    const adapter = this.app.vault.adapter;
    await adapter.write(this.path, JSON.stringify(this.state, null, 2));
  }

  get(nodeToken: string): FileSyncState | undefined {
    return this.state.files[nodeToken];
  }

  upsert(entry: FileSyncState): void {
    this.state.files[entry.nodeToken] = entry;
  }

  remove(nodeToken: string): void {
    delete this.state.files[nodeToken];
  }

  all(): FileSyncState[] {
    return Object.values(this.state.files);
  }

  async reset(): Promise<void> {
    this.state = structuredClone(DEFAULT_STATE);
    await this.save();
  }
}
