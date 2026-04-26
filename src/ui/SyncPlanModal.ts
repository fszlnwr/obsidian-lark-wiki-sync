import { App, Modal } from "obsidian";
import type { PlanDecision, SyncPlan } from "../sync/SyncEngine";

/**
 * Shown after the engine has classified everything but before any change is
 * applied. Lists pulls / pushes / conflicts / reconciles grouped by space so
 * the user can preview what's about to happen and choose between three
 * actions:
 *   - "Apply all":  do everything in the plan.
 *   - "Pull only":  apply pulls + conflicts + reconciles, skip pushes.
 *   - "Cancel":     do nothing.
 *
 * Cancel and "Pull only" are non-destructive; "Apply all" overwrites Lark
 * docs in place.
 */
export function presentSyncPlan(app: App, plan: SyncPlan): Promise<PlanDecision> {
  return new Promise((resolve) => {
    const modal = new SyncPlanModal(app, plan, (decision) => resolve(decision));
    modal.open();
  });
}

interface PerSpaceSummary {
  spaceName: string;
  pulls: string[];
  pushes: string[];
  conflicts: string[];
  reconciles: number;
}

class SyncPlanModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private plan: SyncPlan,
    private onDecide: (decision: PlanDecision) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lark-wiki-sync-plan");

    const totals = {
      pulls: this.plan.pulls.length,
      pushes: this.plan.pushes.length,
      conflicts: this.plan.conflicts.length,
      reconciles: this.plan.reconciles.length,
    };

    contentEl.createEl("h2", { text: "Lark Wiki Sync — plan" });

    const summary = contentEl.createEl("p", { cls: "lark-wiki-sync-plan-summary" });
    summary.appendText(
      `${totals.pulls} pull${plural(totals.pulls)} · ` +
        `${totals.pushes} push${plural(totals.pushes, "es")} · ` +
        `${totals.conflicts} conflict${plural(totals.conflicts)}` +
        (totals.reconciles > 0 ? ` · ${totals.reconciles} reconcile${plural(totals.reconciles)}` : "") +
        ` · ${this.plan.skipped} unchanged`,
    );

    if (totals.pulls + totals.pushes + totals.conflicts + totals.reconciles === 0) {
      contentEl.createEl("p", {
        text: "Nothing to do. Local and remote are in sync.",
        cls: "setting-item-description",
      });
    } else {
      const grouped = this.groupBySpace();
      for (const summary of grouped) {
        this.renderSpaceBlock(contentEl, summary);
      }
    }

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });

    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.decide("cancel");

    if (totals.pushes > 0) {
      const pullOnlyBtn = btnRow.createEl("button", { text: "Pull only" });
      pullOnlyBtn.onclick = () => this.decide("pullsOnly");
    }

    const applyBtn = btnRow.createEl("button", {
      text: totals.pushes > 0 ? "Apply all" : "Apply",
      cls: totals.pushes > 0 ? "mod-cta mod-warning" : "mod-cta",
    });
    applyBtn.onclick = () => this.decide("applyAll");
  }

  onClose(): void {
    if (!this.decided) this.onDecide("cancel");
    this.contentEl.empty();
  }

  private decide(d: PlanDecision) {
    this.decided = true;
    this.onDecide(d);
    this.close();
  }

  private groupBySpace(): PerSpaceSummary[] {
    const map = new Map<string, PerSpaceSummary>();
    const get = (spaceName: string) => {
      let s = map.get(spaceName);
      if (!s) {
        s = { spaceName, pulls: [], pushes: [], conflicts: [], reconciles: 0 };
        map.set(spaceName, s);
      }
      return s;
    };
    for (const p of this.plan.pulls) {
      get(p.space.spaceName || p.space.spaceId).pulls.push(p.node.title);
    }
    for (const p of this.plan.pushes) {
      get(p.space.spaceName || p.space.spaceId).pushes.push(p.node.title);
    }
    for (const c of this.plan.conflicts) {
      get(c.space.spaceName || c.space.spaceId).conflicts.push(c.node.title);
    }
    for (const r of this.plan.reconciles) {
      get(r.space.spaceName || r.space.spaceId).reconciles++;
    }
    return [...map.values()];
  }

  private renderSpaceBlock(parent: HTMLElement, s: PerSpaceSummary): void {
    const block = parent.createDiv({ cls: "lark-wiki-sync-plan-space" });
    block.createEl("h3", { text: `📥 ${s.spaceName}` });

    const counts: string[] = [];
    if (s.pulls.length > 0) counts.push(`↓ ${s.pulls.length} pull${plural(s.pulls.length)}`);
    if (s.pushes.length > 0) counts.push(`↑ ${s.pushes.length} push${plural(s.pushes.length, "es")}`);
    if (s.conflicts.length > 0) counts.push(`⚠ ${s.conflicts.length} conflict${plural(s.conflicts.length)}`);
    if (s.reconciles > 0) counts.push(`✓ ${s.reconciles} reconcile${plural(s.reconciles)}`);
    block.createEl("p", { text: counts.join("  ·  "), cls: "setting-item-description" });

    if (s.pulls.length > 0) renderTitleList(block, "Pull", s.pulls);
    if (s.pushes.length > 0) renderTitleList(block, "Push", s.pushes);
    if (s.conflicts.length > 0) renderTitleList(block, "Conflict", s.conflicts);
  }
}

function renderTitleList(parent: HTMLElement, label: string, titles: string[]): void {
  const det = parent.createEl("details");
  det.createEl("summary", { text: `${label} (${titles.length})` });
  const ul = det.createEl("ul");
  for (const t of titles) ul.createEl("li", { text: t });
}

function plural(n: number, suffix = "s"): string {
  return n === 1 ? "" : suffix;
}
