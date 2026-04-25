import { App, Modal } from "obsidian";
import type { SyncError, SyncResult } from "../sync/SyncEngine";

/**
 * Shown after a sync that produced errors. Lists every per-file failure with
 * its actual lark-cli/transport error message so the user can fix the cause
 * (missing scope, rate limit, malformed markdown) without spelunking through
 * the dev console.
 */
export class SyncResultsModal extends Modal {
  constructor(app: App, private result: SyncResult) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lark-wiki-sync-results");

    const r = this.result;
    contentEl.createEl("h2", { text: "Lark Wiki Sync — results" });

    const summary = contentEl.createEl("p");
    summary.appendText(
      `pulled ${r.pulled} · pushed ${r.pushed} · conflicts ${r.conflicts}` +
        (r.reconciled > 0 ? ` · reconciled ${r.reconciled}` : "") +
        ` · skipped ${r.skipped}`,
    );

    if (r.errors.length === 0) {
      contentEl.createEl("p", { text: "No errors. ✓", cls: "setting-item-description" });
    } else {
      contentEl.createEl("h3", {
        text: `${r.errors.length} error${r.errors.length === 1 ? "" : "s"}`,
      });

      const grouped = groupBy(r.errors, (e) => e.phase);
      for (const [phase, errs] of Object.entries(grouped)) {
        const phaseHeading = contentEl.createEl("p", {
          cls: "setting-item-description",
        });
        phaseHeading.createEl("strong", { text: `${phase} (${errs.length})` });

        const list = contentEl.createEl("ul");
        for (const e of errs) {
          const li = list.createEl("li");
          li.createEl("code", { text: e.file });
          li.createEl("br");
          li.createEl("span", { text: e.message, cls: "mod-warning" });
        }
      }

      contentEl.createEl("p", {
        text: "Common causes: missing lark-cli scope (e.g. docx:document for writes), rate limit, content rejected by Lark. Re-auth with the right scopes via:",
        cls: "setting-item-description",
      });
      contentEl.createEl("pre", {
        text: 'lark-cli auth login --scope "docx:document"',
      });
    }

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const closeBtn = btnRow.createEl("button", { text: "Close", cls: "mod-cta" });
    closeBtn.onclick = () => this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function groupBy<T, K extends string>(arr: T[], key: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of arr) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}
