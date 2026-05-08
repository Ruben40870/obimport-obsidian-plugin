import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type OBImportPlugin from "./main";
import { runMigrations } from "./migrate";

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
      .setDesc("If a project note already exists, replace it. Component notes are never overwritten.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.overwriteProject).onChange(async (v) => {
          this.plugin.settings.overwriteProject = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h2", { text: "Template migrations" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Sync existing project + component notes to the current template. " +
            "Adds missing frontmatter keys with empty defaults, removes deprecated keys " +
            "(category, cad_block, etc.), and forces constants such as type capitalization. " +
            "Note bodies are never touched. Idempotent — safe to re-run.",
    });

    new Setting(containerEl)
      .setName("Run template migrations")
      .setDesc("Scan Projects and Components folders and update existing notes.")
      .addButton((b) =>
        b.setButtonText("Run").setCta().onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("Running…");
          try {
            const stats = await runMigrations(this.app, this.plugin.settings);
            const errPart = stats.errors.length > 0
              ? `, ${stats.errors.length} error(s) (see console)`
              : "";
            new Notice(
              `OBImport migrations: scanned ${stats.scanned}, updated ${stats.changed}${errPart}.`,
            );
            if (stats.errors.length > 0) {
              console.error("OBImport migration errors:", stats.errors);
            }
          } catch (e) {
            new Notice(`OBImport migrations failed: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            b.setDisabled(false);
            b.setButtonText("Run");
          }
        })
      );
  }
}
