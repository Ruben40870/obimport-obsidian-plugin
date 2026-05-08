import { App, PluginSettingTab, Setting } from "obsidian";
import type OBImportPlugin from "./main";

export interface OBImportSettings {
  projectsFolder: string;
  componentsFolder: string;
  defaultClient: string;
  overwriteProject: boolean;
}

export const DEFAULT_SETTINGS: OBImportSettings = {
  projectsFolder: "Projects",
  componentsFolder: "Components",
  defaultClient: "",
  overwriteProject: true,
};

export class OBImportSettingTab extends PluginSettingTab {
  plugin: OBImportPlugin;

  constructor(app: App, plugin: OBImportPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "OBImport" });
    containerEl.createEl("p", {
      text: "Imports an AutoCAD BOM CSV into a project note plus per-component notes. " +
            "Project number is what you type in the import modal; drawing number is derived " +
            "(if it ends in -GEN, the suffix becomes -07; otherwise the project number is used).",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Projects folder")
      .setDesc("Vault folder where project notes are written.")
      .addText((t) =>
        t.setPlaceholder("Projects")
          .setValue(this.plugin.settings.projectsFolder)
          .onChange(async (v) => {
            this.plugin.settings.projectsFolder = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Components folder")
      .setDesc("Vault folder where per-component notes are written, grouped by brand.")
      .addText((t) =>
        t.setPlaceholder("Components")
          .setValue(this.plugin.settings.componentsFolder)
          .onChange(async (v) => {
            this.plugin.settings.componentsFolder = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default client")
      .setDesc("Pre-fill the client field in the import modal.")
      .addText((t) =>
        t.setValue(this.plugin.settings.defaultClient).onChange(async (v) => {
          this.plugin.settings.defaultClient = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Overwrite project note on rerun")
      .setDesc("If a project note already exists, replace it. Component notes are never overwritten.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.overwriteProject).onChange(async (v) => {
          this.plugin.settings.overwriteProject = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
