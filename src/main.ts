import { Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { ImportModal } from "./modal";
import { DEFAULT_SETTINGS, OBImportSettings, OBImportSettingTab } from "./settings";
import { EnrichService, readComponentInput } from "./enrich";
import { REVIEW_VIEW_TYPE, ReviewView } from "./review-view";

export default class OBImportPlugin extends Plugin {
  settings: OBImportSettings = { ...DEFAULT_SETTINGS };
  enrichService!: EnrichService;

  async onload() {
    await this.loadSettings();

    this.enrichService = new EnrichService(this.app, () => this.settings);

    this.registerView(REVIEW_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ReviewView(leaf, this));

    // Import
    this.addRibbonIcon("file-up", "OBImport: Import BOM CSV", () => {
      new ImportModal(this.app, this).open();
    });

    // Review panel
    this.addRibbonIcon("wand-2", "OBImport: Open Review panel", () => {
      void this.activateReviewView();
    });

    this.addCommand({
      id: "open-import-modal",
      name: "Import BOM CSV",
      callback: () => new ImportModal(this.app, this).open(),
    });

    // Review sidebar
    this.addCommand({
      id: "open-review-panel",
      name: "Open Review panel",
      callback: () => this.activateReviewView(),
    });

    // Enrich commands
    this.addCommand({
      id: "enrich-current-component",
      name: "Enrich current component",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const eligible = !!file && file.extension === "md" && this.isInComponentsFolder(file);
        if (checking) return eligible;
        if (eligible) void this.enrichService.enrichFiles([file as TFile]);
        return true;
      },
    });

    this.addCommand({
      id: "enrich-folder",
      name: "Enrich components in current folder",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const folder = file?.parent ?? null;
        const eligible = !!folder && this.isInComponentsTree(folder);
        if (checking) return eligible;
        if (eligible) {
          const files = this.collectComponentFilesInFolder(folder);
          void this.enrichService.enrichFiles(files);
        }
        return true;
      },
    });

    this.addCommand({
      id: "enrich-all-components",
      name: "Enrich all components",
      callback: () => this.enrichAllComponents(),
    });

    this.addCommand({
      id: "cancel-enrich",
      name: "Cancel running enrich",
      callback: () => this.enrichService.cancel(),
    });

    this.addSettingTab(new OBImportSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(REVIEW_VIEW_TYPE);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateReviewView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeftLeaf(false);
    if (!leaf) {
      new Notice("OBImport: could not open Review panel (no left sidebar leaf).");
      return;
    }
    await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async enrichAllComponents(): Promise<void> {
    const files = this.collectAllComponentFiles();
    if (files.length === 0) {
      new Notice("OBImport: no component notes found.");
      return;
    }
    await this.activateReviewView();
    void this.enrichService.enrichFiles(files);
  }

  private isInComponentsFolder(file: TFile): boolean {
    return this.isInComponentsTree(file.parent ?? null);
  }

  private isInComponentsTree(folder: TFolder | null): boolean {
    if (!folder) return false;
    const root = this.settings.componentsFolder.replace(/^\/+|\/+$/g, "") || "Components";
    const pending = this.settings.pendingFolderName.replace(/^\/+|\/+$/g, "") || "_Pending";
    if (!folder.path.startsWith(root)) return false;
    // Exclude pending folder.
    if (folder.path === `${root}/${pending}` || folder.path.startsWith(`${root}/${pending}/`)) return false;
    return true;
  }

  private collectComponentFilesInFolder(folder: TFolder): TFile[] {
    const out: TFile[] = [];
    const walk = (f: TFolder) => {
      for (const child of f.children) {
        if (child instanceof TFolder) {
          // Skip pending folder anywhere inside.
          const pending = this.settings.pendingFolderName.replace(/^\/+|\/+$/g, "") || "_Pending";
          if (child.name === pending) continue;
          walk(child);
        } else if (child instanceof TFile && child.extension === "md") {
          out.push(child);
        }
      }
    };
    walk(folder);
    return out;
  }

  private collectAllComponentFiles(): TFile[] {
    const root = this.settings.componentsFolder.replace(/^\/+|\/+$/g, "") || "Components";
    const node = this.app.vault.getAbstractFileByPath(root);
    if (!(node instanceof TFolder)) return [];
    return this.collectComponentFilesInFolder(node).filter((f) => {
      // Filter to files whose frontmatter has manufacturer + part_number;
      // skip silently otherwise (enrichService will also skip but listing here keeps UI clean).
      // We can't read sync, so just do lightweight check by path heuristic + let service skip.
      void readComponentInput;
      return true;
    });
  }
}
