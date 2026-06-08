// ============================================================
// XLSX direct-XML write helpers (extracted from documents.ts)
// ExcelJS is used only for READING; all writes go through direct XML manipulation
// of the workbook zip (surgicalWriteXlsx) so existing formatting/formulas survive.
// Self-contained: depends only on exceljs + jszip.
// ============================================================
import ExcelJS from "exceljs";
import JSZip from "jszip";

// ========== XLSX DIRECT XML HELPERS ==========
// ExcelJS is only used for READING. All writes go through direct XML manipulation.

export const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const xmlUnesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Parse xl/sharedStrings.xml into an index→text array (concatenates rich-text runs). */
export function parseSharedStrings(ssXml: string): string[] {
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(ssXml)) !== null) {
    const texts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]);
    out.push(xmlUnesc(texts.join("")));
  }
  return out;
}

export const MONTH_ABBRS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * Locate the target month block in a month-blocked tab (Utilization / Realization
 * / Collection). Each tab lays out a month-label row in col A with attorney rows
 * beneath it keyed by initials in col B.
 *
 * Two subtleties this handles that a naive scan does not:
 *  1. Cells are SHARED STRINGS (`<c t="s"><v>105</v></c>` — the <v> is an index
 *     into sharedStrings, not the text). col A/B text MUST be resolved through
 *     `sharedStrings` or the month label reads back as a number and nothing
 *     matches (this was the 0/0/0 bug).
 *  2. The sheet can hold MULTIPLE YEARS (one JAN..DEC set per year), so there are
 *     several "APR" headers. We pick the block whose target `dataCols` are still
 *     EMPTY — the one being filled this run; prior years are already populated.
 *     Falls back to the last matching block if none are empty (e.g. a deliberate
 *     re-run overwriting an already-filled month).
 *
 * Month matching is on the first 3 letters, so "APR" / "Apr" / "April" all match.
 */
export function findTabMonthBlock(
  xml: string,
  monthAbbr: string,
  sharedStrings: string[],
  dataCols: string[],
): { hdr: number; attorneys: Array<{ row: number; ini: string }> } | null {
  const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const cellText = (rowXml: string, col: string): string => {
    const re = new RegExp(`(<c\\b[^>]*\\br="${col}\\d+"[^>]*>)([\\s\\S]*?)</c>`);
    const m = rowXml.match(re);
    if (!m) return "";
    const open = m[1], inner = m[2];
    const t = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
    if (t) return xmlUnesc(t[1]);
    const v = inner.match(/<v>([\s\S]*?)<\/v>/);
    if (v) {
      if (/\bt="s"/.test(open)) { const i = parseInt(v[1], 10); return sharedStrings[i] ?? ""; }
      return v[1];
    }
    return "";
  };
  const cellHasNumber = (rowXml: string, col: string): boolean => {
    const re = new RegExp(`<c\\b[^>]*\\br="${col}\\d+"[^>]*>([\\s\\S]*?)</c>`);
    const m = rowXml.match(re);
    if (!m) return false;
    const v = m[1].match(/<v>([\s\S]*?)<\/v>/);
    return !!(v && v[1].trim() !== "");
  };
  const rows: Array<{ n: number; body: string }> = [];
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml)) !== null) rows.push({ n: parseInt(rm[1], 10), body: rm[2] });
  rows.sort((a, b) => a.n - b.n);

  type Blk = { hdr: number; attorneys: Array<{ row: number; ini: string }>; filled: boolean };
  const blocks: Blk[] = [];
  let cur: Blk | null = null;
  for (const { n, body } of rows) {
    const a3 = cellText(body, "A").trim().toUpperCase().slice(0, 3);
    const b = cellText(body, "B").trim().toUpperCase();
    if (MONTH_ABBRS.includes(a3)) {
      if (cur && cur.attorneys.length) blocks.push(cur);
      cur = a3 === monthAbbr ? { hdr: n, attorneys: [], filled: false } : null;
      continue;
    }
    if (!cur) continue;
    if (b === "" || b === "EMPLOYEE" || b === "TOTAL") {
      if (cur.attorneys.length) { blocks.push(cur); cur = null; }
      continue;
    }
    cur.attorneys.push({ row: n, ini: b });
    if (dataCols.some((c) => cellHasNumber(body, c))) cur.filled = true;
  }
  if (cur && cur.attorneys.length) blocks.push(cur);
  if (!blocks.length) return null;
  const empty = blocks.filter((b) => !b.filled);
  const chosen = empty.length ? empty[0] : blocks[blocks.length - 1];
  return { hdr: chosen.hdr, attorneys: chosen.attorneys };
}

