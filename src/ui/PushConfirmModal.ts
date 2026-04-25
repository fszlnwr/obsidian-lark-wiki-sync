import { App, Modal } from "obsidian";
import type { PendingPush } from "../sync/SyncEngine";

/**
 * Lists local-only edits that the engine wants to upload to Lark and asks the
 * user to confirm before any push happens. Returns true if the user clicks
 * "Push to Lark", false otherwise (cancel button, ESC, or backdrop click).
 */
export function confirmPushes(app: App, pushes: PendingPush[]): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new PushConfirmModal(app, pushes, (ok) => resolve(ok));
    modal.open();
  });
}

class PushConfirmModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private pushes: PendingPush[],
    private onDecide: (ok: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lark-wiki-sync-push-confirm");

    contentEl.createEl("h2", {
      text: `Push ${this.pushes.length} change${this.pushes.length === 1 ? "" : "s"} to Lark?`,
    });

    contentEl.createEl("p", {
      text: "These local files differ from what Lark currently has. Confirming will overwrite each Lark doc with the local content (replace_all).",
      cls: "setting-item-description",
    });

    const list = contentEl.createEl("ul", { cls: "lark-wiki-sync-push-list" });
    for (const p of this.pushes) {
      const li = list.createEl("li");
      li.createEl("strong", { text: p.node.title });
      li.appendText(` — ${p.localPath}`);
      const meta = li.createEl("div", { cls: "setting-item-description" });
      meta.appendText(`space: ${p.space.spaceName || p.space.spaceId}`);
    }

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });

    const cancelBtn = btnRow.createEl("button", { text: "Cancel push" });
    cancelBtn.onclick = () => {
      this.decided = true;
      this.onDecide(false);
      this.close();
    };

    const confirmBtn = btnRow.createEl("button", {
      text: "Push to Lark",
      cls: "mod-cta mod-warning",
    });
    confirmBtn.onclick = () => {
      this.decided = true;
      this.onDecide(true);
      this.close();
    };
  }

  onClose(): void {
    if (!this.decided) this.onDecide(false);
    this.contentEl.empty();
  }
}
