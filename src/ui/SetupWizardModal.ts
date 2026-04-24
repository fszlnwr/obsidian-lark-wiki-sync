import { App, Modal, Setting, Notice, DropdownComponent } from "obsidian";
import type LarkWikiSyncPlugin from "../../main";
import { parseWikiUrl } from "../util/parseWikiUrl";

type WizardStep = "intro" | "auth" | "space" | "root" | "local" | "confirm";

/**
 * Multi-step setup wizard for first-time configuration.
 *
 *   intro   — explain what will happen
 *   auth    — verify lark-cli is reachable + identity known
 *   space   — pick wiki space (dropdown fed from lark-cli wiki spaces list)
 *   root    — pick root node inside the space (tree, v0.1 = free-text token)
 *   local   — choose vault-relative folder
 *   confirm — summary + save
 */
export class SetupWizardModal extends Modal {
  private step: WizardStep = "intro";
  private spaces: Array<{ space_id: string; name: string }> = [];
  private sourceMode: "dropdown" | "url" = "dropdown";
  private urlInput = "";
  private urlStatus: { kind: "ok" | "err"; message: string } | null = null;
  private urlResolved = false;

  private draft = {
    larkCliPath: "",
    wikiSpaceId: "",
    wikiSpaceName: "",
    wikiRootNode: "",
    localRoot: "📥 Lark",
  };

  constructor(app: App, private plugin: LarkWikiSyncPlugin) {
    super(app);
    this.draft.larkCliPath = plugin.settings.larkCliPath;
    this.draft.wikiSpaceId = plugin.settings.wikiSpaceId;
    this.draft.wikiSpaceName = plugin.settings.wikiSpaceName;
    this.draft.wikiRootNode = plugin.settings.wikiRootNode;
    this.draft.localRoot = plugin.settings.localRoot;
  }

  onOpen() {
    this.contentEl.addClass("lark-wiki-sync-wizard");
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Lark Wiki Sync — Setup" });
    contentEl.createEl("p", { text: `Step: ${this.stepLabel()}`, cls: "setting-item-description" });

    switch (this.step) {
      case "intro":
        return this.renderIntro();
      case "auth":
        return this.renderAuth();
      case "space":
        return this.renderSpace();
      case "root":
        return this.renderRoot();
      case "local":
        return this.renderLocal();
      case "confirm":
        return this.renderConfirm();
    }
  }

  private stepLabel(): string {
    const order: WizardStep[] = ["intro", "auth", "space", "root", "local", "confirm"];
    return `${order.indexOf(this.step) + 1} of ${order.length}`;
  }

  // ---- Steps ---------------------------------------------------------------

  private renderIntro() {
    this.contentEl.createEl("p", {
      text:
        "This wizard will: (1) verify lark-cli is installed & authorized, " +
        "(2) pick a Lark Wiki space + optional root, " +
        "(3) pick the local vault folder that mirrors it, and (4) save the config.",
    });
    this.addNavButtons({ next: () => (this.step = "auth") });
  }

  private async renderAuth() {
    new Setting(this.contentEl)
      .setName("lark-cli path")
      .setDesc("Absolute path to the binary, or leave blank to use your shell PATH.")
      .addText((t) =>
        t
          .setPlaceholder("/usr/local/bin/lark-cli")
          .setValue(this.draft.larkCliPath)
          .onChange((v) => (this.draft.larkCliPath = v.trim())),
      );

    new Setting(this.contentEl)
      .setName("Verify connection")
      .addButton((btn) =>
        btn.setButtonText("Run lark-cli contact +me").onClick(async () => {
          try {
            await this.savePartial();
            const me = await this.plugin.lark.whoAmI();
            if (me) {
              new Notice(`Connected as ${me.name ?? me.user_id ?? "unknown"}`);
            } else {
              new Notice("Connected, but no identity returned.");
            }
          } catch (err) {
            new Notice(`Failed: ${(err as Error).message}`, 8000);
          }
        }),
      );

    this.addNavButtons({
      back: () => (this.step = "intro"),
      next: () => (this.step = "space"),
    });
  }

