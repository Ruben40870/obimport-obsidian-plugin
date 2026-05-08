import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type OBImportPlugin from "./main";
import {
  EnrichEvent,
  PendingEntry,
  approvePending,
  listPendingFiles,
  readPendingEntry,
  rejectPending,
} from "./enrich";

export const REVIEW_VIEW_TYPE = "obimport-review";

export class ReviewView extends ItemView {
  plugin: OBImportPlugin;

  private headerEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  private listEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private vaultEventRefs: Array<unknown> = [];

  constructor(leaf: WorkspaceLeaf, plugin: OBImportPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return REVIEW_VIEW_TYPE; }
  getDisplayText(): string { return "OBImport Review"; }
  getIcon(): string { return "wand-2"; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("obimport-review");

    this.headerEl = root.createDiv({ cls: "obimport-review-header" });
    this.headerEl.createEl("h3", { text: "Component review" });

    this.actionsEl = root.createDiv({ cls: "obimport-review-actions" });
    const enrichAllBtn = this.actionsEl.createEl("button", { text: "Enrich all", cls: "mod-cta" });
    enrichAllBtn.addEventListener("click", () => this.plugin.enrichAllComponents());

    const cancelBtn = this.actionsEl.createEl("button", { text: "Cancel run" });
    cancelBtn.addEventListener("click", () => this.plugin.enrichService.cancel());

    const refreshBtn = this.actionsEl.createEl("button", { text: "Refresh" });
    refreshBtn.addEventListener("click", () => this.refresh());

    this.statusEl = root.createDiv({ cls: "obimport-review-status" });

    this.listEl = root.createDiv({ cls: "obimport-review-list" });

    const footer = root.createDiv({ cls: "obimport-review-footer" });
    const approveAllBtn = footer.createEl("button", { text: "Approve all", cls: "mod-cta" });
    approveAllBtn.addEventListener("click", () => this.approveAll());
    const rejectAllBtn = footer.createEl("button", { text: "Reject all", cls: "mod-warning" });
    rejectAllBtn.addEventListener("click", () => this.rejectAll());

    this.plugin.enrichService.setListener((e) => this.onEnrichEvent(e));

    // Refresh when files change.
    this.vaultEventRefs.push(
      this.app.vault.on("create", (f) => { if (this.isPending(f)) this.refresh(); }),
      this.app.vault.on("delete", (f) => { if (this.isPending(f)) this.refresh(); }),
      this.app.vault.on("modify", (f) => { if (this.isPending(f)) this.refresh(); }),
      this.app.vault.on("rename", (f) => { if (this.isPending(f)) this.refresh(); }),
    );

    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.plugin.enrichService.clearListener();
    for (const ref of this.vaultEventRefs) this.app.vault.offref(ref as never);
    this.vaultEventRefs = [];
  }

  private isPending(file: { path: string }): boolean {
    const components = this.plugin.settings.componentsFolder.replace(/^\/+|\/+$/g, "") || "Components";
    const pending = this.plugin.settings.pendingFolderName.replace(/^\/+|\/+$/g, "") || "_Pending";
    return file.path.startsWith(`${components}/${pending}/`);
  }

  private setStatus(text: string): void {
    this.statusEl.setText(text);
  }

  async refresh(): Promise<void> {
    this.listEl.empty();
    const files = listPendingFiles(this.app, this.plugin.settings);
    if (files.length === 0) {
      this.listEl.createEl("div", {
        cls: "obimport-review-empty",
        text: "No pending components. Run \"OBImport: Enrich all components\" to start.",
      });
      return;
    }
    const entries: PendingEntry[] = [];
    for (const f of files) {
      try {
        entries.push(await readPendingEntry(this.app, f));
      } catch {
        // Ignore unreadable files.
      }
    }
    // Group by brand.
    const byBrand = new Map<string, PendingEntry[]>();
    for (const e of entries) {
      const arr = byBrand.get(e.brand || "(no brand)") ?? [];
      arr.push(e);
      byBrand.set(e.brand || "(no brand)", arr);
    }
    const sortedBrands = [...byBrand.keys()].sort((a, b) => a.localeCompare(b));
    for (const brand of sortedBrands) {
      const group = this.listEl.createDiv({ cls: "obimport-review-group" });
      group.createEl("div", { cls: "obimport-review-brand", text: brand });
      const items = byBrand.get(brand)!.sort((a, b) => a.modelNumber.localeCompare(b.modelNumber));
      for (const entry of items) this.renderEntry(group, entry);
    }
  }

