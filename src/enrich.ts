import { App, Notice, TFile, TFolder, normalizePath, parseYaml, requestUrl, stringifyYaml } from "obsidian";
import { chat, verifyUrl } from "./openrouter";
import type { OBImportSettings } from "./settings";
import { cleanFilename, cleanText, componentNoteName } from "./parser";

export interface ComponentInput {
  file: TFile;
  manufacturer: string;
  partNumber: string;
  modelNumber: string;
}

export interface EnrichmentJson {
  description: string | null;
  datasheet_url: string | null;
  supplier_link: string | null;
  image_url: string | null;
  notes: string | null;
}

export interface EnrichResult {
  source: TFile;
  pendingPath: string | null;
  status: "ok" | "failed" | "skipped";
  error?: string;
  unverifiedDatasheet?: boolean;
}

export type EnrichEvent =
  | { type: "queued"; total: number }
  | { type: "progress"; index: number; total: number; file: TFile }
  | { type: "result"; result: EnrichResult }
  | { type: "done"; cancelled: boolean };

const ENRICHED_FIELDS = ["description", "datasheet", "supplier_link"] as const;
const STRIPPED_LEGACY_FIELDS = ["category", "cad_block"] as const;

function buildPrompt(input: ComponentInput): { system: string; user: string } {
  const system =
    "You extract real product data for an electrical / mechanical engineering knowledge base. " +
    "You always go to the manufacturer's official website, find the actual product page, and " +
    "copy facts verbatim. You translate Dutch source text into English while preserving " +
    "technical terminology, units, and model numbers. You never invent URLs.";

  const partLines = [
    `- Manufacturer: ${input.manufacturer}`,
    `- Part number: ${input.partNumber}`,
  ];
  if (input.modelNumber && input.modelNumber !== input.partNumber) {
    partLines.push(`- Model: ${input.modelNumber}`);
  }

  const user = [
    "Component:",
    ...partLines,
    "",
    `Step 1. Visit ${input.manufacturer}'s official website and find the product page for "${input.partNumber}".`,
    "Step 2. Copy the short product description from that page (≤ 200 characters).",
    "  - If the description is in Dutch, translate it into English. Preserve technical terms.",
    "  - Keep model numbers, units, sizes, voltages exactly as written.",
    "Step 3. Find the official manufacturer datasheet URL (PDF preferred, on the manufacturer's domain).",
    "Step 4. Find a 'where to buy' or supplier product page from the manufacturer's site. Prefer Dutch suppliers; otherwise EU.",
    "Step 5. Find a direct URL to the main product image (.png / .jpg / .jpeg / .webp). Must point to an image file, not an HTML page. Avoid logos, banners, search-result thumbnails.",
    "",
    "Use web search. Do not invent URLs. If a field cannot be confirmed, set it to null.",
    "",
    "Return strict JSON only. No prose, no markdown, no code fences. Schema:",
    `{
  "description": "<string or null, ≤ 200 chars, English>",
  "datasheet_url": "<string URL or null>",
  "supplier_link": "<string URL or null>",
  "image_url": "<string URL to image file or null>",
  "notes": "<string or null, e.g. 'datasheet behind login'>"
}`,
  ].join("\n");

  return { system, user };
}

function extractJson(text: string): EnrichmentJson | null {
  if (!text) return null;
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const tryParse = (s: string): EnrichmentJson | null => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === "object") return normaliseEnrichment(obj);
    } catch {
      /* ignore */
    }
    return null;
  };
  const direct = tryParse(stripped);
  if (direct) return direct;
  // Find first { ... } block by brace matching.
  const start = stripped.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return tryParse(stripped.slice(start, i + 1));
      }
    }
  }
  return null;
}

function normaliseEnrichment(obj: Record<string, unknown>): EnrichmentJson {
  const str = (v: unknown): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
  };
  return {
    description: str(obj.description),
    datasheet_url: str(obj.datasheet_url ?? obj.datasheet),
    supplier_link: str(obj.supplier_link ?? obj.supplier ?? obj.supplier_url),
    image_url: str(obj.image_url ?? obj.image ?? obj.image_link),
    notes: str(obj.notes),
  };
}

