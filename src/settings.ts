import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type LarkWikiSyncPlugin from "../main";
import { SetupWizardModal } from "./ui/SetupWizardModal";

export type SyncDirection = "pull" | "push" | "bidirectional";

export interface WikiSpaceConfig {
  /** Lark Wiki space ID. */
  spaceId: string;

  /** Human-readable space name; used as the first subfolder under localRoot. */
  spaceName: string;

  /** Optional node token to scope the sync. Empty = whole space. */
  rootNode: string;
}

export interface LarkWikiSyncSettings {
  /** Has the user added at least one wiki space? */
  configured: boolean;

  /** Path to lark-cli binary (resolved from PATH if blank). */
  larkCliPath: string;

  /** Identity used for lark-cli: "user" (default) | "bot". */
  larkIdentity: "user" | "bot";

  /** Wiki spaces to sync. Each one lives under `${localRoot}/${spaceName}/...`. */
  spaces: WikiSpaceConfig[];

  /** Local folder (vault-relative) — parent for all synced wiki spaces. */
  localRoot: string;

  /** Sync direction. */
  direction: SyncDirection;

  /** Glob-style ignore patterns (vault-relative). */
  ignorePatterns: string[];

  /** Auto-sync on startup / on interval (minutes). 0 = manual only. */
  autoSyncIntervalMinutes: number;

  /** Conflict default behavior. */
  conflictPolicy: "ask" | "prefer-local" | "prefer-remote";

  /** Last successful sync (ISO). */
  lastSyncedAt: string | null;
}

export const DEFAULT_SETTINGS: LarkWikiSyncSettings = {
  configured: false,
  larkCliPath: "",
  larkIdentity: "user",
  spaces: [],
  localRoot: "📥 Lark",
  direction: "bidirectional",
  ignorePatterns: [".obsidian/**", "**/.DS_Store", "**/node_modules/**"],
  autoSyncIntervalMinutes: 0,
  conflictPolicy: "ask",
  lastSyncedAt: null,
};

export class LarkWikiSyncSettingTab extends PluginSettingTab {
  plugin: LarkWikiSyncPlugin;

  constructor(app: App, plugin: LarkWikiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Lark Wiki Sync" });

    containerEl.createEl("p", {
      text:
        "Two-way sync between this vault and one or more Lark Wiki spaces. " +
        "Add spaces below — each lives in its own subfolder under the local root.",
    });

    new Setting(containerEl).setName("Wiki spaces").setHeading();

    if (this.plugin.settings.spaces.length === 0) {
      containerEl.createEl("p", {
        text: "No spaces configured yet. Click \"Add a wiki space\" to get started.",
        cls: "setting-item-description",
      });
    } else {
      for (let i = 0; i < this.plugin.settings.spaces.length; i++) {
        const space = this.plugin.settings.spaces[i];
        const summary = space.rootNode
          ? `${space.spaceName || space.spaceId} — root node ${space.rootNode}`
          : `${space.spaceName || space.spaceId} — whole space`;
        new Setting(containerEl)
          .setName(summary)
          .setDesc(`Local: ${this.plugin.settings.localRoot}/${space.spaceName || space.spaceId}/`)
          .addButton((btn) =>
            btn
              .setButtonText("Remove")
              .setWarning()
              .onClick(async () => {
                this.plugin.settings.spaces.splice(i, 1);
                if (this.plugin.settings.spaces.length === 0) {
                  this.plugin.settings.configured = false;
                }
                await this.plugin.saveSettings();
                this.display();
              }),
          );
      }
    }

    new Setting(containerEl)
      .setName("Add a wiki space")
      .setDesc("Authorize lark-cli, pick a space, choose an optional root node.")
      .addButton((btn) =>
        btn
          .setButtonText(this.plugin.settings.spaces.length === 0 ? "Run setup wizard" : "Add")
          .setCta()
          .onClick(() => new SetupWizardModal(this.app, this.plugin).open()),
      );

    new Setting(containerEl).setName("Connection").setHeading();

    new Setting(containerEl)
      .setName("lark-cli path")
      .setDesc("Absolute path to the lark-cli binary. Leave blank to use PATH lookup.")
      .addText((t) =>
        t
          .setPlaceholder("/usr/local/bin/lark-cli")
          .setValue(this.plugin.settings.larkCliPath)
          .onChange(async (v) => {
            this.plugin.settings.larkCliPath = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Identity")
      .setDesc("Which lark-cli identity to use for API calls.")
      .addDropdown((d) =>
        d
          .addOption("user", "user (recommended)")
          .addOption("bot", "bot")
          .setValue(this.plugin.settings.larkIdentity)
          .onChange(async (v) => {
            this.plugin.settings.larkIdentity = v as "user" | "bot";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Sync behaviour").setHeading();

    new Setting(containerEl)
      .setName("Local root folder")
      .setDesc("Vault-relative parent folder for all synced wiki spaces.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.localRoot)
          .onChange(async (v) => {
            this.plugin.settings.localRoot = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync direction")
      .addDropdown((d) =>
        d
          .addOption("bidirectional", "Bidirectional (recommended)")
          .addOption("pull", "Pull only (Lark → Obsidian)")
          .addOption("push", "Push only (Obsidian → Lark)")
          .setValue(this.plugin.settings.direction)
          .onChange(async (v) => {
            this.plugin.settings.direction = v as SyncDirection;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Conflict policy")
      .setDesc("What to do when both sides changed since last sync.")
      .addDropdown((d) =>
        d
          .addOption("ask", "Ask (show diff)")
          .addOption("prefer-local", "Prefer local (vault wins)")
          .addOption("prefer-remote", "Prefer remote (wiki wins)")
          .setValue(this.plugin.settings.conflictPolicy)
          .onChange(async (v) => {
            this.plugin.settings.conflictPolicy = v as LarkWikiSyncSettings["conflictPolicy"];
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-sync interval")
      .setDesc("Minutes between automatic syncs. Set to 0 for manual only.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.autoSyncIntervalMinutes))
          .onChange(async (v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) return;
            this.plugin.settings.autoSyncIntervalMinutes = n;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Maintenance").setHeading();

    new Setting(containerEl)
      .setName("Last synced")
      .setDesc(this.plugin.settings.lastSyncedAt ?? "Never");

    new Setting(containerEl)
      .setName("Reset sync state")
      .setDesc("Clear cached hashes/timestamps for all spaces. Next sync will treat every file as new.")
      .addButton((btn) =>
        btn.setButtonText("Reset").setWarning().onClick(async () => {
          await this.plugin.state.reset();
          new Notice("Lark Wiki Sync — sync state reset.");
        }),
      );
  }
}