  private async renderSpace() {
    this.contentEl.createEl("p", {
      text: "Pick a Wiki space from the dropdown, or paste a link to a Wiki node.",
    });

    new Setting(this.contentEl)
      .setName("Source")
      .addDropdown((d) =>
        d
          .addOption("dropdown", "Pick a space")
          .addOption("url", "Paste a link")
          .setValue(this.sourceMode)
          .onChange((v) => {
            this.sourceMode = v as "dropdown" | "url";
            this.urlStatus = null;
            this.render();
          }),
      );

    if (this.sourceMode === "dropdown") {
      try {
        if (this.spaces.length === 0) {
          this.spaces = await this.plugin.lark.listSpaces();
        }
      } catch (err) {
        this.contentEl.createEl("p", {
          text: `Failed to fetch spaces: ${(err as Error).message}`,
          cls: "mod-warning",
        });
      }

      new Setting(this.contentEl).setName("Space").addDropdown((d: DropdownComponent) => {
        d.addOption("", "— pick one —");
        for (const s of this.spaces) {
          d.addOption(s.space_id, s.name);
        }
        d.setValue(this.draft.wikiSpaceId).onChange((v) => {
          this.draft.wikiSpaceId = v;
          this.draft.wikiSpaceName = this.spaces.find((s) => s.space_id === v)?.name ?? "";
          this.urlResolved = false;
          this.draft.wikiRootNode = "";
        });
      });
    } else {
      new Setting(this.contentEl)
        .setName("Wiki link")
        .setDesc("Paste any https://…/wiki/… URL or a bare node token.")
        .addText((t) =>
          t
            .setPlaceholder("https://your-tenant.feishu.cn/wiki/wikcn…")
            .setValue(this.urlInput)
            .onChange((v) => (this.urlInput = v)),
        )
        .addButton((btn) =>
          btn.setButtonText("Resolve").setCta().onClick(async () => {
            await this.resolveUrl();
            this.render();
          }),
        );

      if (this.urlStatus) {
        this.contentEl.createEl("p", {
          text: this.urlStatus.message,
          cls: this.urlStatus.kind === "ok" ? "" : "mod-warning",
        });
      }
    }

    this.addNavButtons({
      back: () => (this.step = "auth"),
      next: () => {
        if (this.sourceMode === "url") {
          if (!this.urlResolved) {
            new Notice("Resolve the link first.");
            return;
          }
          this.step = "local"; // wikiRootNode already set — skip the root step
          return;
        }
        if (!this.draft.wikiSpaceId) {
          new Notice("Pick a space first.");
          return;
        }
        this.step = "root";
      },
    });
  }

  private async resolveUrl() {
    const parsed = parseWikiUrl(this.urlInput);
    if (!parsed) {
      this.urlStatus = {
        kind: "err",
        message: "Couldn't recognise that as a Lark wiki link or node token.",
      };
      this.urlResolved = false;
      return;
    }

    try {
      await this.savePartial();
      const node = await this.plugin.lark.getNode(parsed.nodeToken);
      if (!node || !node.space_id || !node.node_token) {
        this.urlStatus = {
          kind: "err",
          message: "lark-cli returned no node for that token. Is it valid and shared with you?",
        };
        this.urlResolved = false;
        return;
      }

      this.draft.wikiSpaceId = node.space_id;
      this.draft.wikiRootNode = node.node_token;

      if (this.spaces.length === 0) {
        try {
          this.spaces = await this.plugin.lark.listSpaces();
        } catch {
          /* non-fatal: we still have the space_id */
        }
      }
      const spaceName = this.spaces.find((s) => s.space_id === node.space_id)?.name ?? node.space_id;
      this.draft.wikiSpaceName = spaceName;

      this.urlStatus = {
        kind: "ok",
        message: `✓ Space: ${spaceName}   •   Root: ${node.title ?? node.node_token} (${node.obj_type ?? "?"})`,
      };
      this.urlResolved = true;
    } catch (err) {
      this.urlStatus = {
        kind: "err",
        message: `Failed: ${(err as Error).message}`,
      };
      this.urlResolved = false;
    }
  }

