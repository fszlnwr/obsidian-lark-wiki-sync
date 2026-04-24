import { Plugin, Notice, addIcon } from "obsidian";
import { LarkWikiSyncSettings, DEFAULT_SETTINGS, LarkWikiSyncSettingTab } from "./src/settings";
import { SetupWizardModal } from "./src/ui/SetupWizardModal";
import { SyncEngine } from "./src/sync/SyncEngine";
import { LarkCli } from "./src/lark/LarkCli";
import { StateStore } from "./src/state/StateStore";

const RIBBON_ICON_ID = "lark-wiki-sync-icon";
const RIBBON_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-9 9m0 0a9 9 0 0 1-9-9m9 9V3m0 0a9 9 0 0 1 9 9m-9-9a9 9 0 0 0-9 9"/></svg>`;

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

    addIcon(RIBBON_ICON_ID, RIBBON_ICON_SVG);

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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.lark.updateSettings(this.settings);
  }
}