  private renderEntry(parent: HTMLElement, entry: PendingEntry): void {
    const row = parent.createDiv({ cls: "obimport-review-row" });
    const head = row.createDiv({ cls: "obimport-review-row-head" });
    const icon = head.createSpan({ cls: "obimport-review-icon" });
    icon.setText(entry.status === "failed" ? "✗" : entry.unverifiedDatasheet ? "⚠" : "✓");
    icon.addClass(`obimport-status-${entry.status === "failed" ? "failed" : entry.unverifiedDatasheet ? "unverified" : "ok"}`);

    const title = head.createDiv({ cls: "obimport-review-title" });
    title.setText(entry.modelNumber || entry.file.basename);
    title.addEventListener("click", () => {
      this.app.workspace.getLeaf().openFile(entry.file);
    });

    if (entry.description) {
      row.createDiv({ cls: "obimport-review-desc", text: entry.description });
    }

    const links = row.createDiv({ cls: "obimport-review-links" });
    if (entry.datasheet) {
      const a = links.createEl("a", { href: entry.datasheet, text: "datasheet" });
      a.setAttr("target", "_blank");
      a.setAttr("rel", "noopener");
    }
    if (entry.supplierLink) {
      const a = links.createEl("a", { href: entry.supplierLink, text: "supplier" });
      a.setAttr("target", "_blank");
      a.setAttr("rel", "noopener");
    }

    const actions = row.createDiv({ cls: "obimport-review-row-actions" });
    const approveBtn = actions.createEl("button", { text: "Approve", cls: "mod-cta" });
    approveBtn.addEventListener("click", async () => {
      await this.approveOne(entry);
    });
    const rejectBtn = actions.createEl("button", { text: "Reject" });
    rejectBtn.addEventListener("click", async () => {
      await rejectPending(this.app, entry.file);
      new Notice(`Rejected: ${entry.modelNumber}`);
    });
    const reBtn = actions.createEl("button", { text: "Re-enrich" });
    reBtn.addEventListener("click", async () => {
      const sourceFile = this.app.vault.getAbstractFileByPath(entry.sourcePath);
      if (!(sourceFile instanceof TFile)) {
        new Notice(`Original component file missing: ${entry.sourcePath}`);
        return;
      }
      await this.plugin.enrichService.enrichFiles([sourceFile]);
    });
  }

  private async approveOne(entry: PendingEntry): Promise<void> {
    try {
      await approvePending(this.app, this.plugin.settings, entry.file);
      new Notice(`Approved: ${entry.modelNumber}`);
    } catch (e) {
      new Notice(`Approve failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async approveAll(): Promise<void> {
    const files = listPendingFiles(this.app, this.plugin.settings);
    if (files.length === 0) { new Notice("Nothing to approve."); return; }
    if (!confirm(`Approve all ${files.length} pending components?`)) return;
    let ok = 0, fail = 0;
    for (const f of files) {
      try {
        await approvePending(this.app, this.plugin.settings, f);
        ok++;
      } catch {
        fail++;
      }
    }
    new Notice(`Approved ${ok}${fail ? `, ${fail} failed` : ""}.`);
  }

  private async rejectAll(): Promise<void> {
    const files = listPendingFiles(this.app, this.plugin.settings);
    if (files.length === 0) { new Notice("Nothing to reject."); return; }
    if (!confirm(`Reject all ${files.length} pending components? Files will be deleted.`)) return;
    let ok = 0;
    for (const f of files) {
      try { await rejectPending(this.app, f); ok++; } catch { /* ignore */ }
    }
    new Notice(`Rejected ${ok}.`);
  }

  private onEnrichEvent(e: EnrichEvent): void {
    if (e.type === "queued") this.setStatus(`Queued ${e.total} components.`);
    else if (e.type === "progress") this.setStatus(`Enriching ${e.index}/${e.total}: ${e.file.basename}`);
    else if (e.type === "result") {
      // Trigger refresh when each finishes — keeps list live.
      void this.refresh();
    } else if (e.type === "done") {
      this.setStatus(e.cancelled ? "Cancelled." : "Done.");
      void this.refresh();
    }
  }
}
