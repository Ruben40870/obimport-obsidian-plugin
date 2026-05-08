export interface BomRow {
  nr: number;
  description: string;
  tag: string;
  brand: string;
  modelNumber: string;
  qty: number;
}

const COLUMN_ALIASES: Record<string, string[]> = {
  "nr.": ["nr.", "nr", "no.", "no", "item", "item no.", "item no", "#"],
  "description": ["description", "desc"],
  "tag number": ["tag number", "tag", "tag no.", "tag no"],
  "brand": ["brand", "make", "manufacturer", "mfr"],
  "model number": [
    "model number", "model", "model no.", "model no",
    "part number", "part no.", "part no",
  ],
  "qty": ["qty", "quantity", "qnty"],
};

const REQUIRED = Object.keys(COLUMN_ALIASES);

export function cleanText(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/[\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

export function cleanFilename(value: string): string {
  let s = cleanText(value);
  s = s.replace(/\//g, "-")
       .replace(/\\/g, "-")
       .replace(/[<>:"|?*]/g, "-")
       .replace(/\s+/g, " ");
  return s.slice(0, 140).trim();
}

export function deriveDrawingNumber(projectNumber: string): string {
  const pn = cleanText(projectNumber);
  if (pn.toUpperCase().endsWith("-GEN")) return pn.slice(0, -4) + "-07";
  return pn;
}

export function componentNoteName(brand: string, modelNumber: string): string {
  return cleanFilename(`${brand} ${modelNumber}`);
}

function decodeCsv(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (utf8.includes("�")) {
    try {
      return new TextDecoder("windows-1252").decode(buf);
    } catch {
      // ignore, fall through
    }
  }
  return utf8.charCodeAt(0) === 0xFEFF ? utf8.slice(1) : utf8;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 4096);
  const firstLine = sample.split(/\r?\n/)[0] ?? "";
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = 0;
  for (const d of candidates) {
    const matches = firstLine.match(new RegExp(escapeRe(d), "g"));
    const count = matches ? matches.length : 0;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : ",";
}

function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === delim) { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function findHeader(rows: string[][]): { index: number; mapping: Record<string, number> } | null {
  for (let i = 0; i < rows.length; i++) {
    const norm = rows[i].map((c) => cleanText(c).toLowerCase());
    const mapping: Record<string, number> = {};
    let ok = true;
    for (const canonical of REQUIRED) {
      const aliases = COLUMN_ALIASES[canonical];
      const idx = norm.findIndex((n) => aliases.includes(n));
      if (idx === -1) { ok = false; break; }
      mapping[canonical] = idx;
    }
    if (ok) return { index: i, mapping };
  }
  return null;
}

function toInt(v: string, dflt = 1): number {
  const t = cleanText(v);
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : dflt;
}

export function parseBom(buf: ArrayBuffer): BomRow[] {
  const text = decodeCsv(buf);
  const delim = sniffDelimiter(text);
  let rows = parseCsv(text, delim);
  rows = rows.filter((r) => r.some((c) => cleanText(c).length > 0));

  const header = findHeader(rows);
  if (!header) {
    const first = rows[0] ?? [];
    throw new Error(
      `Could not find header row with columns ${REQUIRED.join(", ")}. ` +
      `Detected delimiter='${delim}'. First row: ${JSON.stringify(first)}`
    );
  }

  const out: BomRow[] = [];
  for (let i = header.index + 1; i < rows.length; i++) {
    const r = rows[i];
    const cell = (name: string): string => {
      const idx = header.mapping[name];
      return idx < r.length ? r[idx] : "";
    };
    const modelNumber = cleanText(cell("model number"));
    if (!modelNumber) continue;
    out.push({
      nr: toInt(cell("nr.")),
      description: cleanText(cell("description")),
      tag: cleanText(cell("tag number")),
      brand: cleanText(cell("brand")),
      modelNumber,
      qty: toInt(cell("qty"), 1),
    });
  }
  return out;
}