function isAllBlank(e: EnrichmentJson): boolean {
  return !e.description && !e.datasheet_url && !e.supplier_link && !e.image_url;
}

function readFrontmatter(content: string): { data: Record<string, unknown>; body: string; hasFrontmatter: boolean } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: content, hasFrontmatter: false };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore — leave data empty */
  }
  const body = content.slice(m[0].length);
  return { data, body, hasFrontmatter: true };
}

function writeFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(data).trimEnd();
  return `---\n${yaml}\n---\n${body.startsWith("\n") ? body.slice(1) : body}`;
}

export function readComponentInput(file: TFile, content: string): ComponentInput | null {
  const { data } = readFrontmatter(content);
  const manufacturer = cleanText(data.manufacturer ?? "");
  const partNumber = cleanText(data.part_number ?? data.model_number ?? "");
  const modelNumber = cleanText(data.model_number ?? data.part_number ?? "");
  if (!manufacturer || manufacturer.toLowerCase() === "unknown brand") return null;
  if (!partNumber) return null;
  return { file, manufacturer, partNumber, modelNumber };
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const norm = normalizePath(path);
  if (!norm || norm === "/") return;
  const parts = norm.split("/").filter((p) => p.length > 0);
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    const node = app.vault.getAbstractFileByPath(cur);
    if (!node) {
      await app.vault.createFolder(cur);
    } else if (!(node instanceof TFolder)) {
      throw new Error(`Path exists but is not a folder: ${cur}`);
    }
  }
}

function pendingPathFor(settings: OBImportSettings, manufacturer: string, modelNumber: string): string {
  const components = settings.componentsFolder.replace(/^\/+|\/+$/g, "") || "Components";
  const pendingFolder = settings.pendingFolderName.replace(/^\/+|\/+$/g, "") || "_Pending";
  const brand = cleanFilename(manufacturer || "Unknown Brand");
  const name = componentNoteName(manufacturer, modelNumber);
  return normalizePath(`${components}/${pendingFolder}/${brand}/${name}.md`);
}

function buildPendingFile(
  base: { data: Record<string, unknown>; body: string },
  enrichment: EnrichmentJson,
  meta: { sourcePath: string; model: string; unverifiedDatasheet: boolean; status: "pending" | "failed"; notes: string | null },
): string {
  const merged: Record<string, unknown> = { ...base.data };
  // Strip legacy fields.
  for (const k of STRIPPED_LEGACY_FIELDS) delete merged[k];
  // Apply enrichment.
  if (enrichment.description) merged.description = enrichment.description;
  if (enrichment.datasheet_url) merged.datasheet = enrichment.datasheet_url;
  if (enrichment.supplier_link) merged.supplier_link = enrichment.supplier_link;
  // Pending metadata (underscore-prefixed so it's easy to strip on approve).
  merged._status = meta.status;
  merged._proposed_at = new Date().toISOString();
  merged._model = meta.model;
  merged._source = meta.sourcePath;
  if (enrichment.image_url) merged._image_url = enrichment.image_url;
  if (meta.unverifiedDatasheet) merged._unverified_datasheet = true;
  if (meta.notes) merged._notes = meta.notes;

  return writeFrontmatter(merged, base.body || "\n");
}

async function writeFileSafe(app: App, path: string, content: string): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
    return existing;
  }
  return await app.vault.create(path, content);
}

export class EnrichService {
  private app: App;
  private getSettings: () => OBImportSettings;
  private cancelled = false;
  private running = false;
  private listener: ((e: EnrichEvent) => void) | null = null;

  constructor(app: App, getSettings: () => OBImportSettings) {
    this.app = app;
    this.getSettings = getSettings;
  }

  isRunning(): boolean { return this.running; }

  setListener(fn: (e: EnrichEvent) => void): void { this.listener = fn; }
  clearListener(): void { this.listener = null; }

  cancel(): void {
    if (this.running) {
      this.cancelled = true;
      new Notice("OBImport: cancel requested. Will stop after the current component.");
    }
  }

  private emit(e: EnrichEvent) { this.listener?.(e); }

