import { Plugin, Notice } from "obsidian";
import { LarkWikiSyncSettings, DEFAULT_SETTINGS, LarkWikiSyncSettingTab } from "./src/settings";
import { SetupWizardModal } from "./src/ui/SetupWizardModal";
import { SyncEngine } from "./src/sync/SyncEngine";
import { LarkCli } from "./src/lark/LarkCli";
import { StateStore } from "./src/state/StateStore";

// Obsidian ships with Lucide icons; "sync" renders as the two-arrow cycle.
const RIBBON_ICON_ID = "sync";

export default class LarkWikiSyncPlugin extends Plugin {
  settings!: LarkWikiSyncSettings;
  lark!: LarkCli;
  state!: StateStore;
  syncEngine!: SyncEngine;

  async onload() {
    await this.loadSettings();

    this.lark = new LarkCli(this.settings);
    this.state = new StateStore(this.app, this.manifest.id);
    await this.state.load();
    this.syncEngine = new SyncEngine(this.app, this.settings, this.lark, this.state);

    this.addRibbonIcon(RIBBON_ICON_ID, "Lark Wiki Sync", async () => {
      if (!this.settings.configured) {
        new SetupWizardModal(this.app, this).open();
        return;
      }
      await this.runSync();
    });

    this.addCommand({
      id: "lark-wiki-sync-now",
      name: "Sync with Lark Wiki now",
      callback: async () => {
        if (!this.settings.configured) {
          new Notice("Lark Wiki Sync not configured yet. Open settings to run setup.");
          new SetupWizardModal(this.app, this).open();
          return;
        }
        await this.runSync();
      },
    });

    this.addCommand({
      id: "lark-wiki-sync-setup",
      name: "Run setup wizard",
      callback: () => new SetupWizardModal(this.app, this).open(),
    });

    this.addCommand({
      id: "lark-wiki-sync-dry-run",
      name: "Preview changes (dry run)",
      callback: async () => {
        if (!this.settings.configured) {
          new Notice("Setup required first.");
          return;
        }
        await this.runSync(true);
      },
    });

    this.addSettingTab(new LarkWikiSyncSettingTab(this.app, this));
  }

  onunload() {}

  async runSync(dryRun = false) {
    const startNotice = new Notice(
      dryRun ? "Lark Wiki Sync — dry run…" : "Lark Wiki Sync — syncing…",
      0,
    );
    try {
      const result = await this.syncEngine.run({ dryRun });
      startNotice.hide();
      new Notice(
        `Lark Wiki Sync ${dryRun ? "(dry run) " : ""}done — ` +
          `pulled ${result.pulled}, pushed ${result.pushed}, conflicts ${result.conflicts}`,
      );
    } catch (err) {
      startNotice.hide();
      console.error(err);
      new Notice(`Lark Wiki Sync failed: ${(err as Error).message}`, 7000);
    }
  }

  async loadSettings() {
    const raw = (await this.loadData()) as Record<string, unknown> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});

    // Migration: pre-0.0.10 stored a single space inline as wikiSpaceId /
    // wikiSpaceName / wikiRootNode. Hoist it into spaces[] and drop the
    // legacy keys so the schema stays clean.
    const legacyId = raw?.wikiSpaceId as string | undefined;
    const hasNoSpaces = !this.settings.spaces || this.settings.spaces.length === 0;
    if (legacyId && hasNoSpaces) {
      this.settings.spaces = [
        {
          spaceId: legacyId,
          spaceName: (raw?.wikiSpaceName as string | undefined) ?? "",
          rootNode: (raw?.wikiRootNode as string | undefined) ?? "",
        },
      ];
      const bag = this.settings as unknown as Record<string, unknown>;
      delete bag.wikiSpaceId;
      delete bag.wikiSpaceName;
      delete bag.wikiRootNode;
      await this.saveData(this.settings);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.lark.updateSettings(this.settings);
  }
}
