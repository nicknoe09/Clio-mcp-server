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

/** Highest <row r="N"> number present in a worksheet XML (0 when none). */
export function maxRowNumber(xml: string): number {
  let max = 0;
  for (const m of xml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

/**
 * Compute a per-month firm rate for a month-blocked tab (Utilization /
 * Realization). For every month block, each attorney row's own rate is derived
 * from the numeric hour columns via `rateFn` (NOT read from the tab's rate-column
 * FORMULAS, whose cached values are stale until Excel recalculates). `rateFn`
 * returns null for a row that should be excluded (e.g. an inactive timekeeper
 * with a zero denominator), so those rows never distort the firm figure.
 *
 * `mode` picks how the block's firm figure is derived:
 *  - "mean" (default): the simple MEAN of the listed billers' own rates.
 *  - "totals": `rateFn` applied to the SUM of the hour columns across the listed
 *    billers — the same formula as an individual row, computed on firm totals.
 *    A mean-of-rates overweights low-volume billers (a timekeeper with 0.5
 *    billed hours at 100% counts the same as one with 150 hours at 80%), which
 *    overstated the Realization firm average; totals weights each biller by
 *    volume and reconciles with the tab's own per-month "Total" row.
 *
 * Shares the exact block-scan rules of findTabMonthBlock (col A month label, col
 * B initials, block ends on blank/"EMPLOYEE"/"TOTAL"). When a sheet holds the
 * same month more than once (multi-year), the LAST block with data for that
 * month wins.
 */
export function firmAvgRateByMonth(
  xml: string,
  sharedStrings: string[],
  numCols: string[],
  rateFn: (vals: Record<string, number>) => number | null,
  mode: "mean" | "totals" = "mean",
): Array<{ monthAbbr: string; avgRate: number; billers: number }> {
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
  const cellNum = (rowXml: string, col: string): number => {
    const re = new RegExp(`(<c\\b[^>]*\\br="${col}\\d+"[^>]*>)([\\s\\S]*?)</c>`);
    const m = rowXml.match(re);
    if (!m) return 0; // missing/self-closing cell → treat as 0
    if (/\bt="s"/.test(m[1])) return 0; // a string in a numeric column → 0
    const v = m[2].match(/<v>([\s\S]*?)<\/v>/);
    if (!v) return 0;
    const f = parseFloat(v[1]);
    return Number.isFinite(f) ? f : 0;
  };

  const rows: Array<{ body: string }> = [];
  const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  const ordered: Array<{ n: number; body: string }> = [];
  while ((rm = rowRe.exec(xml)) !== null) ordered.push({ n: parseInt(rm[1], 10), body: rm[2] });
  ordered.sort((a, b) => a.n - b.n);
  for (const o of ordered) rows.push({ body: o.body });

  // Most-recent block per month (keyed by month abbr) → {sum, count, totals}.
  type Acc = { sum: number; count: number; totals: Record<string, number> };
  const acc = new Map<string, Acc>();
  let cur: ({ abbr: string } & Acc) | null = null;
  const flush = () => { if (cur && cur.count > 0) acc.set(cur.abbr, { sum: cur.sum, count: cur.count, totals: cur.totals }); };
  for (const { body } of rows) {
    const a3 = cellText(body, "A").trim().toUpperCase().slice(0, 3);
    const b = cellText(body, "B").trim().toUpperCase();
    if (MONTH_ABBRS.includes(a3)) { flush(); cur = { abbr: a3, sum: 0, count: 0, totals: {} }; continue; }
    if (!cur) continue;
    if (b === "" || b === "EMPLOYEE" || b === "TOTAL") { flush(); cur = null; continue; }
    const vals: Record<string, number> = {};
    for (const c of numCols) vals[c] = cellNum(body, c);
    const rate = rateFn(vals);
    if (rate == null || !Number.isFinite(rate)) continue;
    cur.sum += rate;
    cur.count += 1;
    for (const c of numCols) cur.totals[c] = (cur.totals[c] ?? 0) + vals[c];
  }
  flush();

  return MONTH_ABBRS
    .filter((abbr) => acc.has(abbr))
    .map((abbr) => {
      const a = acc.get(abbr)!;
      const totalsRate = mode === "totals" ? rateFn(a.totals) : null;
      const avgRate = mode === "totals"
        ? (totalsRate != null && Number.isFinite(totalsRate) ? totalsRate : 0)
        : a.sum / a.count;
      return { monthAbbr: abbr, avgRate, billers: a.count };
    });
}

/** Append extra <row> XML just before </sheetData>. No-op for empty input. */
export function appendRowsBeforeSheetClose(xml: string, rowsXml: string[]): string {
  const body = rowsXml.filter(Boolean).join("");
  if (!body) return xml;
  return xml.replace("</sheetData>", body + "</sheetData>");
}

/**
 * Remove a previously-appended auto-generated block (and everything after it)
 * from <sheetData>, identified by a marker string carried in one of its cells.
 * Idempotency helper: strip last run's table before appending a fresh one so it
 * never accumulates. Handles the marker stored either as an inline string (how
 * we write it) or — should Excel re-save the file — as a shared string. No-op
 * when the marker is absent.
 */
export function stripRowsFromMarker(xml: string, marker: string, sharedStrings: string[]): string {
  let idx = xml.indexOf(marker);
  if (idx === -1) {
    const ssIdx = sharedStrings.findIndex((s) => s.includes(marker));
    if (ssIdx !== -1) {
      const m = xml.match(new RegExp(`<c\\b[^>]*\\bt="s"[^>]*>\\s*<v>${ssIdx}</v>`));
      if (m && m.index != null) idx = m.index;
    }
  }
  if (idx === -1) return xml;
  const rowStart = xml.lastIndexOf("<row", idx);
  if (rowStart === -1) return xml;
  const close = xml.indexOf("</sheetData>", rowStart);
  if (close === -1) return xml;
  return xml.slice(0, rowStart) + xml.slice(close);
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
export const STYLE_CURB  = "__CURB__";  // currency, bold (total / YTD columns)
export const STYLE_PCTB  = "__PCTB__";  // percent, bold (headline rates)
export const STYLE_HDR   = "__HDR__";   // bold + light fill (block / column headers)

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
 * Shift every RELATIVE cell reference in an A1-style formula by (dRow, dCol),
 * honoring $ anchors ($A5 keeps its column, A$5 keeps its row). Skips text
 * inside "…" string literals and '…' quoted sheet names, and refuses tokens
 * that only look like refs (function names such as LOG10, columns past XFD).
 * A reference shifted off the sheet becomes #REF!, matching Excel.
 */
export function translateFormulaRefs(formula: string, dRow: number, dCol: number): string {
  let out = "";
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"' || ch === "'") {
      // String literal / quoted sheet name — copy verbatim ("" and '' escape).
      let j = i + 1;
      while (j < formula.length) {
        if (formula[j] === ch) {
          if (formula[j + 1] === ch) { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      out += formula.slice(i, j);
      i = j;
      continue;
    }
    const m = /^(\$?)([A-Z]{1,3})(\$?)(\d+)/.exec(formula.slice(i));
    if (m) {
      const colNum = colToNum(m[2]);
      const rowNum = parseInt(m[4], 10);
      const prev = out[out.length - 1] ?? "";
      const next = formula[i + m[0].length] ?? "";
      const isRef =
        colNum <= 16384 && rowNum >= 1 && rowNum <= 1048576 && // real sheet coords (≤XFD / ≤1048576)
        !/[A-Za-z0-9_.$]/.test(prev) &&                        // not the tail of a name/number
        !/[A-Za-z0-9_(]/.test(next);                           // not a function call / longer name
      if (isRef) {
        const newCol = m[1] ? colNum : colNum + dCol;
        const newRow = m[3] ? rowNum : rowNum + dRow;
        out += newCol < 1 || newCol > 16384 || newRow < 1 || newRow > 1048576
          ? "#REF!"
          : `${m[1]}${colLetter(newCol)}${m[3]}${newRow}`;
        i += m[0].length;
        continue;
      }
      out += m[0]; // looked ref-shaped but isn't — copy whole token so we can't re-match inside it
      i += m[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Rewrite a worksheet's shared formulas (<f t="shared" si="N">) as ordinary
 * per-cell formulas. A shared group stores its formula text ONLY on the master
 * cell; follower cells carry just si="N". Our patch path strips <f> from any
 * cell it writes a value into, and stripping a MASTER orphans every follower —
 * Excel then repairs the file with "Removed Records: Shared formula" (the
 * sheet3 corruption in the recovery log). Expanding first makes each cell
 * self-contained, so dropping any one formula can never break another cell.
 *
 * Followers get the master's formula with relative refs shifted by their
 * offset (what Excel does implicitly). Already-orphaned followers — an si with
 * no master left, i.e. corruption baked in by an earlier run — lose the dead
 * <f> and keep their cached <v> as a plain value. With `orphansOnly` set, only
 * that healing happens and intact shared groups are left untouched (used on
 * the download/repair path to avoid rewriting sheets we aren't patching).
 */
export function expandSharedFormulas(xml: string, opts?: { orphansOnly?: boolean }): string {
  if (!xml.includes('t="shared"')) return xml;
  const cellRe = /<c\b[^>]*?\br="([A-Z]+)(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g;

  // Pass 1: master formula per si (the <f t="shared"> that carries text).
  const masters = new Map<string, { col: number; row: number; formula: string }>();
  let cm: RegExpExecArray | null;
  while ((cm = cellRe.exec(xml)) !== null) {
    const inner = cm[3];
    if (inner == null || !inner.includes('t="shared"')) continue;
    const fm = inner.match(/<f\b([^>]*)>([\s\S]*?)<\/f>/);
    if (!fm || !/\bt="shared"/.test(fm[1]) || fm[2].trim() === "") continue;
    const si = fm[1].match(/\bsi="([^"]*)"/)?.[1];
    if (si != null && !masters.has(si)) {
      masters.set(si, { col: colToNum(cm[1]), row: parseInt(cm[2], 10), formula: fm[2] });
    }
  }

  // Pass 2: unshare masters, materialize followers, drop orphans.
  return xml.replace(cellRe, (cell, colL: string, rowS: string, inner?: string) => {
    if (inner == null || !inner.includes('t="shared"')) return cell;
    const newInner = inner.replace(/<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/g, (f, attrs: string, content?: string) => {
      if (!/\bt="shared"/.test(attrs)) return f;
      const si = attrs.match(/\bsi="([^"]*)"/)?.[1];
      if (content != null && content.trim() !== "") {
        return opts?.orphansOnly ? f : `<f>${content}</f>`; // master: keep its formula, drop sharing
      }
      const master = si != null ? masters.get(si) : undefined;
      if (!master) return ""; // orphaned follower: drop dead <f>, cached <v> stays as the value
      if (opts?.orphansOnly) return f;
      const dRow = parseInt(rowS, 10) - master.row;
      const dCol = colToNum(colL) - master.col;
      // Refs shift on the unescaped text ('"' not '&quot;'), then re-escape.
      return `<f>${xmlEsc(translateFormulaRefs(xmlUnesc(master.formula), dRow, dCol))}</f>`;
    });
    if (newInner === inner) return cell;
    return cell.slice(0, cell.length - inner.length - "</c>".length) + newInner + "</c>";
  });
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
export interface StyleIndices { general: string; currency: string; decimal: string; percent: string; bold: string; green: string; amber: string; red: string; currencyDash: string; currencyDashBold: string; currencyBold: string; percentBold: string; header: string; }

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
  let newStyleIndices: StyleIndices = { general: "0", currency: "0", decimal: "0", percent: "0", bold: "0", green: "0", amber: "0", red: "0", currencyDash: "0", currencyDashBold: "0", currencyBold: "0", percentBold: "0", header: "0" };
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
      let fillGreen = 0, fillAmber = 0, fillRed = 0, fillHdr = 0;
      const fillsMatch = stylesXml.match(/<fills count="(\d+)">/);
      if (fillsMatch) {
        const fc = parseInt(fillsMatch[1], 10);
        fillGreen = fc; fillAmber = fc + 1; fillRed = fc + 2; fillHdr = fc + 3;
        const mkFill = (rgb: string) => `<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
        // green, amber, red, then a neutral header tint
        const addFills = mkFill("FFC6EFCE") + mkFill("FFFFEB9C") + mkFill("FFFFC7CE") + mkFill("FFE7EAF0");
        stylesXml = stylesXml.replace(`<fills count="${fc}">`, () => `<fills count="${fc + 4}">`);
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
        // Appended LAST so the indices above keep their positions.
        `<xf numFmtId="${curFmtId}" fontId="${boldFontId}" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>`,  // currency bold
        `<xf numFmtId="10" fontId="${boldFontId}" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>`,            // percent bold
        `<xf numFmtId="0" fontId="${boldFontId}" fillId="${fillHdr}" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>`, // header
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
        currencyBold: String(currentCount + 10),
        percentBold: String(currentCount + 11),
        header: String(currentCount + 12),
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
    // Expand shared formulas so no written sheet can carry an si="N" follower
    // whose master a patch removed (Excel repairs that as a corrupt sheet),
    // then enforce unique + sorted rows/cells.
    const xml = sanitizeSheetXml(expandSharedFormulas(rawXml));
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

// Repair a downloaded .xlsx so ExcelJS can load it even when a prior
// programmatic write left a shared-string reference out of range (a cell with
// t="s" whose <v> index points past the end of sharedStrings.xml). ExcelJS
// crashes on that with "Cannot read properties of undefined (reading 'richText')"
// in CellXform.reconcile. We pad sharedStrings with empty <si> entries so those
// refs resolve to "" instead of undefined. No-op (returns the original buffer)
// when every reference is already in range or anything looks unexpected.
export async function sanitizeXlsxBuffer(buf: Buffer): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(buf);
    let changed = false;

    // (A) Self-heal a styles.xml corrupted by the old String.replace "$&"
    // footgun: a currency formatCode "$" was expanded to the matched text
    // "</numFmts>", leaving e.g. formatCode="&quot;</numFmts>quot;#,##0.00",
    // which contains '<' in an attribute → invalid XML → Excel discards
    // styles.xml (and cascades cell/table repairs). Undo the injection.
    const stylesFile = zip.file("xl/styles.xml");
    if (stylesFile) {
      let styles = await stylesFile.async("string");
      if (styles.includes("&quot;</numFmts>quot;")) {
        styles = styles.split("&quot;</numFmts>quot;").join("&quot;$&quot;");
        zip.file("xl/styles.xml", styles);
        changed = true;
        console.warn('[Dashboard] sanitizeXlsxBuffer: healed corrupted styles.xml ("$&" numFmt injection)');
      }
    }

    // (B) Heal orphaned shared formulas a prior write baked in: a follower cell
    // still says <f t="shared" si="N"/> but the group's master <f> (the one
    // carrying the formula text) was stripped by a value write. Excel repairs
    // that as "Removed Records: Shared formula from /xl/worksheets/sheetN.xml".
    // orphansOnly leaves intact shared groups alone so untouched sheets don't
    // get rewritten; the dead <f> is dropped and the cached <v> survives.
    for (const name of Object.keys(zip.files)) {
      if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
      const wsXml = await zip.file(name)!.async("string");
      if (!wsXml.includes('t="shared"')) continue;
      const healed = expandSharedFormulas(wsXml, { orphansOnly: true });
      if (healed !== wsXml) {
        zip.file(name, healed);
        changed = true;
        console.warn(`[Dashboard] sanitizeXlsxBuffer: removed orphaned shared-formula refs in ${name}`);
      }
    }

    // (C) Pad sharedStrings to cover any out-of-range refs (the original repair).
    const ssFile = zip.file("xl/sharedStrings.xml");
    if (ssFile) {
      let ss = await ssFile.async("string");
      const siCount = (ss.match(/<si(?:\s[^>]*)?>/g) || []).length;
      let maxIdx = -1;
      for (const name of Object.keys(zip.files)) {
        if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
        const xml = await zip.file(name)!.async("string");
        const re = /<c\b[^>]*\bt="s"[^>]*>\s*<v>(\d+)<\/v>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(xml))) { const idx = parseInt(m[1], 10); if (idx > maxIdx) maxIdx = idx; }
      }
      if (maxIdx >= siCount && /<\/sst>/.test(ss)) {
        const pad = maxIdx - siCount + 1;
        ss = ss.replace("</sst>", () => "<si><t></t></si>".repeat(pad) + "</sst>");
        ss = ss.replace(/(<sst\b[^>]*\buniqueCount=")(\d+)(")/, (_s, a, _n, c) => a + (siCount + pad) + c);
        zip.file("xl/sharedStrings.xml", ss);
        changed = true;
        console.warn(`[Dashboard] sanitizeXlsxBuffer: padded sharedStrings by ${pad} (had ${siCount}, max ref ${maxIdx})`);
      }
    }

    return changed ? await zip.generateAsync({ type: "nodebuffer" }) : buf;
  } catch (e: any) {
    console.warn(`[Dashboard] sanitizeXlsxBuffer skipped: ${e?.message ?? e}`);
    return buf;
  }
}

// Excel column number (1-based) -> letter(s): 1->A, 27->AA.
export           const colLetter = (c: number): string => {
            let s = "";
            while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
            return s;
          };

          // Helper: write a numeric value into a cell in the XML.
          // Handles BOTH self-closing/empty cells (<c r="C43" s="62"/>) and cells
          // with content (<c r="D5" s="7"><v>0</v></c>). The empty-tab target
          // cells are self-closing; the old single-regex version required </c>
          // and so over-matched past a self-closing cell into the NEXT cell's
          // </c>, fusing cells and dumping the value into the wrong column.
          export function patchCell(xml: string, ref: string, val: number): string {
            // 0) Shared formulas first: stripping <f> from a cell that MASTERS a
            //    shared group (<f t="shared" ref="…" si="N">…</f>) orphans every
            //    follower cell's si="N" and Excel repairs the sheet with
            //    "Removed Records: Shared formula". Expand the whole sheet to
            //    plain per-cell formulas once (no-op after the first call), so
            //    the strip below can never take out another cell's formula.
            if (xml.includes('t="shared"')) xml = expandSharedFormulas(xml);
            // 1) self-closing empty cell — turn it into a value cell (preserve
            //    style, drop any t="…" so the number isn't read as a string idx).
            const selfRe = new RegExp(`<c\\b([^>]*?)\\br="${ref}"([^>]*?)/>`);
            const sm = xml.match(selfRe);
            if (sm) {
              const attrs = `${sm[1]} r="${ref}"${sm[2]}`.replace(/\s+t="[^"]*"/g, "").replace(/\s+/g, " ").trim();
              return xml.replace(selfRe, `<c ${attrs}><v>${val}</v></c>`);
            }
            // 2) cell with content — replace/insert its <v> (lazy match to its
            //    own </c>; safe because self-closing was handled above).
            const fullRe = new RegExp(`(<c\\b[^>]*\\br="${ref}"[^>]*>)([\\s\\S]*?)(</c>)`);
            const m = xml.match(fullRe);
            if (m) {
              const open = m[1].replace(/\s+t="[^"]*"/g, ""); // numeric write: drop t="s"/"e"/"str"
              let inner = m[2];
              // Drop any stale formula in the cell so an open-time recalc can't
              // overwrite the value we're writing (e.g. a "Total" column that used
              // to be a formula referencing a now-stale source). A plain value cell
              // has no <f>, so this is a no-op for the usual data-cell writes.
              inner = inner.replace(/<f\b[^>]*\/>/g, "").replace(/<f\b[^>]*>[\s\S]*?<\/f>/g, "");
              if (/<v>/.test(inner)) inner = inner.replace(/<v>[\s\S]*?<\/v>/, `<v>${val}</v>`);
              else inner += `<v>${val}</v>`;
              return xml.replace(fullRe, `${open}${inner}${m[3]}`);
            }
            // 3) Cell ABSENT from its row — INSERT it in column order.
            //    Excel omits never-styled empty cells from the XML entirely, so a
            //    patch tool that can only rewrite existing cells silently DROPS
            //    data written to such cells (found live 2026-08: KES's Jan–Mar
            //    col-V cells and JPB/SAB/NRB rows' data cells didn't exist, so
            //    their collections were computed and then lost — the old
            //    `return xml` no-op below case 2). Style is borrowed from the
            //    nearest row's cell in the SAME column so number formats stay
            //    column-consistent; cells must stay in ascending column order or
            //    Excel repairs the sheet.
            const colL = ref.match(/^[A-Z]+/)?.[0] ?? "";
            const rowN = parseInt(ref.slice(colL.length), 10);
            if (!colL || !Number.isFinite(rowN)) return xml;
            const rowRe = new RegExp(`(<row\\b[^>]*\\br="${rowN}"[^>]*?)(/>|>([\\s\\S]*?)</row>)`);
            const rm = xml.match(rowRe);
            if (!rm) return xml; // whole row absent — block-creation paths own new rows
            let sAttr = "";
            for (let d = 1; d <= 40 && !sAttr; d++) {
              for (const rr of [rowN - d, rowN + d]) {
                if (rr < 1) continue;
                const nm = xml.match(new RegExp(`<c\\b[^>]*\\br="${colL}${rr}"[^>]*?\\bs="(\\d+)"`));
                if (nm) { sAttr = ` s="${nm[1]}"`; break; }
              }
            }
            const newCell = `<c r="${ref}"${sAttr}><v>${val}</v></c>`;
            if (rm[2] === "/>") {
              // self-closing empty row → give it a body holding just this cell
              return xml.replace(rowRe, () => `${rm[1]}>${newCell}</row>`);
            }
            const target = colToNum(colL);
            let cells = rm[3];
            const cellIter = /<c\b[^>]*?\br="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
            let insertAt = cells.length;
            let cm: RegExpExecArray | null;
            while ((cm = cellIter.exec(cells))) {
              if (colToNum(cm[1]) > target) { insertAt = cm.index; break; }
            }
            cells = cells.slice(0, insertAt) + newCell + cells.slice(insertAt);
            // Replacer FUNCTION so "$"-sequences in existing cell content can't be
            // interpreted as replacement patterns.
            return xml.replace(rowRe, () => `${rm[1]}>${cells}</row>`);
          }

          // Read a cell's value as a string from worksheet XML (resolves shared
          // strings; returns the cached value for a formula cell). Returns "" when
          // the cell is absent or empty. Mirrors findTabMonthBlock's internal cell
          // reader so callers can pull an existing value (e.g. the "Available Hours"
          // column) to compute a dependent column before writing it back.
          export function readCell(xml: string, ref: string, sharedStrings: string[]): string {
            const re = new RegExp(`(<c\\b[^>]*\\br="${ref}"[^>]*>)([\\s\\S]*?)</c>`);
            const m = xml.match(re);
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
          }
