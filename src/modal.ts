import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type OBImportPlugin from "./main";
import { runImport } from "./importer";
import { deriveDrawingNumber, parseBom } from "./parser";

export class ImportModal extends Modal {
  plugin: OBImportPlugin;

  projectNumber = "";
  panelTag = "";
  client = "";
  csvFiles: Array<{ name: string; data: ArrayBuffer }> = [];

  private drawingHintEl!: HTMLElement;
  private fileNameEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private submitBtn!: HTMLButtonElement;

  constructor(app: App, plugin: OBImportPlugin) {
    super(app);
    this.plugin = plugin;
    this.client = plugin.settings.defaultClient;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("obimport-modal");

    contentEl.createEl("h2", { text: "Import BOM CSV" });

    new Setting(contentEl)
      .setName("Project number")
      .setDesc("Example: 23320-GEN. Drawing number is derived automatically.")
      .addText((t) =>
        t.setPlaceholder("23320-GEN")
          .setValue(this.projectNumber)
          .onChange((v) => {
            this.projectNumber = v.trim();
            this.updateDrawingHint();
          })
      );

    this.drawingHintEl = contentEl.createEl("div", { cls: "obimport-hint" });

    new Setting(contentEl)
      .setName("Panel tag")
      .setDesc("Used as the project note filename. Project note path: <Projects>/<project number>/<panel tag>.md.")
      .addText((t) =>
        t.setPlaceholder("UCP-001")
          .setValue(this.panelTag)
          .onChange((v) => {
            this.panelTag = v.trim();
          })
      );

    new Setting(contentEl)
      .setName("Client (optional)")
      .addText((t) =>
        t.setValue(this.client).onChange((v) => {
          this.client = v;
        })
      );

    const fileInput = contentEl.createEl("input", {
      attr: { type: "file", accept: ".csv,text/csv", multiple: "true" },
    }) as HTMLInputElement;
    fileInput.style.display = "none";

    new Setting(contentEl)
      .setName("BOM CSV file(s)")
      .setDesc("Pick one or more CSVs. Multiple files are concatenated in pick order; rows renumbered globally.")
      .addButton((b) =>
        b.setButtonText("Choose file(s)…").onClick(() => fileInput.click())
      );

    this.fileNameEl = contentEl.createEl("div", {
      cls: "obimport-filename",
      text: "No file chosen",
    });

    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files ?? []);
      if (files.length === 0) {
        this.csvFiles = [];
        this.fileNameEl.setText("No file chosen");
        return;
      }
      this.csvFiles = await Promise.all(
        files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })),
      );
      this.fileNameEl.setText(
        this.csvFiles.length === 1
          ? this.csvFiles[0].name
          : `${this.csvFiles.length} files: ${this.csvFiles.map((f) => f.name).join(", ")}`,
      );
    });

    this.errorEl = contentEl.createEl("div", { cls: "obimport-error" });

    const btnRow = contentEl.createDiv({ cls: "obimport-actions" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    this.submitBtn = btnRow.createEl("button", { text: "Import", cls: "mod-cta" });
    this.submitBtn.addEventListener("click", () => this.submit());

    this.updateDrawingHint();
  }

  private updateDrawingHint() {
    if (!this.drawingHintEl) return;
    if (!this.projectNumber) {
      this.drawingHintEl.setText("");
      return;
    }
    this.drawingHintEl.setText(`Drawing number: ${deriveDrawingNumber(this.projectNumber)}`);
  }

  private async submit() {
    this.errorEl.setText("");
    if (!this.projectNumber) {
      this.errorEl.setText("Project number is required.");
      return;
    }
    if (!this.panelTag) {
      this.errorEl.setText("Panel tag is required.");
      return;
    }
    if (this.csvFiles.length === 0) {
      this.errorEl.setText("At least one CSV file is required.");
      return;
    }
    this.submitBtn.disabled = true;
    try {
      const allRows = [];
      const failed: string[] = [];
      for (const f of this.csvFiles) {
        try {
          const rows = parseBom(f.data);
          if (rows.length === 0) {
            failed.push(`${f.name}: no data rows`);
            continue;
          }
          allRows.push(...rows);
        } catch (e) {
          failed.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (failed.length > 0) {
        throw new Error(`Parse failed for ${failed.length} file(s):\n${failed.join("\n")}`);
      }
      if (allRows.length === 0) {
        throw new Error("No BOM rows found across the selected file(s).");
      }
      // Renumber sequentially across all files so the merged BOM reads as one table.
      allRows.forEach((r, i) => { r.nr = i + 1; });

      const sourceLabel = this.csvFiles.map((f) => f.name).join(", ");
      const result = await runImport(
        this.app,
        this.plugin.settings,
        this.projectNumber,
        this.panelTag,
        this.client,
        allRows,
        sourceLabel,
      );
      new Notice(
        `OBImport: ${result.rowCount} rows from ${this.csvFiles.length} file(s). ` +
        `Components: +${result.componentsCreated} new, ${result.componentsSkipped} kept. ` +
        `Drawing: ${result.drawing}.`
      );
      this.close();
      const file = this.app.vault.getAbstractFileByPath(result.projectFile);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf().openFile(file);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.errorEl.setText(`Import failed: ${msg}`);
    } finally {
      this.submitBtn.disabled = false;
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