/** Build a single <c> element */
export function xmlCell(ref: string, value: number | string | null | undefined, opts?: { style?: string; formula?: string }): string {
  if (value === null || value === undefined) {
    if (opts?.formula) {
      const s = opts.style ? ` s="${opts.style}"` : "";
      return `<c r="${ref}"${s}><f>${xmlEsc(opts.formula)}</f></c>`;
    }
    return "";
  }
  const s = opts?.style ? ` s="${opts.style}"` : "";
  if (opts?.formula) {
    return `<c r="${ref}"${s}><f>${xmlEsc(opts.formula)}</f><v>${value}</v></c>`;
  }
  if (typeof value === "number") {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t>${xmlEsc(String(value))}</t></is></c>`;
}

/** Build a <row> element from an array of cell specs */
export function xmlRow(rowNum: number, cells: string[]): string {
  const filtered = cells.filter(Boolean);
  if (filtered.length === 0) return "";
  return `<row r="${rowNum}">${filtered.join("")}</row>`;
}

/**
 * Per-cell style placeholders. xmlCell writes these into the s="…" attribute at
 * build time; surgicalWriteXlsx's addStyles pass substitutes them with the real
 * style indices once the workbook's cellXfs have been extended. This lets us
 * differentiate currency vs decimal vs percent vs bold cells per-call without
 * having to thread ST through every helper.
 */
export const STYLE_CUR  = "__CUR__";  // $#,##0.00
export const STYLE_DEC  = "__DEC__";  // 0.0  (hours)
export const STYLE_PCT  = "__PCT__";  // 0.00%
export const STYLE_BOLD = "__BOLD__"; // bold, general
export const STYLE_GEN  = "__GEN__";  // general (default fallback)
export const STYLE_GREEN = "__GREEN__"; // currency + green fill (on goal)
export const STYLE_AMBER = "__AMBER__"; // currency + amber fill (within 10% below goal)
export const STYLE_RED   = "__RED__";   // currency + red fill (off goal)
export const STYLE_CURDASH  = "__CURDASH__";  // "$"#,##0.00, zero shown as "-"
export const STYLE_CURDASHB = "__CURDASHB__"; // same, bold

/**
 * On/off-goal color placeholder: green if actual ≥ goal, amber within 10% below,
 * red otherwise. Returns plain currency (STYLE_CUR) when there's no goal to
 * compare against, so callers can leave such cells uncolored.
 */
export function goalColorStyle(actual: number, proratedGoal: number): string {
  if (!(proratedGoal > 0)) return STYLE_CUR;
  const ratio = actual / proratedGoal;
  return ratio >= 1 ? STYLE_GREEN : ratio >= 0.9 ? STYLE_AMBER : STYLE_RED;
}

/** Set (or insert) the s="…" style attribute on a specific cell in a sheet XML. */
export function setCellStyle(xml: string, ref: string, styleId: string): string {
  const re = new RegExp(`(<c\\b[^>]*\\br="${ref}")([^>]*?)(/?>)`);
  const m = xml.match(re);
  if (!m) return xml;
  let mid = m[2];
  mid = /\bs="/.test(mid) ? mid.replace(/\bs="[^"]*"/, ` s="${styleId}"`) : ` s="${styleId}"${mid}`;
  return xml.replace(re, `${m[1]}${mid}${m[3]}`);
}

/**
 * Build a complete minimal worksheet XML.
 * Optional `cols` lets you set per-column widths; `freezeRow`/`freezeCol`
 * freeze the rows above / columns left of the given 1-based indices.
 */
export function buildSheetXml(
  rows: string[],
  opts?: { cols?: Array<{ min: number; max: number; width: number }>; freezeRow?: number; freezeCol?: number },
): string {
  const filtered = rows.filter(Boolean);
  const colsXml = opts?.cols?.length
    ? `<cols>${opts.cols.map(c => `<col min="${c.min}" max="${c.max}" width="${c.width}" customWidth="1"/>`).join("")}</cols>`
    : "";
  let viewsXml = "";
  if (opts?.freezeRow || opts?.freezeCol) {
    const fr = opts.freezeRow ?? 0;
    const fc = opts.freezeCol ?? 0;
    const cl = (c: number): string => { let s = ""; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
    const tlc = `${cl(fc + 1)}${fr + 1}`;
    const split = fr && fc ? `xSplit="${fc}" ySplit="${fr}"` : fr ? `ySplit="${fr}"` : `xSplit="${fc}"`;
    viewsXml = `<sheetViews><sheetView workbookViewId="0"><pane ${split} topLeftCell="${tlc}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${viewsXml}${colsXml}<sheetData>${filtered.join("")}</sheetData>
</worksheet>`;
}

/** Convert an Excel column ("A","AA",…) to a 1-based number for sorting. */
export function colToNum(s: string): number {
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * Normalize a worksheet's <sheetData>: rows must be unique and in ascending
 * order, and cells within each row must be in ascending column order — Excel
 * rejects violations as corrupt ("we found a problem with some content") even
 * though JSZip/ExcelJS/openpyxl silently merge-and-sort them. Our patch path
 * appends new month rows before </sheetData>, which leaves them out of order
 * (and can duplicate existing row numbers), so run every output sheet through
 * this. Duplicate rows/cells keep the FIRST occurrence.
 */
export function sanitizeSheetXml(xml: string): string {
  const m = xml.match(/(<sheetData[^>]*>)([\s\S]*?)(<\/sheetData>)/);
  if (!m) return xml;
  const body = m[2];
  const rowRe = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  const seen = new Map<number, string>();
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(body)) !== null) {
    const rx = rm[0];
    const rn = parseInt(rx.match(/\br="(\d+)"/)?.[1] ?? "", 10);
    if (Number.isNaN(rn) || seen.has(rn)) continue; // keep first occurrence
    seen.set(rn, rx);
  }
  const sortedRows = [...seen.keys()].sort((a, b) => a - b).map((rn) => {
    const rx = seen.get(rn)!;
    const open = rx.match(/^<row\b[^>]*?>/)?.[0];
    if (!open || rx.endsWith("/>")) return rx; // self-closing row, no cells
    const inner = rx.slice(open.length, rx.length - "</row>".length);
    const cellRe = /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
    const cseen = new Map<string, string>();
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(inner)) !== null) {
      const col = cm[0].match(/\br="([A-Z]+)\d+"/)?.[1];
      if (!col || cseen.has(col)) continue;
      cseen.set(col, cm[0]);
    }
    const cells = [...cseen.keys()].sort((a, b) => colToNum(a) - colToNum(b)).map((c) => cseen.get(c)!);
    return open + cells.join("") + "</row>";
  });
  return xml.slice(0, m.index!) + m[1] + sortedRows.join("") + m[3] + xml.slice(m.index! + m[0].length);
}

/** Update a cell's value in existing sheet XML. Returns modified XML. */
export function xmlUpdateCell(xml: string, ref: string, newValue: number): string {
  // Match <c r="REF" ...>...<v>...</v>...</c> and replace the <v> content
  const cellRegex = new RegExp(`(<c\\s[^>]*r="${ref}"[^>]*>)([\\s\\S]*?)(</c>)`);
  const match = xml.match(cellRegex);
  if (match) {
    // Replace existing <v>...</v> or add one
    let inner = match[2];
    if (/<v>/.test(inner)) {
      inner = inner.replace(/<v>[^<]*<\/v>/, `<v>${newValue}</v>`);
    } else {
      inner += `<v>${newValue}</v>`;
    }
    return xml.replace(cellRegex, `${match[1]}${inner}${match[3]}`);
  }
  // Cell doesn't exist — can't insert without knowing the row structure. Handled by row insertion instead.
  return xml;
}

/** Parse the zip's sheet name → file path mapping */
export async function getZipSheetMap(zip: JSZip): Promise<Record<string, string>> {
  const wbFile = zip.file("xl/workbook.xml");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!wbFile || !relsFile) return {};
  const wbXml = await wbFile.async("string");
  const relsXml = await relsFile.async("string");

  const sheetEntries: { name: string; rId: string }[] = [];
  const sheetRegex = /<sheet[^>]+name="([^"]+)"[^>]+r:id="([^"]+)"[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = sheetRegex.exec(wbXml)) !== null) {
    sheetEntries.push({ name: m[1], rId: m[2] });
  }

  const relMap: Record<string, string> = {};
  const relRegex = /<Relationship[^>]+Id="([^"]+)"[^>]+Target="([^"]+)"[^>]*\/?>/g;
  while ((m = relRegex.exec(relsXml)) !== null) {
    relMap[m[1]] = m[2];
  }

  const result: Record<string, string> = {};
  for (const s of sheetEntries) {
    const target = relMap[s.rId];
    if (target) result[s.name] = "xl/" + target;
  }
  return result;
}

/**
 * Surgical xlsx write: modifies the original zip directly.
 * - patchedSheets: map of sheet name → new XML content (for modified/new sheets)
 * - deletedSheetNames: sheets to remove
 * No ExcelJS involved in the write path.
 */
export interface StyleIndices { general: string; currency: string; decimal: string; percent: string; bold: string; green: string; amber: string; red: string; currencyDash: string; currencyDashBold: string; }

export async function surgicalWriteXlsx(
  originalBuffer: Buffer,
  buildSheets: (styles: StyleIndices) => Record<string, string>,  // called after styles are injected
  deletedSheetNames: Set<string>,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(originalBuffer);
  const sheetMap = await getZipSheetMap(zip);

  let wbXml = await zip.file("xl/workbook.xml")!.async("string");
  let relsXml = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  let ctXml = await zip.file("[Content_Types].xml")!.async("string");

  // Add cell styles for our rebuilt sheets: General, Currency, Decimal,
  // Percent, Bold. Two hard-won rules baked in here:
  //  - Do NOT assume custom numFmt id 164 == "$#,##0.00". Rachel's workbook
  //    already defines 164 as a DATE format, so hardcoding it rendered every
  //    currency cell as a date. We REUSE an existing currency/decimal numFmt
  //    when present (her file has 166="$"#,##0.00 and 165=0.0) and only mint a
  //    fresh id above the max when absent — touching <numFmts> as little as
  //    possible.
  //  - NEVER build a String.replace REPLACEMENT string that can contain "$":
  //    JS expands $&/$1/$$ in replacements, and a "$" in a currency formatCode
  //    once injected "</numFmts>" into an attribute → invalid XML → Excel threw
  //    out styles.xml. All replacements below use function replacers (literal).
  const stylesFile = zip.file("xl/styles.xml");
  let newStyleIndices: StyleIndices = { general: "0", currency: "0", decimal: "0", percent: "0", bold: "0", green: "0", amber: "0", red: "0", currencyDash: "0", currencyDashBold: "0" };
  if (stylesFile) {
    let stylesXml = await stylesFile.async("string");

    // Catalogue existing numFmts (id + formatCode) and the max custom id.
    const fmts: Array<{ id: number; code: string }> = [];
    let maxFmtId = 163;
    for (const m of stylesXml.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g)) {
      fmts.push({ id: parseInt(m[1], 10), code: m[2] });
    }
    for (const m of stylesXml.matchAll(/numFmtId="(\d+)"/g)) {
      const id = parseInt(m[1], 10);
      if (id >= 164 && id < 10000 && id > maxFmtId) maxFmtId = id;
    }
    const findId = (re: RegExp) => fmts.find((f) => re.test(f.code))?.id;
    // Prefer a plain "$"#,##0.00; else any $ + thousands format.
    let curFmtId = findId(/^&quot;\$&quot;#,##0\.00$/) ?? findId(/\$.*#,##0/);
    let decFmtId = findId(/^0\.0$/);
    const toAdd: string[] = [];
    if (curFmtId == null) { curFmtId = ++maxFmtId; toAdd.push(`<numFmt numFmtId="${curFmtId}" formatCode="&quot;$&quot;#,##0.00"/>`); }
    if (decFmtId == null) { decFmtId = ++maxFmtId; toAdd.push(`<numFmt numFmtId="${decFmtId}" formatCode="0.0"/>`); }
    // Currency that renders exact zero as a dash: "$"#,##0.00 ; -"$"#,##0.00 ; "-"
    const dashFmtId = ++maxFmtId;
    toAdd.push(`<numFmt numFmtId="${dashFmtId}" formatCode="&quot;$&quot;#,##0.00;-&quot;$&quot;#,##0.00;&quot;-&quot;"/>`);
    if (toAdd.length) {
      const addStr = toAdd.join("");
      const nf = stylesXml.match(/<numFmts count="(\d+)">/);
      if (nf) {
        const newCount = parseInt(nf[1], 10) + toAdd.length;
        stylesXml = stylesXml.replace(`<numFmts count="${nf[1]}">`, () => `<numFmts count="${newCount}">`);
        stylesXml = stylesXml.replace("</numFmts>", () => addStr + "</numFmts>");
      } else {
        stylesXml = stylesXml.replace(/<styleSheet\b[^>]*>/, (m0) => `${m0}<numFmts count="${toAdd.length}">${addStr}</numFmts>`);
      }
    }

    // Find a bold font id (a <font> containing <b/>); fall back to 1.
    let boldFontId = 1;
    const fontsMatch = stylesXml.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/);
    if (fontsMatch) {
      const fonts = fontsMatch[1].match(/<font\b[^>]*\/>|<font\b[^>]*>[\s\S]*?<\/font>/g) ?? [];
      const idx = fonts.findIndex((f) => /<b\s*\/>|<b>/.test(f));
      if (idx >= 0) boldFontId = idx;
    }

    const xfCountMatch = stylesXml.match(/<cellXfs count="(\d+)">/);
    if (xfCountMatch) {
      const currentCount = parseInt(xfCountMatch[1], 10);

      // Add 3 solid pattern fills (green / amber / red) for on/off-goal coloring,
      // and remember their fillIds. Append to <fills count="F"> and bump count
      // (function replacer — no "$" footgun; these strings have no "$").
      let fillGreen = 0, fillAmber = 0, fillRed = 0;
      const fillsMatch = stylesXml.match(/<fills count="(\d+)">/);
      if (fillsMatch) {
        const fc = parseInt(fillsMatch[1], 10);
        fillGreen = fc; fillAmber = fc + 1; fillRed = fc + 2;
        const mkFill = (rgb: string) => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
        const addFills = mkFill("FFC6EFCE") + mkFill("FFFFEB9C") + mkFill("FFFFC7CE"); // green, amber, red
        stylesXml = stylesXml.replace(`<fills count="${fc}">`, () => `<fills count="${fc + 3}">`);
        stylesXml = stylesXml.replace("</fills>", () => addFills + "</fills>");
      }

      const newXfs = [
        `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,                       // General
        `<xf numFmtId="${curFmtId}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,            // currency
        `<xf numFmtId="${decFmtId}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,            // 0.0
        `<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,                      // 0.00% (builtin)
        `<xf numFmtId="0" fontId="${boldFontId}" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>`, // Bold
        // Currency + on/off-goal fill (green / amber / red).
        `<xf numFmtId="${curFmtId}" fontId="0" fillId="${fillGreen}" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>`,
        `<xf numFmtId="${curFmtId}" fontId="0" fillId="${fillAmber}" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>`,
        `<xf numFmtId="${curFmtId}" fontId="0" fillId="${fillRed}" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>`,
        // Dash-zero currency (plain + bold) for the collections-by-matter tab.
        `<xf numFmtId="${dashFmtId}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
        `<xf numFmtId="${dashFmtId}" fontId="${boldFontId}" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>`,
      ];
      newStyleIndices = {
        general: String(currentCount),
        currency: String(currentCount + 1),
        decimal: String(currentCount + 2),
        percent: String(currentCount + 3),
        bold: String(currentCount + 4),
        green: String(currentCount + 5),
        amber: String(currentCount + 6),
        red: String(currentCount + 7),
        currencyDash: String(currentCount + 8),
        currencyDashBold: String(currentCount + 9),
      };
      const newXfCount = currentCount + newXfs.length;
      stylesXml = stylesXml.replace(`<cellXfs count="${currentCount}">`, () => `<cellXfs count="${newXfCount}">`);
      stylesXml = stylesXml.replace("</cellXfs>", () => newXfs.join("") + "</cellXfs>");
    }
    zip.file("xl/styles.xml", stylesXml);
  }

  // Find max IDs for adding new sheets
  let maxSheetNum = 0;
  for (const f of Object.keys(zip.files)) {
    const m = f.match(/^xl\/worksheets\/sheet(\d+)\.xml$/);
    if (m) { const n = parseInt(m[1]); if (n > maxSheetNum) maxSheetNum = n; }
  }
  let maxRid = 0;
  for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) {
    const n = parseInt(m[1]); if (n > maxRid) maxRid = n;
  }
  let maxSheetId = 0;
  for (const m of wbXml.matchAll(/sheetId="(\d+)"/g)) {
    const n = parseInt(m[1]); if (n > maxSheetId) maxSheetId = n;
  }

  // Build the patched sheets now that styles are available
  const patchedSheets = buildSheets(newStyleIndices);

  // Process patched sheets
  for (const [name, rawXml] of Object.entries(patchedSheets)) {
    const xml = sanitizeSheetXml(rawXml); // enforce unique + sorted rows/cells
    const existingPath = sheetMap[name];
    if (existingPath) {
      // Replace existing sheet XML
      zip.file(existingPath, xml);
    } else {
      // Add new sheet
      maxSheetNum++; maxRid++; maxSheetId++;
      const fileName = `sheet${maxSheetNum}.xml`;
      const filePath = `xl/worksheets/${fileName}`;
      const rid = `rId${maxRid}`;

      zip.file(filePath, xml);
      wbXml = wbXml.replace("</sheets>", `<sheet name="${xmlEsc(name)}" sheetId="${maxSheetId}" r:id="${rid}"/></sheets>`);
      relsXml = relsXml.replace("</Relationships>", `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${fileName}"/></Relationships>`);
      ctXml = ctXml.replace("</Types>", `<Override PartName="/xl/worksheets/${fileName}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
    }
  }

  // Remove deleted sheets: drop the worksheet part, its _rels, and the
  // workbook <sheet> entry. The dangling workbook relationship and
  // content-type override left behind are cleaned up by the integrity sweep
  // below (which also heals any orphans already baked into the input file).
  for (const delName of deletedSheetNames) {
    // Never delete a sheet we just (re)wrote — the broad "bonus" name match
    // would otherwise remove the freshly-patched Bonus Config / Bonus Tracker.
    if (delName in patchedSheets) continue;
    const path = sheetMap[delName];
    if (!path) continue;
    zip.remove(path);
    const relsPath = path.replace("worksheets/", "worksheets/_rels/") + ".rels";
    if (zip.file(relsPath)) zip.remove(relsPath);
    const esc = delName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    wbXml = wbXml.replace(new RegExp(`<sheet[^>]+name="${esc}"[^>]*/?>`, "g"), "");
  }

  // Drop calcChain.xml. It records a calculation order keyed by sheetId, and we
  // both rewrite formula cell values and add new SUM formulas (plus delete
  // sheets) — leaving the stale chain in place makes it reference cells in
  // sheets that no longer exist, which Excel reports as corrupt. Excel rebuilds
  // the calc chain automatically on open, so removing it is safe.
  if (zip.file("xl/calcChain.xml")) zip.remove("xl/calcChain.xml");

  // Integrity sweep: drop any workbook relationship or content-type override
  // that points to a part no longer present in the package. This heals dangling
  // references from sheets (and calcChain) removed this run AND any orphans a
  // prior run already baked into the downloaded file — either makes Excel flag
  // the workbook as corrupt ("we found a problem with some content").
  const partPresent = (zipPath: string): boolean => zip.file(zipPath) != null;
  relsXml = relsXml.replace(/<Relationship\b[^>]*\/>/g, (rel) => {
    if (/TargetMode="External"/.test(rel)) return rel;
    const tgt = rel.match(/Target="([^"]+)"/)?.[1];
    if (!tgt || /^https?:/i.test(tgt)) return rel;
    return partPresent("xl/" + tgt.replace(/^\.\//, "")) ? rel : "";
  });
  ctXml = ctXml.replace(/<Override\b[^>]*\/>/g, (ov) => {
    const part = ov.match(/PartName="([^"]+)"/)?.[1];
    if (!part) return ov;
    return partPresent(part.replace(/^\//, "")) ? ov : "";
  });

  // Force Excel to recalc every formula on open. We write VALUES into input
  // cells; the rate/total formulas that reference them keep stale cached <v>
  // values until a recalc. Setting calcId="0" + fullCalcOnLoad="1" makes Excel
  // do a full recalculation the moment the file opens — no manual Ctrl+Alt+F9.
  if (/<calcPr\b/.test(wbXml)) {
    wbXml = wbXml.replace(/<calcPr\b[^>]*\/>/, (m) => {
      const attrs = m.slice("<calcPr".length, -2)
        .replace(/\s*calcId="[^"]*"/, "")
        .replace(/\s*fullCalcOnLoad="[^"]*"/, "");
      return `<calcPr calcId="0" fullCalcOnLoad="1"${attrs}/>`;
    });
  } else {
    const cp = `<calcPr calcId="0" fullCalcOnLoad="1"/>`;
    if (/<\/definedNames>/.test(wbXml)) wbXml = wbXml.replace("</definedNames>", () => "</definedNames>" + cp);
    else if (/<\/sheets>/.test(wbXml)) wbXml = wbXml.replace("</sheets>", () => "</sheets>" + cp);
    else wbXml = wbXml.replace("</workbook>", () => cp + "</workbook>");
  }

  zip.file("xl/workbook.xml", wbXml);
  zip.file("xl/_rels/workbook.xml.rels", relsXml);
  zip.file("[Content_Types].xml", ctXml);

  // Strip directory entries. Adding new parts (e.g. xl/worksheets/sheetN.xml)
  // makes JSZip synthesize folder objects ("xl/", "xl/worksheets/"), which it
  // then emits as explicit zip entries whose names end in "/". A package part
  // name ending in "/" is invalid per OPC, and Excel reports the workbook as
  // corrupt (other readers/JSZip tolerate it). Real .xlsx packages contain no
  // directory entries, so remove them before serializing.
  for (const name of Object.keys(zip.files)) {
    if ((zip.files[name] as any).dir) delete zip.files[name];
  }

  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}