  private renderRoot() {
    this.contentEl.createEl("p", {
      text:
        "Optional: scope sync to a specific node inside the space. " +
        "Leave blank to sync the whole space.",
    });

    new Setting(this.contentEl)
      .setName("Root node token")
      .addText((t) =>
        t
          .setPlaceholder("wikcn... (paste from a wiki URL if needed)")
          .setValue(this.draft.wikiRootNode)
          .onChange((v) => (this.draft.wikiRootNode = v.trim())),
      );

    this.addNavButtons({
      back: () => (this.step = "space"),
      next: () => (this.step = "local"),
    });
  }

  private renderLocal() {
    new Setting(this.contentEl)
      .setName("Local folder (vault-relative)")
      .setDesc(
        "Parent folder for all synced wiki spaces. Each space will land in its own subfolder under this.",
      )
      .addText((t) =>
        t
          .setPlaceholder("📥 Lark")
          .setValue(this.draft.localRoot)
          .onChange((v) => (this.draft.localRoot = v.trim())),
      );

    if (this.draft.wikiSpaceName) {
      this.contentEl.createEl("p", {
        text: `Files will land at: ${this.draft.localRoot}/${this.draft.wikiSpaceName}/...`,
        cls: "setting-item-description",
      });
    }

    this.addNavButtons({
      back: () => (this.step = this.urlResolved ? "space" : "root"),
      next: () => (this.step = "confirm"),
    });
  }

  private renderConfirm() {
    const spaceLabel = this.draft.wikiSpaceName
      ? `${this.draft.wikiSpaceName} (${this.draft.wikiSpaceId})`
      : this.draft.wikiSpaceId;
    const effectivePath = this.draft.wikiSpaceName
      ? `${this.draft.localRoot}/${this.draft.wikiSpaceName}`
      : this.draft.localRoot;

    const list = this.contentEl.createEl("ul");
    list.createEl("li", { text: `lark-cli: ${this.draft.larkCliPath || "(PATH)"}` });
    list.createEl("li", { text: `Space: ${spaceLabel}` });
    list.createEl("li", { text: `Root node: ${this.draft.wikiRootNode || "(whole space)"}` });
    list.createEl("li", { text: `Will sync to: ${effectivePath}/` });

    this.addNavButtons({
      back: () => (this.step = "local"),
      finish: async () => {
        await this.savePartial();
        this.plugin.settings.configured = true;
        await this.plugin.saveSettings();
        new Notice("Lark Wiki Sync configured. Click the ribbon icon to sync.");
        this.close();
      },
    });
  }

  // ---- Helpers -------------------------------------------------------------

  private async savePartial() {
    this.plugin.settings.larkCliPath = this.draft.larkCliPath;
    this.plugin.settings.wikiSpaceId = this.draft.wikiSpaceId;
    this.plugin.settings.wikiSpaceName = this.draft.wikiSpaceName;
    this.plugin.settings.wikiRootNode = this.draft.wikiRootNode;
    this.plugin.settings.localRoot = this.draft.localRoot;
    await this.plugin.saveSettings();
  }

  private addNavButtons(actions: {
    back?: () => void;
    next?: () => void;
    finish?: () => void | Promise<void>;
  }) {
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });

    if (actions.back) {
      const backBtn = row.createEl("button", { text: "Back" });
      backBtn.onclick = () => {
        actions.back!();
        this.render();
      };
    }

    if (actions.next) {
      const nextBtn = row.createEl("button", { text: "Next", cls: "mod-cta" });
      nextBtn.onclick = () => {
        actions.next!();
        this.render();
      };
    }

    if (actions.finish) {
      const finishBtn = row.createEl("button", { text: "Finish", cls: "mod-cta" });
      finishBtn.onclick = async () => {
        await actions.finish!();
      };
    }
  }
}
