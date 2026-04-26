import { App, Modal } from "obsidian";
import type { ConflictResolution, PendingConflict } from "../sync/SyncEngine";

/**
 * Shown when the conflict policy is "ask" and there is at least one conflict.
 * For each conflict the user picks one of three actions:
 *
 *   - keep-local:  push local content to Lark, overwriting remote.
 *   - keep-remote: pull remote content over local.
 *   - sidecar:     write a `.remote.conflict.md` sidecar for manual merge
 *                  (default; non-destructive).
 *
 * Resolves with a `{ nodeToken → ConflictResolution }` map so the engine can
 * apply each conflict according to the user's choice. Closing the modal or
 * clicking Cancel resolves with an empty map (every conflict falls through to
 * the engine's default = sidecar).
 */
export function resolveConflictsModal(
  app: App,
  conflicts: PendingConflict[],
): Promise<Record<string, ConflictResolution>> {
  return new Promise((resolve) => {
    const modal = new ConflictModal(app, conflicts, (m) => resolve(m));
    modal.open();
  });
}

class ConflictModal extends Modal {
  private decided = false;
  private picks = new Map<string, ConflictResolution>();

  constructor(
    app: App,
    private conflicts: PendingConflict[],
    private onDecide: (m: Record<string, ConflictResolution>) => void,
  ) {
    super(app);
    for (const c of conflicts) this.picks.set(c.node.node_token, "sidecar");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lark-wiki-sync-conflict");

    contentEl.createEl("h2", {
      text: `Resolve ${this.conflicts.length} conflict${this.conflicts.length === 1 ? "" : "s"}`,
    });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Both sides changed since last sync. Pick a side per file. Default \"Save sidecar\" is non-destructive — it writes a .remote.conflict.md file you can merge manually.",
    });

    for (const c of this.conflicts) {
      this.renderRow(contentEl, c);
    }

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel — skip all conflicts" });
    cancelBtn.onclick = () => this.decide({});
    const applyBtn = btnRow.createEl("button", { text: "Apply resolutions", cls: "mod-cta" });
    applyBtn.onclick = () => {
      const out: Record<string, ConflictResolution> = {};
      for (const [token, res] of this.picks.entries()) out[token] = res;
      this.decide(out);
    };
  }

  onClose(): void {
    if (!this.decided) this.onDecide({});
    this.contentEl.empty();
  }

  private decide(m: Record<string, ConflictResolution>) {
    this.decided = true;
    this.onDecide(m);
    this.close();
  }

  private renderRow(parent: HTMLElement, c: PendingConflict): void {
    const block = parent.createDiv({ cls: "lark-wiki-sync-conflict-row" });
    block.createEl("h3", { text: c.node.title });

    const meta = block.createEl("p", { cls: "setting-item-description" });
    const localLines = countLines(c.localMd);
    const remoteLines = countLines(c.remoteMd);
    meta.appendText(
      `${c.space.spaceName || c.space.spaceId} · ${c.localPath}` +
        ` · local ${localLines} lines · remote ${remoteLines} lines`,
    );

    const groupName = `lark-conflict-${c.node.node_token}`;
    const choices: Array<{ value: ConflictResolution; label: string; desc: string }> = [
      {
        value: "keep-local",
        label: "Keep local",
        desc: "↑ push my edits to Lark; overwrite remote.",
      },
      {
        value: "keep-remote",
        label: "Keep remote",
        desc: "↓ pull Lark version; overwrite my local file.",
      },
      {
        value: "sidecar",
        label: "Save sidecar (default)",
        desc: "Write .remote.conflict.md alongside the local file for manual merge. Nothing else changes.",
      },
    ];

    const list = block.createEl("div", { cls: "lark-wiki-sync-conflict-choices" });
    for (const choice of choices) {
      const id = `${groupName}-${choice.value}`;
      const wrap = list.createEl("label", { cls: "lark-wiki-sync-conflict-choice" });
      wrap.htmlFor = id;
      const radio = wrap.createEl("input", { type: "radio" }) as HTMLInputElement;
      radio.name = groupName;
      radio.id = id;
      radio.value = choice.value;
      radio.checked = this.picks.get(c.node.node_token) === choice.value;
      radio.addEventListener("change", () => {
        this.picks.set(c.node.node_token, choice.value);
      });
      const text = wrap.createEl("span");
      text.createEl("strong", { text: choice.label });
      text.createEl("br");
      text.createEl("span", { text: choice.desc, cls: "setting-item-description" });
    }
  }
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split("\n").length;
}
