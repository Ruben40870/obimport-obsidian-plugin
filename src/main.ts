import { Notice, Plugin } from "obsidian";
import { ImportModal } from "./modal";
import { DEFAULT_SETTINGS, OBImportSettings, OBImportSettingTab } from "./settings";
import { runMigrations } from "./migrate";

export default class OBImportPlugin extends Plugin {
  settings: OBImportSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("file-up", "OBImport: Import BOM CSV", () => {
      new ImportModal(this.app, this).open();
    });

    this.addCommand({
      id: "open-import-modal",
      name: "Import BOM CSV",
      callback: () => new ImportModal(this.app, this).open(),
    });

    this.addCommand({
      id: "run-template-migrations",
      name: "Run template migrations",
      callback: async () => {
        try {
          const stats = await runMigrations(this.app, this.settings);
          const errPart = stats.errors.length > 0 ? `, ${stats.errors.length} error(s)` : "";
          new Notice(`OBImport migrations: scanned ${stats.scanned}, updated ${stats.changed}${errPart}.`);
          if (stats.errors.length > 0) console.error("OBImport migration errors:", stats.errors);
        } catch (e) {
          new Notice(`OBImport migrations failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });

    this.addSettingTab(new OBImportSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
