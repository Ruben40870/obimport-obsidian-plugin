import { App, normalizePath, TFile, TFolder, Vault } from "obsidian";
import {
  BomRow,
  cleanFilename,
  cleanText,
  componentNoteName,
  deriveDrawingNumber,
} from "./parser";
import { OBImportSettings } from "./settings";

function yamlValue(value: string): string {
  const v = cleanText(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${v}"`;
}

function markdownCell(value: string): string {
  return cleanText(value).replace(/\|/g, "\\|");
}

function buildComponentNote(brand: string, modelNumber: string, description: string) {
  const name = componentNoteName(brand, modelNumber);
  const content = `---
type: component
manufacturer: ${yamlValue(brand)}
part_number: ${yamlValue(modelNumber)}
model_number: ${yamlValue(modelNumber)}
description: ${yamlValue(description)}
datasheet: ""
supplier_link: ""
---

# ${name}

## Notes

## Used in projects

\`\`\`dataview
TABLE project_number, drawing
FROM "Projects"
WHERE contains(file.outlinks, this.file.link)
SORT project_number ASC
\`\`\`
`;
  return { name, content };
}

function buildProjectNote(
  projectNumber: string,
  client: string,
  drawing: string,
  sourceCsvName: string,
  rows: BomRow[],
): string {
  const lines: string[] = [
    "| Nr | Tag | Component | Brand | Model Number | Description | Qty |",
    "|---:|---|---|---|---|---|---:|",
  ];
  for (const r of rows) {
    const compName = componentNoteName(r.brand, r.modelNumber);
    lines.push(
      `| ${r.nr} | ${markdownCell(r.tag)} | [[${compName}]] | ${markdownCell(r.brand)} | ` +
      `${markdownCell(r.modelNumber)} | ${markdownCell(r.description)} | ${r.qty} |`,
    );
  }
  const table = lines.join("\n");

  return `---
type: project
project_number: ${yamlValue(projectNumber)}
client: ${yamlValue(client)}
drawing: ${yamlValue(drawing)}
source_bom: ${yamlValue(sourceCsvName)}
---

# ${projectNumber}

## BOM

${table}
`;
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const norm = normalizePath(path);
  if (!norm || norm === "/") return;
  const existing = vault.getAbstractFileByPath(norm);
  if (existing instanceof TFolder) return;
  if (existing) {
    throw new Error(`Path exists but is not a folder: ${norm}`);
  }
  const parts = norm.split("/").filter((p) => p.length > 0);
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    const node = vault.getAbstractFileByPath(cur);
    if (!node) {
      await vault.createFolder(cur);
    } else if (!(node instanceof TFolder)) {
      throw new Error(`Path exists but is not a folder: ${cur}`);
    }
  }
}

async function writeProjectFile(
  vault: Vault,
  path: string,
  content: string,
  overwrite: boolean,
): Promise<TFile> {
  const norm = normalizePath(path);
  const existing = vault.getAbstractFileByPath(norm);
  if (existing instanceof TFile) {
    if (overwrite) {
      await vault.modify(existing, content);
    }
    return existing;
  }
  return await vault.create(norm, content);
}

export interface ImportResult {
  projectFile: string;
  drawing: string;
  rowCount: number;
  componentsCreated: number;
  componentsSkipped: number;
}

export async function runImport(
  app: App,
  settings: OBImportSettings,
  projectNumber: string,
  client: string,
  rows: BomRow[],
  csvFilename: string,
): Promise<ImportResult> {
  const pn = cleanText(projectNumber);
  if (!pn) throw new Error("Project number is required.");
  const drawing = deriveDrawingNumber(pn);

  const projectsFolder = stripSlashes(settings.projectsFolder) || "Projects";
  const componentsFolder = stripSlashes(settings.componentsFolder) || "Components";

  await ensureFolder(app.vault, projectsFolder);
  await ensureFolder(app.vault, componentsFolder);

  let created = 0;
  let skipped = 0;
  for (const r of rows) {
    const brandFolder = `${componentsFolder}/${cleanFilename(r.brand || "Unknown Brand")}`;
    await ensureFolder(app.vault, brandFolder);
    const { name, content } = buildComponentNote(r.brand, r.modelNumber, r.description);
    const path = normalizePath(`${brandFolder}/${name}.md`);
    if (app.vault.getAbstractFileByPath(path)) {
      skipped++;
      continue;
    }
    await app.vault.create(path, content);
    created++;
  }

  const projectFileName = `${cleanFilename(pn)}.md`;
  const projectPath = `${projectsFolder}/${projectFileName}`;
  const projectContent = buildProjectNote(pn, client, drawing, csvFilename, rows);
  const file = await writeProjectFile(app.vault, projectPath, projectContent, settings.overwriteProject);

  return {
    projectFile: file.path,
    drawing,
    rowCount: rows.length,
    componentsCreated: created,
    componentsSkipped: skipped,
  };
}

function stripSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, "").trim();
}
