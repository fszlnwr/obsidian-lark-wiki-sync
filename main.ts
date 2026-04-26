import { Plugin, Notice } from "obsidian";
import { LarkWikiSyncSettings, DEFAULT_SETTINGS, LarkWikiSyncSettingTab } from "./src/settings";
import { SetupWizardModal } from "./src/ui/SetupWizardModal";
import { presentSyncPlan } from "./src/ui/SyncPlanModal";
import { SyncResultsModal } from "./src/ui/SyncResultsModal";
import { SyncEngine, ProgressEvent } from "./src/sync/SyncEngine";
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

  async runSync(dryRun = false, onlySpaceId?: string) {
    const progressNotice = new Notice(
      dryRun ? "Lark Wiki Sync — dry run…" : "Lark Wiki Sync — syncing…",
      0,
    );

    const onProgress = (e: ProgressEvent) => {
      const text = renderProgress(e);
      // Obsidian's Notice has setMessage on recent versions; fall back to noticeEl text manipulation.
      const anyNotice = progressNotice as unknown as { setMessage?: (s: string) => void };
      if (typeof anyNotice.setMessage === "function") {
        anyNotice.setMessage(text);
      } else {
        progressNotice.noticeEl?.setText(text);
      }
    };

    try {
      const result = await this.syncEngine.run({
        dryRun,
        onlySpaceId,
        onProgress,
        confirmPlan:
          !dryRun && this.settings.confirmBeforeSync
            ? (plan) => presentSyncPlan(this.app, plan)
            : undefined,
      });
      progressNotice.hide();
      const reconciledNote = result.reconciled > 0 ? `, reconciled ${result.reconciled}` : "";
      const errorNote = result.errors.length > 0 ? `, ${result.errors.length} error(s)` : "";
      new Notice(
        `Lark Wiki Sync ${dryRun ? "(dry run) " : ""}done — ` +
          `pulled ${result.pulled}, pushed ${result.pushed}, conflicts ${result.conflicts}` +
          reconciledNote +
          errorNote,
        result.errors.length > 0 ? 8000 : undefined,
      );
      if (result.errors.length > 0) {
        new SyncResultsModal(this.app, result).open();
      }
    } catch (err) {
      progressNotice.hide();
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

    // Migration: rename confirmBeforePush → confirmBeforeSync.
    const legacyConfirm = raw?.confirmBeforePush;
    if (typeof legacyConfirm === "boolean" && raw && !("confirmBeforeSync" in raw)) {
      this.settings.confirmBeforeSync = legacyConfirm;
      const bag = this.settings as unknown as Record<string, unknown>;
      delete bag.confirmBeforePush;
      await this.saveData(this.settings);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.lark.updateSettings(this.settings);
  }
}

function renderProgress(e: ProgressEvent): string {
  const head = `Lark Wiki Sync — ${e.spaceName}`;
  const counter = e.total ? ` ${e.current ?? 0}/${e.total}` : "";
  switch (e.phase) {
    case "list":
      return `${head}: listing nodes…`;
    case "classify":
      return `${head}: scanning${counter}${e.label ? ` · ${truncate(e.label, 60)}` : ""}`;
    case "pull":
      return `${head}: ↓ pulling${counter}${e.label ? ` · ${truncate(e.label, 60)}` : ""}`;
    case "push":
      return `${head}: ↑ pushing${counter}${e.label ? ` · ${truncate(e.label, 60)}` : ""}`;
    case "conflict":
      return `${head}: ⚠ conflict${counter}${e.label ? ` · ${truncate(e.label, 60)}` : ""}`;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
