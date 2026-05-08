import { Plugin } from "obsidian";
import { ImportModal } from "./modal";
import { DEFAULT_SETTINGS, OBImportSettings, OBImportSettingTab } from "./settings";

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

    this.addSettingTab(new OBImportSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
