import { App, PluginSettingTab, Setting } from "obsidian";
import type OBImportPlugin from "./main";

export interface OBImportSettings {
  // Import
  projectsFolder: string;
  componentsFolder: string;
  defaultClient: string;
  overwriteProject: boolean;

  // Enrich
  openRouterApiKey: string;
  primaryModel: string;
  fallbackModel: string;
  maxTokensPerItem: number;
  pendingFolderName: string;
  downloadPdfDatasheets: boolean;
}

export const DEFAULT_SETTINGS: OBImportSettings = {
  projectsFolder: "Projects",
  componentsFolder: "Components",
  defaultClient: "",
  overwriteProject: true,

  openRouterApiKey: "",
  primaryModel: "google/gemma-3-27b-it:online",
  fallbackModel: "",
  maxTokensPerItem: 1000,
  pendingFolderName: "_Pending",
  downloadPdfDatasheets: false,
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

    containerEl.createEl("h2", { text: "OBImport — Import" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "BOM CSV → project + per-component notes. Project number is what you type " +
            "in the import modal; drawing number is derived (-GEN → -07).",
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
      .setDesc("If a project note already exists, replace it. Component notes are never overwritten by import.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.overwriteProject).onChange(async (v) => {
          this.plugin.settings.overwriteProject = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h2", { text: "OBImport — AI Enrich" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Run on existing component notes to fetch description, datasheet URL, " +
            "and supplier link from the manufacturer's website. Proposals are written " +
            "to the pending folder and reviewed via the OBImport Review sidebar.",
    });

    new Setting(containerEl)
      .setName("OpenRouter API key")
      .setDesc("https://openrouter.ai/keys. Stored in <vault>/.obsidian/plugins/obimport/data.json.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-or-...")
          .setValue(this.plugin.settings.openRouterApiKey)
          .onChange(async (v) => {
            this.plugin.settings.openRouterApiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Primary model")
      .setDesc("OpenRouter model ID. Append :online to enable web search via Exa (recommended).")
      .addText((t) =>
        t.setPlaceholder("google/gemma-3-27b-it:online")
          .setValue(this.plugin.settings.primaryModel)
          .onChange(async (v) => {
            this.plugin.settings.primaryModel = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Fallback model")
      .setDesc("Used if the primary model returns no usable data. Leave blank to disable retry.")
      .addText((t) =>
        t.setPlaceholder("(optional)")
          .setValue(this.plugin.settings.fallbackModel)
          .onChange(async (v) => {
            this.plugin.settings.fallbackModel = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max output tokens per component")
      .setDesc("Hard cap per AI request.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxTokensPerItem))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.maxTokensPerItem = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Pending folder name")
      .setDesc("Subfolder of the components folder where AI proposals are written for review.")
      .addText((t) =>
        t.setValue(this.plugin.settings.pendingFolderName).onChange(async (v) => {
          this.plugin.settings.pendingFolderName = v.trim() || "_Pending";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Download PDF datasheets")
      .setDesc("After approval, fetch the datasheet URL and save the PDF into a Datasheets/<Brand>/ folder, embedded in the component note. Off by default to avoid vault bloat.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.downloadPdfDatasheets).onChange(async (v) => {
          this.plugin.settings.downloadPdfDatasheets = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
