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

  /** ISO timestamp of last successful sync for this specific space. */
  lastSyncedAt?: string;
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

  /** When true, every sync pauses with a plan modal showing pulls / pushes
   * / conflicts before any of them is applied. */
  confirmBeforeSync: boolean;

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
  confirmBeforeSync: true,
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
        const folder = `${this.plugin.settings.localRoot}/${space.spaceName || space.spaceId}`;
        const fileCount = this.plugin.state
          .all()
          .filter((s) => s.localPath.startsWith(`${folder}/`)).length;
        const lastSyncLabel = space.lastSyncedAt
          ? `last sync ${formatRelative(space.lastSyncedAt)}`
          : "never synced";
        const scopeLabel = space.rootNode ? "subtree" : "whole space";

        new Setting(containerEl)
          .setName(space.spaceName || space.spaceId)
          .setDesc(`${fileCount} file${fileCount === 1 ? "" : "s"} · ${scopeLabel} · ${lastSyncLabel} · ${folder}/`)
          .addButton((btn) =>
            btn.setButtonText("Sync just this").onClick(() => {
              this.plugin.runSync(false, space.spaceId);
            }),
          )
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
      .setName("Confirm before sync")
      .setDesc("Pause and show a plan modal listing pulls / pushes / conflicts before any of them is applied.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.confirmBeforeSync).onChange(async (v) => {
          this.plugin.settings.confirmBeforeSync = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Auto-sync interval")
      .setDesc("Minutes between automatic background syncs. Set to 0 for manual only. Auto-sync uses the same plan modal if Confirm is on.")
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

    new Setting(containerEl)
      .setName("Ignore patterns")
      .setDesc("One glob per line. Files whose vault-relative path matches any pattern are skipped on every sync. `*` = anything except `/`, `**` = anything (incl. `/`). Examples: `📥 Lark/**/Drafts/**`, `**/*.tmp.md`.")
      .addTextArea((t) => {
        t.setPlaceholder("📥 Lark/**/Drafts/**\n**/*.tmp.md")
          .setValue(this.plugin.settings.ignorePatterns.join("\n"))
          .onChange(async (v) => {
            this.plugin.settings.ignorePatterns = v
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0 && !line.startsWith("#"));
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 4;
        t.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Per-file opt-out")
      .setDesc("Add `lark_sync: false` to a file's frontmatter to skip just that file on every sync, without removing it from either side. Useful for drafts you don't want pushed yet.");

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

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