  async enrichFiles(files: TFile[]): Promise<void> {
    if (this.running) {
      new Notice("OBImport: an enrich run is already in progress.");
      return;
    }
    const settings = this.getSettings();
    if (!settings.openRouterApiKey) {
      new Notice("OBImport: set your OpenRouter API key in plugin settings first.");
      return;
    }

    const inputs: ComponentInput[] = [];
    const skipped: TFile[] = [];
    for (const f of files) {
      const content = await this.app.vault.read(f);
      const inp = readComponentInput(f, content);
      if (inp) inputs.push(inp);
      else skipped.push(f);
    }

    if (skipped.length > 0) {
      new Notice(`OBImport: skipped ${skipped.length} file(s) (missing manufacturer or part number).`);
    }
    if (inputs.length === 0) {
      new Notice("OBImport: no eligible component notes to enrich.");
      return;
    }

    this.running = true;
    this.cancelled = false;
    this.emit({ type: "queued", total: inputs.length });

    try {
      for (let i = 0; i < inputs.length; i++) {
        if (this.cancelled) break;
        const inp = inputs[i];
        this.emit({ type: "progress", index: i + 1, total: inputs.length, file: inp.file });
        const result = await this.enrichOne(inp, settings);
        this.emit({ type: "result", result });
        // Soft throttle.
        await sleep(250);
      }
    } finally {
      const wasCancelled = this.cancelled;
      this.running = false;
      this.cancelled = false;
      this.emit({ type: "done", cancelled: wasCancelled });
    }
  }

  private async enrichOne(input: ComponentInput, settings: OBImportSettings): Promise<EnrichResult> {
    const sourceContent = await this.app.vault.read(input.file);
    const base = readFrontmatter(sourceContent);

    const { system, user } = buildPrompt(input);
    const messages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ];

    let enrichment: EnrichmentJson | null = null;
    let modelUsed = settings.primaryModel;
    let lastError: string | undefined;

    try {
      const res = await chat(settings.openRouterApiKey, {
        model: settings.primaryModel,
        messages,
        maxTokens: settings.maxTokensPerItem,
      });
      enrichment = extractJson(res.text);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }

