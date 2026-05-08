export interface BomRow {
  nr: number;
  description: string;
  tag: string;
  brand: string;
  modelNumber: string;
  qty: number;
}

// Keyword-regex matcher — handles arbitrary header phrasings without hard-coded
// alias lists. Each canonical column matches any header containing one of its
// keyword stems; ambiguous overlaps (e.g. "Tag Number" hits both `tag` and
// `number`) are resolved by the backtracking assignment in findHeader().
const KEYWORDS: Record<string, RegExp> = {
  "nr.": /\b(nr|no|num|number|item|pos|line|seq)\b|#/i,
  "description": /\b(desc|description|name|designation|denomination|beschreib\w*|omschrijv\w*)\b/i,
  "tag number": /\b(tag|label)\b/i,
  "brand": /\b(brand|make|manuf\w*|mfr|mfg|vendor|supplier|fabricant|hersteller|merk|marca|marque)\b/i,
  "model number": /\b(model|part|order|catalog|catalogue|cat|type|article|articolo|ref|sku|code|bestell\w*|onderdeel\w*|numero)\b/i,
  "qty": /\b(qty|quantity|qnty|qnt|amount|pcs|pieces|count|anzahl|aantal|quantità|cantidad|nombre)\b/i,
};

const REQUIRED = Object.keys(KEYWORDS);

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
  const m = pn.match(/^(\d+)/);
  if (m) return `${m[1]}-07`;
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

function bestMatchLen(text: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let best = 0;
  for (const m of text.matchAll(g)) {
    if (m[0].length > best) best = m[0].length;
  }
  return best;
}

function findHeader(rows: string[][]): { index: number; mapping: Record<string, number> } | null {
  for (let i = 0; i < rows.length; i++) {
    const headers = rows[i].map((c) => cleanText(c).toLowerCase());

    // Build candidate header indices per canonical, sorted by match strength.
    const candidates: Record<string, Array<{ idx: number; score: number }>> = {};
    for (const c of REQUIRED) {
      const list: Array<{ idx: number; score: number }> = [];
      for (let j = 0; j < headers.length; j++) {
        const score = bestMatchLen(headers[j], KEYWORDS[c]);
        if (score > 0) list.push({ idx: j, score });
      }
      list.sort((a, b) => b.score - a.score);
      candidates[c] = list;
    }
    if (REQUIRED.some((c) => candidates[c].length === 0)) continue;

    // Backtracking assignment, rarest canonicals first to avoid getting stuck.
    const order = [...REQUIRED].sort(
      (a, b) => candidates[a].length - candidates[b].length,
    );
    const mapping: Record<string, number> = {};
    const used = new Set<number>();
    const solve = (k: number): boolean => {
      if (k === order.length) return true;
      const c = order[k];
      for (const cand of candidates[c]) {
        if (used.has(cand.idx)) continue;
        mapping[c] = cand.idx;
        used.add(cand.idx);
        if (solve(k + 1)) return true;
        used.delete(cand.idx);
        delete mapping[c];
      }
      return false;
    };

    if (solve(0)) return { index: i, mapping };
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
