import { App, TFile, TFolder } from "obsidian";
import type { OBImportSettings } from "./settings";

type FieldSpec =
  | { name: string; kind: "constant"; value: string }
  | { name: string; kind: "user"; default: string };

const COMPONENT_FIELDS: FieldSpec[] = [
  { name: "type", kind: "constant", value: "Component" },
  { name: "manufacturer", kind: "user", default: "" },
  { name: "part_number", kind: "user", default: "" },
  { name: "model_number", kind: "user", default: "" },
  { name: "description", kind: "user", default: "" },
  { name: "datasheet", kind: "user", default: "" },
  { name: "supplier_link", kind: "user", default: "" },
];

const PROJECT_FIELDS: FieldSpec[] = [
  { name: "type", kind: "constant", value: "Project" },
  { name: "project_number", kind: "user", default: "" },
  { name: "panel_tag", kind: "user", default: "" },
  { name: "client", kind: "user", default: "" },
  { name: "drawing", kind: "user", default: "" },
  { name: "source_bom", kind: "user", default: "" },
];

export interface MigrationStats {
  scanned: number;
  changed: number;
  errors: Array<{ path: string; error: string }>;
}

function findFrontmatter(content: string): { lines: string[]; rest: string } | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  return { lines: m[1].split(/\r?\n/), rest: content.slice(m[0].length) };
}

function getKey(line: string): string | null {
  const m = line.match(/^([A-Za-z_][\w-]*)\s*:/);
  return m ? m[1] : null;
}

function getValue(line: string): string {
  const idx = line.indexOf(":");
  if (idx === -1) return "";
  let v = line.slice(idx + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

function setValue(line: string, value: string): string {
  const idx = line.indexOf(":");
  if (idx === -1) return line;
  return `${line.slice(0, idx + 1)} "${value}"`;
}

function migrateFrontmatter(lines: string[], spec: FieldSpec[]): { lines: string[]; changed: boolean } {
  let out = [...lines];
  let changed = false;

  // Remove unknown keys first (preserves cleaner ordering when adding).
  const allowed = new Set(spec.map((s) => s.name));
  const filtered: string[] = [];
  for (const line of out) {
    const k = getKey(line);
    if (k && !allowed.has(k)) {
      changed = true;
      continue;
    }
    filtered.push(line);
  }
  out = filtered;

  // Index keys still present.
  const presentIdx = new Map<string, number>();
  for (let i = 0; i < out.length; i++) {
    const k = getKey(out[i]);
    if (k && !presentIdx.has(k)) presentIdx.set(k, i);
  }

  // Add missing keys + force constants.
  for (const s of spec) {
    const idx = presentIdx.get(s.name);
    if (idx == null) {
      const value = s.kind === "constant" ? s.value : s.default;
      out.push(`${s.name}: "${value}"`);
      changed = true;
    } else if (s.kind === "constant") {
      if (getValue(out[idx]) !== s.value) {
        out[idx] = setValue(out[idx], s.value);
        changed = true;
      }
    }
  }

  return { lines: out, changed };
}

function collectMarkdownFiles(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  const walk = (f: TFolder) => {
    for (const child of f.children) {
      if (child instanceof TFolder) walk(child);
      else if (child instanceof TFile && child.extension === "md") out.push(child);
    }
  };
  walk(folder);
  return out;
}

async function migrateFolder(
  app: App,
  rootPath: string,
  spec: FieldSpec[],
  stats: MigrationStats,
): Promise<void> {
  const node = app.vault.getAbstractFileByPath(rootPath);
  if (!(node instanceof TFolder)) return;
  const files = collectMarkdownFiles(node);
  for (const file of files) {
    stats.scanned++;
    try {
      const content = await app.vault.read(file);
      const fm = findFrontmatter(content);
      if (!fm) continue; // No frontmatter — leave alone.
      const { lines: newLines, changed } = migrateFrontmatter(fm.lines, spec);
      if (!changed) continue;
      const newContent = `---\n${newLines.join("\n")}\n---\n${fm.rest}`;
      await app.vault.modify(file, newContent);
      stats.changed++;
    } catch (e) {
      stats.errors.push({
        path: file.path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

export async function runMigrations(app: App, settings: OBImportSettings): Promise<MigrationStats> {
  const stats: MigrationStats = { scanned: 0, changed: 0, errors: [] };
  const componentsRoot = settings.componentsFolder.replace(/^\/+|\/+$/g, "") || "Components";
  const projectsRoot = settings.projectsFolder.replace(/^\/+|\/+$/g, "") || "Projects";
  await migrateFolder(app, componentsRoot, COMPONENT_FIELDS, stats);
  await migrateFolder(app, projectsRoot, PROJECT_FIELDS, stats);
  return stats;
}