    const needsRetry = !enrichment || isAllBlank(enrichment);
    if (needsRetry && settings.fallbackModel) {
      modelUsed = settings.fallbackModel;
      try {
        const res = await chat(settings.openRouterApiKey, {
          model: settings.fallbackModel,
          messages,
          maxTokens: settings.maxTokensPerItem,
        });
        enrichment = extractJson(res.text);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }

    const eff: EnrichmentJson = enrichment ?? {
      description: null, datasheet_url: null, supplier_link: null, image_url: null, notes: null,
    };

    let unverified = false;
    if (eff.datasheet_url) {
      const err = await verifyUrl(eff.datasheet_url);
      if (err) unverified = true;
    }

    const failed = isAllBlank(eff);

    const pendingPath = pendingPathFor(settings, input.manufacturer, input.modelNumber || input.partNumber);
    await ensureFolder(this.app, pendingPath.split("/").slice(0, -1).join("/"));

    const content = buildPendingFile(base, eff, {
      sourcePath: input.file.path,
      model: modelUsed,
      unverifiedDatasheet: unverified,
      status: failed ? "failed" : "pending",
      notes: eff.notes ?? lastError ?? null,
    });

    await writeFileSafe(this.app, pendingPath, content);

    return {
      source: input.file,
      pendingPath,
      status: failed ? "failed" : "ok",
      error: lastError,
      unverifiedDatasheet: unverified,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Approve / reject
// ============================================================================

const PENDING_META_FIELDS = ["_status", "_proposed_at", "_model", "_source", "_image_url", "_unverified_datasheet", "_notes"];

export async function approvePending(app: App, settings: OBImportSettings, pendingFile: TFile): Promise<void> {
  const pendingContent = await app.vault.read(pendingFile);
  const { data: pendingData } = readFrontmatter(pendingContent);

  const sourcePath = typeof pendingData._source === "string" ? pendingData._source : null;
  if (!sourcePath) {
    throw new Error("Pending file has no _source field; cannot resolve original component.");
  }
  const sourceFile = app.vault.getAbstractFileByPath(normalizePath(sourcePath));
  if (!(sourceFile instanceof TFile)) {
    throw new Error(`Original component file not found: ${sourcePath}`);
  }

  const sourceContent = await app.vault.read(sourceFile);
  const sourceParsed = readFrontmatter(sourceContent);

  const merged: Record<string, unknown> = { ...sourceParsed.data };
  // Strip legacy fields from real component note.
  for (const k of STRIPPED_LEGACY_FIELDS) delete merged[k];
  // Overwrite enriched fields with pending values (only if pending has them).
  for (const f of ENRICHED_FIELDS) {
    if (pendingData[f] != null && pendingData[f] !== "") {
      merged[f] = pendingData[f];
    }
  }
  // Drop pending metadata if it accidentally landed.
  for (const f of PENDING_META_FIELDS) delete merged[f];

  // Body cleanup: strip legacy "## Description" + "## Datasheet" sections.
  let body = stripLegacyBodySections(sourceParsed.body);

  // Image: download + embed between H1 and the next heading.
  const imageUrl = typeof pendingData._image_url === "string" ? pendingData._image_url : null;
  if (imageUrl) {
    try {
      const manufacturer = String(merged.manufacturer ?? "");
      const modelNumber = String(merged.model_number ?? merged.part_number ?? "");
      const fileName = await downloadImage(app, manufacturer, modelNumber, imageUrl);
      body = insertImageEmbed(body, fileName);
    } catch (e) {
      new Notice(`OBImport: image download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const newContent = writeFrontmatter(merged, body);
  await app.vault.modify(sourceFile, newContent);

  if (settings.downloadPdfDatasheets) {
    const url = typeof pendingData.datasheet === "string" ? pendingData.datasheet : null;
    if (url) {
      try {
        await downloadAndEmbedPdf(app, settings, sourceFile, merged, url);
      } catch (e) {
        new Notice(`OBImport: PDF download failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  await app.vault.delete(pendingFile);
}

function stripLegacyBodySections(body: string): string {
  let out = body;
  // Remove "## Description" block (heading + content) up to next heading or EOF.
  out = out.replace(/(^|\n)##\s+Description[ \t]*\r?\n[\s\S]*?(?=\n##\s|\n#\s|$)/g, "$1");
  // Remove "## Datasheet" block similarly.
  out = out.replace(/(^|\n)##\s+Datasheet[ \t]*\r?\n[\s\S]*?(?=\n##\s|\n#\s|$)/g, "$1");
  // Collapse runs of 3+ newlines down to 2.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

function insertImageEmbed(body: string, fileName: string): string {
  const embed = `![[${fileName}]]`;
  if (body.includes(embed)) return body;
  const m = body.match(/^(#\s[^\n]*\n)/m);
  if (!m || m.index == null) {
    return `${embed}\n\n${body}`;
  }
  const insertAt = m.index + m[0].length;
  const before = body.slice(0, insertAt);
  const after = body.slice(insertAt);
  // Ensure exactly one blank line on each side.
  const leadingTrim = after.replace(/^\n+/, "");
  return `${before}\n${embed}\n\n${leadingTrim}`;
}

function imageExtFromContentType(ct: string): string | null {
  const t = ct.toLowerCase();
  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.includes("svg")) return "svg";
  if (t.includes("gif")) return "gif";
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  return null;
}

function imageExtFromUrl(url: string): string | null {
  const m = url.match(/\.(png|jpg|jpeg|gif|webp|svg)(?:[?#]|$)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : null;
}

async function downloadImage(
  app: App,
  manufacturer: string,
  modelNumber: string,
  url: string,
): Promise<string> {
  const res = await requestUrl({ url, method: "GET", throw: false });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}`);
  }
  const ct = String(res.headers["content-type"] ?? res.headers["Content-Type"] ?? "");
  if (ct && !ct.toLowerCase().startsWith("image/")) {
    throw new Error(`URL did not return an image (content-type: ${ct})`);
  }
  const ext = imageExtFromContentType(ct) ?? imageExtFromUrl(url) ?? "jpg";
  const brand = cleanFilename(manufacturer || "Unknown Brand");
  const folder = `Images/${brand}`;
  await ensureFolder(app, folder);
  const baseName = componentNoteName(manufacturer, modelNumber);
  const fileName = `${baseName}.${ext}`;
  const path = normalizePath(`${folder}/${fileName}`);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modifyBinary(existing, res.arrayBuffer);
  } else {
    await app.vault.createBinary(path, res.arrayBuffer);
  }
  return fileName;
}

export async function rejectPending(app: App, pendingFile: TFile): Promise<void> {
  await app.vault.delete(pendingFile);
}

async function downloadAndEmbedPdf(
  app: App,
  settings: OBImportSettings,
  componentFile: TFile,
  frontmatter: Record<string, unknown>,
  url: string,
): Promise<void> {
  const res = await requestUrl({ url, method: "GET", throw: false });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}`);
  }
  const ct = res.headers["content-type"] || res.headers["Content-Type"] || "";
  if (!ct.toLowerCase().includes("pdf")) {
    throw new Error(`URL did not return a PDF (content-type: ${ct || "unknown"})`);
  }
  const manufacturer = String(frontmatter.manufacturer ?? "Unknown");
  const modelNumber = String(frontmatter.model_number ?? frontmatter.part_number ?? "unknown");
  const datasheetsRoot = "Datasheets";
  const brandFolder = `${datasheetsRoot}/${cleanFilename(manufacturer || "Unknown Brand")}`;
  await ensureFolder(app, brandFolder);
  const fileName = `${componentNoteName(manufacturer, modelNumber)}.pdf`;
  const path = normalizePath(`${brandFolder}/${fileName}`);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modifyBinary(existing, res.arrayBuffer);
  } else {
    await app.vault.createBinary(path, res.arrayBuffer);
  }
  const componentContent = await app.vault.read(componentFile);
  if (!componentContent.includes(`![[${fileName}]]`)) {
    const updated = componentContent + (componentContent.endsWith("\n") ? "" : "\n") + `\n![[${fileName}]]\n`;
    await app.vault.modify(componentFile, updated);
  }
  // settings parameter currently unused beyond gating; keep reference to avoid lint.
  void settings;
}

// ============================================================================
// Pending listing
// ============================================================================

export interface PendingEntry {
  file: TFile;
  brand: string;
  modelNumber: string;
  status: "pending" | "failed";
  unverifiedDatasheet: boolean;
  description: string;
  datasheet: string;
  supplierLink: string;
  imageUrl: string;
  sourcePath: string;
}

export function listPendingFiles(app: App, settings: OBImportSettings): TFile[] {
  const components = settings.componentsFolder.replace(/^\/+|\/+$/g, "") || "Components";
  const pendingFolder = settings.pendingFolderName.replace(/^\/+|\/+$/g, "") || "_Pending";
  const root = normalizePath(`${components}/${pendingFolder}`);
  const node = app.vault.getAbstractFileByPath(root);
  if (!(node instanceof TFolder)) return [];
  const out: TFile[] = [];
  const walk = (folder: TFolder) => {
    for (const child of folder.children) {
      if (child instanceof TFolder) walk(child);
      else if (child instanceof TFile && child.extension === "md") out.push(child);
    }
  };
  walk(node);
  return out;
}

export async function readPendingEntry(app: App, file: TFile): Promise<PendingEntry> {
  const content = await app.vault.read(file);
  const { data } = readFrontmatter(content);
  return {
    file,
    brand: String(data.manufacturer ?? ""),
    modelNumber: String(data.model_number ?? data.part_number ?? ""),
    status: data._status === "failed" ? "failed" : "pending",
    unverifiedDatasheet: data._unverified_datasheet === true,
    description: String(data.description ?? ""),
    datasheet: String(data.datasheet ?? ""),
    supplierLink: String(data.supplier_link ?? ""),
    imageUrl: typeof data._image_url === "string" ? data._image_url : "",
    sourcePath: typeof data._source === "string" ? data._source : "",
  };
}
