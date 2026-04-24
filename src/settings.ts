import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type LarkWikiSyncPlugin from "../main";
import { SetupWizardModal } from "./ui/SetupWizardModal";

export type SyncDirection = "pull" | "push" | "bidirectional";

export interface LarkWikiSyncSettings {
  /** Has the user completed the setup wizard? */
  configured: boolean;

  /** Path to lark-cli binary (resolved from PATH if blank). */
  larkCliPath: string;

  /** Identity used for lark-cli: "user" (default) | "bot". */
  larkIdentity: "user" | "bot";

  /** Lark Wiki space ID to sync with. */
  wikiSpaceId: string;

  /** Human-readable space name — used as the first subfolder under localRoot
   * so each synced space gets its own self-contained folder. */
  wikiSpaceName: string;

  /** Optional: node token inside the space to scope the sync root. Empty = whole space. */
  wikiRootNode: string;

  /** Local folder (vault-relative) — parent for all synced wiki spaces.
   * Files land in `${localRoot}/${wikiSpaceName}/...`. */
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
  wikiSpaceId: "",
  wikiSpaceName: "",
  wikiRootNode: "",
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
        "Two-way sync between this vault and a Lark Wiki space. Uses lark-cli as the transport layer. " +
        "Run the setup wizard first to authorize and pick your space/root.",
    });

    new Setting(containerEl)
      .setName("Setup wizard")
      .setDesc("Authorize lark-cli, pick a Wiki space + root node, configure local root folder.")
      .addButton((btn) =>
        btn
          .setButtonText(this.plugin.settings.configured ? "Re-run wizard" : "Run setup wizard")
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

    new Setting(containerEl).setName("Sync scope").setHeading();

    new Setting(containerEl)
      .setName("Wiki space ID")
      .setDesc("Target Lark Wiki space. Set via the setup wizard.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.wikiSpaceId)
          .setDisabled(true),
      );

    new Setting(containerEl)
      .setName("Wiki root node (optional)")
      .setDesc("Scope the sync to a subtree. Leave blank to sync the whole space.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.wikiRootNode)
          .onChange(async (v) => {
            this.plugin.settings.wikiRootNode = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Local root folder")
      .setDesc("Vault-relative folder that mirrors the wiki.")
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
      .setDesc("Clear cached hashes/timestamps. Next sync will treat all files as new.")
      .addButton((btn) =>
        btn.setButtonText("Reset").setWarning().onClick(async () => {
          await this.plugin.state.reset();
          new Notice("Lark Wiki Sync — sync state reset.");
        }),
      );
  }
}
