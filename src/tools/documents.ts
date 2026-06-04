import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, downloadReport, rawGetSingle, rawPostSingle } from "../clio/pagination";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageBreak, PageNumber, LevelFormat,
} from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { uploadToBox, downloadFromBox } from "../utils/box";
import { registerDownload, mimeForFilename } from "../utils/downloadStore";

// ========== XLSX DIRECT XML HELPERS ==========
// ExcelJS is only used for READING. All writes go through direct XML manipulation.

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Build a single <c> element */
function xmlCell(ref: string, value: number | string | null | undefined, opts?: { style?: string; formula?: string }): string {
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
function xmlRow(rowNum: number, cells: string[]): string {
  const filtered = cells.filter(Boolean);
  if (filtered.length === 0) return "";
  return `<row r="${rowNum}">${filtered.join("")}</row>`;
}

/** Build a complete minimal worksheet XML */
function buildSheetXml(rows: string[]): string {
  const filtered = rows.filter(Boolean);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetData>${filtered.join("")}</sheetData>
</worksheet>`;
}

/** Convert an Excel column ("A","AA",…) to a 1-based number for sorting. */
function colToNum(s: string): number {
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
function sanitizeSheetXml(xml: string): string {
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
function xmlUpdateCell(xml: string, ref: string, newValue: number): string {
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
async function getZipSheetMap(zip: JSZip): Promise<Record<string, string>> {
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
interface StyleIndices { general: string; currency: string; decimal: string; percent: string; bold: string; }

async function surgicalWriteXlsx(
  originalBuffer: Buffer,
  buildSheets: (styles: StyleIndices) => Record<string, string>,  // called after styles are injected
  deletedSheetNames: Set<string>,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(originalBuffer);
  const sheetMap = await getZipSheetMap(zip);

  let wbXml = await zip.file("xl/workbook.xml")!.async("string");
  let relsXml = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  let ctXml = await zip.file("[Content_Types].xml")!.async("string");

  // Add custom styles to the workbook for new sheets (original default is a date format!)
  // Append General, Currency, Decimal, and Percent styles to cellXfs
  const stylesFile = zip.file("xl/styles.xml");
  let newStyleIndices = { general: "0", currency: "0", decimal: "0", percent: "0", bold: "0" };
  if (stylesFile) {
    let stylesXml = await stylesFile.async("string");
    // Find current cellXfs count
    const xfCountMatch = stylesXml.match(/<cellXfs count="(\d+)">/);
    if (xfCountMatch) {
      const currentCount = parseInt(xfCountMatch[1]);
      // Append 5 new xf entries: General (0), Currency (164), Decimal (165), Percent (10), Bold General
      const newXfs = [
        `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,          // General
        `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,        // $#,##0.00
        `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,        // 0.0
        `<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,         // 0.00%
        `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>`, // Bold General
      ];
      newStyleIndices = {
        general: String(currentCount),
        currency: String(currentCount + 1),
        decimal: String(currentCount + 2),
        percent: String(currentCount + 3),
        bold: String(currentCount + 4),
      };
      stylesXml = stylesXml.replace(
        `<cellXfs count="${currentCount}">`,
        `<cellXfs count="${currentCount + newXfs.length}">`
      );
      stylesXml = stylesXml.replace("</cellXfs>", newXfs.join("") + "</cellXfs>");
      zip.file("xl/styles.xml", stylesXml);
    }
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

// ========== SHARED HELPERS ==========

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round1(n: number): number { return Math.round(n * 10) / 10; }
function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---- docx table helpers ----
const border = { style: BorderStyle.SINGLE, size: 1, color: "999999" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };
const TW = 9360;

function $(text: string, opts: any = {}) {
  return new TextRun({ text, font: "Arial", size: 20, ...opts });
}

function makePara(text?: string, opts: any = {}) {
  const children = text ? [$(text, { bold: opts.bold, size: opts.size || 20, color: opts.color })] : opts.runs || [];
  return new Paragraph({ children, spacing: { after: opts.spacingAfter ?? 120, before: opts.spacingBefore }, alignment: opts.alignment });
}

function makeDocxTable(headers: string[], rows: string[][], colWidths: number[]) {
  const headerRow = new TableRow({
    children: headers.map((h, i) => new TableCell({
      borders, width: { size: colWidths[i], type: WidthType.DXA }, margins: cellMargins,
      shading: { fill: "2E4057", type: ShadingType.CLEAR },
      children: [new Paragraph({ alignment: i > 0 ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [$(h, { bold: true, color: "FFFFFF", size: 18 })] })],
    })),
  });

  const dataRows = rows.map(row => {
    const isTotalRow = ["Total", "YTD", "Tier", "Subtotal"].some(kw => String(row[0]).includes(kw));
    return new TableRow({
      children: row.map((cell, i) => new TableCell({
        borders, width: { size: colWidths[i], type: WidthType.DXA }, margins: cellMargins,
        shading: isTotalRow ? { fill: "E8EDF2", type: ShadingType.CLEAR } : undefined,
        children: [new Paragraph({ alignment: i > 0 ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [$(String(cell ?? ""), { bold: isTotalRow, size: 18 })] })],
      })),
    });
  });

  return new Table({ width: { size: TW, type: WidthType.DXA }, columnWidths: colWidths, rows: [headerRow, ...dataRows] });
}

function pageBreak() { return new Paragraph({ children: [new PageBreak()] }); }
function spacer() { return new Paragraph({ spacing: { after: 80 } }); }
function h2(text: string) { return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [$(text, { size: 24, bold: true, color: "2E4057" })] }); }

// Common page properties
const pageProps = {
  page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
};

// ========== CSV helpers (for fee allocation) ==========
function parseCSV(csv: string): Record<string, string>[] {
  // Strip a leading UTF-8 BOM — Clio CSV exports often include one, which would
  // otherwise corrupt the first header key (e.g. "﻿Activity month") and
  // break exact-name column lookups / signature checks.
  const lines = csv.replace(/^﻿/, "").split("\n");
  if (lines.length < 2) return [];
  function parseLine(line: string): string[] {
    const fields: string[] = []; let current = ""; let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQuotes && line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = !inQuotes; } }
      else if (ch === "," && !inQuotes) { fields.push(current.trim()); current = ""; }
      else { current += ch; }
    }
    fields.push(current.trim()); return fields;
  }
  const headers = parseLine(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const values = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => { row[h] = values[j] ?? ""; });
    return row;
  });
}

async function getFeeAllocationCSV(reportId?: number): Promise<{ rows: Record<string, string>[]; report: any }> {
  const reports = await fetchAllPages<any>("/reports", { fields: "id,name,state,kind,format", order: "name(asc)" });
  const feeReports = reports.filter((r: any) => r.kind === "fee_allocation" && r.state === "completed" && r.format === "csv");
  if (feeReports.length === 0) throw new Error("No completed Fee Allocation Report found in Clio.");
  let target;
  if (reportId) {
    target = feeReports.find((r: any) => r.id === reportId);
    if (!target) throw new Error(`Report ID ${reportId} not found among ${feeReports.length} fee allocation reports.`);
  } else {
    target = feeReports.reduce((a: any, b: any) => (a.id > b.id ? a : b));
  }
  const csv = await downloadReport(target.id);
  return { rows: parseCSV(csv), report: target };
}

// ========== Revenue Report (classic, monthly) helpers ==========
// The "Revenue Report (Like Classic)" export grouped by Activity month + User
// + Responsible attorney. ONE download carries every YTD month plus the
// authoritative billed / billable / write-off / discount figures — replacing
// the old firm-wide /activities pagination that reconstructed billed$ as
// hours×rate (slow, and wrong because it ignored write-offs/discounts and used
// the current rate rather than the billed amount).
//
// Reports aren't reliably tagged by `kind` for this export, so we select by
// header signature: only the monthly-classic shape carries all of these
// columns together (the per-matter and per-timekeeper variants do not).
const REVENUE_REPORT_SIGNATURE = ["Activity month", "User initials", "Responsible attorney", "Billed hours value"];

async function getRevenueReportCSV(reportId?: number): Promise<{ rows: Record<string, string>[]; report: any }> {
  // NOTE: /reports does not accept order=id(...) (Clio returns HTTP 422), so list
  // with the proven-safe name ordering and sort newest-first (highest id) in memory.
  const reports = await fetchAllPages<any>("/reports", { fields: "id,name,state,kind,format", order: "name(asc)" });
  const csvReports = reports
    .filter((r: any) => r.state === "completed" && r.format === "csv")
    .sort((a: any, b: any) => b.id - a.id);
  const hasSignature = (rows: Record<string, string>[]) =>
    rows.length > 0 && REVENUE_REPORT_SIGNATURE.every((c) => c in rows[0]);

  if (reportId) {
    const target = csvReports.find((r: any) => r.id === reportId);
    if (!target) throw new Error(`Report ID ${reportId} not found among completed CSV reports.`);
    const rows = parseCSV(await downloadReport(target.id));
    if (!hasSignature(rows)) {
      throw new Error(`Report ID ${reportId} ("${target.name}") is not a monthly classic Revenue Report (missing one of: ${REVENUE_REPORT_SIGNATURE.join(", ")}).`);
    }
    return { rows, report: target };
  }

  // Prefer reports whose name hints "revenue" (newest first), then fall back to
  // scanning other CSV reports. Validate each candidate by header signature so a
  // mis-named or wrong-shape report can't be silently picked. We sniff ALL
  // revenue-named reports (so the cap can never hide the right one) and bound
  // only the fallback scan of non-revenue reports.
  const byName = csvReports.filter((r: any) => /revenue/i.test(r.name || ""));
  const rest = csvReports.filter((r: any) => !byName.includes(r));
  const candidates = [...byName, ...rest.slice(0, 25)];
  const sniffed: { id: number; name: string; cols: string }[] = [];
  for (const cand of candidates) {
    try {
      const rows = parseCSV(await downloadReport(cand.id));
      if (hasSignature(rows)) return { rows, report: cand };
      sniffed.push({ id: cand.id, name: cand.name, cols: rows[0] ? Object.keys(rows[0]).join("|") : "(empty)" });
    } catch (e: any) {
      sniffed.push({ id: cand.id, name: cand.name, cols: `(download error: ${e?.message ?? e})` });
    }
  }
  // Self-diagnosing error: list what was actually in Clio + why revenue-named
  // candidates were rejected, so the failure can be triaged from the message alone.
  const listing = csvReports.slice(0, 20).map((r: any) => `#${r.id} ${r.name}`).join("; ") || "(none)";
  const revDetail = sniffed
    .filter((s) => /revenue/i.test(s.name))
    .slice(0, 5)
    .map((s) => `#${s.id} "${s.name}" cols=[${s.cols}]`)
    .join(" || ");
  throw new Error(
    `No completed monthly classic Revenue Report found in Clio (need a CSV containing: ${REVENUE_REPORT_SIGNATURE.join(", ")}). ` +
    `Scanned ${csvReports.length} completed CSV report(s). ` +
    (revDetail
      ? `Revenue-named candidates checked but rejected: ${revDetail}. `
      : `No completed CSV report has "revenue" in its name. `) +
    `Completed CSV reports seen: ${listing}. ` +
    `Fix: generate/schedule the "Revenue Report (Like Classic)" grouped by Activity month + User as CSV in Clio, or pass revenue_report_id explicitly.`
  );
}

// Match the revenue report's "User" field ("Last, First") to a roster user_id.
// Returns null for non-roster timekeepers (staff/paralegals) so they're skipped
// for the per-attorney columns but still roll up under their responsible attorney.
function matchRosterUser(userField: string, roster: { initials: string; name: string; user_id: number }[]): number | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").trim();
  const parts = userField.split(",").map((p) => norm(p));
  let last = "", first = "";
  if (parts.length >= 2) { last = parts[0]; first = parts[1]; }
  else { const t = norm(userField).split(/\s+/); first = t[0] || ""; last = t[t.length - 1] || ""; }
  for (const r of roster) {
    const rn = norm(r.name).split(/\s+/);
    const rFirst = rn[0] || "", rLast = rn[rn.length - 1] || "";
    if (rLast === last && (first === "" || rFirst.startsWith(first) || first.startsWith(rFirst))) return r.user_id;
  }
  return null;
}

// Match the revenue report's "Responsible attorney" field ("First Last") to a roster user_id.
function matchRosterResponsible(respField: string, roster: { initials: string; name: string; user_id: number }[]): number | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").trim();
  const target = norm(respField);
  if (!target) return null;
  for (const r of roster) if (norm(r.name) === target) return r.user_id;
  const tl = target.split(/\s+/).pop();
  for (const r of roster) if (norm(r.name).split(/\s+/).pop() === tl) return r.user_id;
  return null;
}

// ---- Background-job registry for long-running dashboard updates ----
// download_dashboard_update can take several minutes (classic mode generates a
// revenue report per timekeeper), well past the MCP client's ~180s timeout. So
// it runs as a detached job: the tool returns a job_id immediately and the work
// continues server-side; get_dashboard_status reports progress/result. The Map
// is a module singleton, so it persists across tool calls for the life of the
// server process (jobs are lost only if the process restarts).
type DashJob = {
  id: string;
  status: "running" | "done" | "error";
  started_at: string;
  finished_at?: string;
  result?: any;
  error?: string;
};
const dashboardJobs = new Map<string, DashJob>();
function pruneDashboardJobs() {
  const now = Date.now();
  for (const [id, j] of dashboardJobs) {
    if (j.finished_at && now - new Date(j.finished_at).getTime() > 2 * 3600 * 1000) dashboardJobs.delete(id);
  }
  while (dashboardJobs.size > 50) {
    const oldest = dashboardJobs.keys().next().value;
    if (oldest === undefined) break;
    dashboardJobs.delete(oldest);
  }
}

// V&D tier logic
const ATTORNEY_TIERS = [
  { ceiling: 250000, vdPct: 0.825, firmPct: 0.175 },
  { ceiling: 500000, vdPct: 0.80, firmPct: 0.20 },
  { ceiling: Infinity, vdPct: 0.775, firmPct: 0.225 },
];
function applyTieredSplit(amount: number, ytdBefore: number) {
  let remaining = amount, vd = 0, firm = 0, ytd = ytdBefore;
  for (const tier of ATTORNEY_TIERS) {
    if (remaining <= 0) break;
    const space = Math.max(0, tier.ceiling - ytd);
    if (space <= 0) continue;
    const inTier = Math.min(remaining, space);
    vd += inTier * tier.vdPct; firm += inTier * tier.firmPct;
    ytd += inTier; remaining -= inTier;
  }
  return { vd: round2(vd), firm: round2(firm), ytdAfter: ytd };
}

// ========== REGISTER TOOLS ==========

// ─── Extracted weekly-goals logic (reusable by both single + batch tools) ───

// Firm dashboard (the same workbook download_dashboard_update maintains).
// On the "26 Compare" sheet: col B = month name, col C = initials,
// col N (14) = that timekeeper's individual collected $ for the month.
const FIRM_DASHBOARD_FILE_ID = "2199324794140";

const INITIALS_BY_USER_ID: Record<number, string> = {
  344117381: "PAR", 344134017: "KES", 348755029: "NRN", 359380639: "NAF",
  358528744: "ACA", 358108805: "AFL", 358550509: "AKG", 359711375: "TBS",
  359576660: "MNH", 360091325: "JPB", 360049685: "KGV", 359865560: "CTD",
};

const MONTH_NAMES_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Cache the parsed dashboard collections per (fileId, day) so a batch run
// (download_all_weekly_goals) doesn't re-download the workbook for every person.
const _dashboardCollectionsCache = new Map<string, Promise<Record<string, Record<string, number>>>>();

// Returns { "January": { "PAR": 29172.05, ... }, ... } of individual collected $.
async function getDashboardCollections(fileId: string): Promise<Record<string, Record<string, number>>> {
  const cacheKey = `${fileId}:${new Date().toISOString().slice(0, 10)}`;
  const cached = _dashboardCollectionsCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const buf = await downloadFromBox(fileId);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheet = wb.getWorksheet("26 Compare");
    if (!sheet) throw new Error("'26 Compare' sheet not found in firm dashboard");

    const out: Record<string, Record<string, number>> = {};
    sheet.eachRow((row) => {
      const month = String(row.getCell(2).value ?? "").trim(); // col B
      if (!MONTH_NAMES_FULL.includes(month)) return;            // skips totals/header rows
      const ini = String(row.getCell(3).value ?? "").trim().toUpperCase(); // col C
      if (!ini) return;
      const raw = row.getCell(14).value;                        // col N = individual collected
      const num = typeof raw === "number" ? raw : parseFloat(String(raw ?? "").replace(/[$,()\s]/g, "")) || 0;
      (out[month] ??= {})[ini] = num;
    });
    return out;
  })();

  _dashboardCollectionsCache.set(cacheKey, promise);
  promise.catch(() => _dashboardCollectionsCache.delete(cacheKey)); // allow retry on failure
  return promise;
}

interface WeeklyGoalsParams {
  user_id: number;
  year: number;
  weekly_billable_goal: number;
  hours_per_day?: number;
  box_folder_id?: string;
  dashboard_file_id?: string;
}

async function downloadWeeklyGoals(params: WeeklyGoalsParams): Promise<{
  filename: string;
  box_file_id?: string;
  box_url?: string;
  base64?: string;
  size_kb?: number;
}> {
  const hoursPerDay = params.hours_per_day ?? 8;
  const startDate = `${params.year}-01-01`;
  const endDate = new Date().toISOString().split("T")[0];

  const rawEntries = await fetchAllPages<any>("/activities", {
    type: "TimeEntry", fields: "id,date,quantity,rounded_quantity,price,user{id,name}", user_id: params.user_id,
    created_since: `${startDate}T00:00:00+00:00`,
  });
  const entries = rawEntries.filter((e: any) => e.date >= startDate && e.date <= endDate);
  const userName = entries[0]?.user?.name ?? "Unknown";

  // Group by month and week
  const months: Record<string, { billable: number; nonbillable: number }> = {};
  const weeks: Record<string, { billable: number; nonbillable: number }> = {};

  for (const e of entries) {
    // rounded_quantity = seconds rounded to billing increment (what the client
    // is billed for). Raw `quantity` = actual tracked seconds, which under-
    // reports billed hours and is NOT what these goals/scorecard reports want.
    const hours = (e.rounded_quantity ?? e.quantity) / 3600;
    const monthKey = e.date.slice(0, 7);
    const d2 = new Date(e.date + "T12:00:00");
    const dow = d2.getDay();
    const mon = new Date(d2); mon.setDate(d2.getDate() - ((dow + 6) % 7));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const weekKey = `${mon.getMonth() + 1}/${mon.getDate()}-${sun.getMonth() + 1}/${sun.getDate()}`;

    if (!months[monthKey]) months[monthKey] = { billable: 0, nonbillable: 0 };
    if (!weeks[weekKey]) weeks[weekKey] = { billable: 0, nonbillable: 0 };

    if ((e.price || 0) > 0) { months[monthKey].billable += hours; weeks[weekKey].billable += hours; }
    else { months[monthKey].nonbillable += hours; weeks[weekKey].nonbillable += hours; }
  }

  function getWorkingDays(year: number, month: number): number {
    let count = 0;
    const dim = new Date(year, month, 0).getDate();
    for (let d = 1; d <= dim; d++) { const dow = new Date(year, month - 1, d).getDay(); if (dow !== 0 && dow !== 6) count++; }
    return count;
  }

  // Build all 52/53 weeks for the year (Mon-Sun)
  const allWeeks: { key: string; monDate: Date }[] = [];
  const jan1 = new Date(params.year, 0, 1);
  const dow1 = jan1.getDay();
  const firstMon = new Date(jan1);
  firstMon.setDate(jan1.getDate() - ((dow1 + 6) % 7));
  for (let d = new Date(firstMon); d.getFullYear() <= params.year; d.setDate(d.getDate() + 7)) {
    const mon = new Date(d);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    if (sun.getFullYear() < params.year) continue;
    if (mon.getFullYear() > params.year) break;
    const key = `${mon.getMonth() + 1}/${mon.getDate()}-${sun.getMonth() + 1}/${sun.getDate()}`;
    allWeeks.push({ key, monDate: new Date(mon) });
  }

  // Prior-month individual collections, scraped from the firm dashboard.
  // Dashboard collections are posted ~7th of the month, so before the 7th the
  // immediately-prior month isn't up yet — step back to the last posted month.
  let collectionsLabel = "";
  let collectionsValue: number | null = null;
  try {
    const nowD = new Date();
    let target = new Date(nowD.getFullYear(), nowD.getMonth() - 1, 1); // prior month
    if (nowD.getDate() < 7) target = new Date(nowD.getFullYear(), nowD.getMonth() - 2, 1);
    // Dashboard only carries the current year's months; skip for off-year sheets.
    if (target.getFullYear() === params.year) {
      const map = await getDashboardCollections(params.dashboard_file_id ?? FIRM_DASHBOARD_FILE_ID);
      const ini = INITIALS_BY_USER_ID[params.user_id] ?? "";
      const monthName = MONTH_NAMES_FULL[target.getMonth()];
      collectionsLabel = `${monthName} ${target.getFullYear()}`;
      const v = map[monthName]?.[ini];
      collectionsValue = typeof v === "number" ? v : null;
    }
  } catch (err: any) {
    console.warn(`[Doc] weekly goals — collections scrape failed: ${err?.message ?? err}`);
    collectionsValue = null;
  }

  // Build Excel
  const wb = new ExcelJS.Workbook();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Summary (Monthly) sheet
  const ws1 = wb.addWorksheet("Summary");
  ws1.addRow(["Month", "Billable Goal", "Billable Actual", "Over/Under", "Nonbillable", "Total", "Available", "Utilization %"]).font = { bold: true };

  let cumBillable = 0, cumGoal = 0, monthsCounted = 0;
  const currentMonth = new Date().getMonth() + 1; // 1-indexed
  const isCurrentYear = params.year === new Date().getFullYear();

  // Monthly billable goal is derived from the weekly goal so it matches the dashboard:
  // 47 working weeks/yr ÷ 12 months. 30/wk → 1410/yr → 117.5/mo (partners & paras),
  // 32/wk → 1504/yr → 125.33/mo (associates).
  const WORKING_WEEKS_PER_YEAR = 47;
  const ANNUAL_AVAILABLE_HOURS = 1880;
  const flatMonthlyGoal = round1(params.weekly_billable_goal * WORKING_WEEKS_PER_YEAR / 12);
  // Utilization = billable ÷ available hours (1880/12 = 156.7/mo), per the dashboard.
  const availPerMonth = ANNUAL_AVAILABLE_HOURS / 12;
  const flatMonthlyAvailable = round1(availPerMonth); // 156.7

  for (let m = 1; m <= 12; m++) {
    const key = `${params.year}-${String(m).padStart(2, "0")}`;
    const data = months[key] || { billable: 0, nonbillable: 0 };
    const goal = flatMonthlyGoal;
    const avail = flatMonthlyAvailable;
    // Only accumulate YTD totals for months up to current month (or all months for past years)
    if (!isCurrentYear || m <= currentMonth) {
      cumBillable += data.billable; cumGoal += goal; monthsCounted++;
    }
    const ou = round1(data.billable - goal);
    const util = round1((data.billable / availPerMonth) * 100);
    const row = ws1.addRow([monthNames[m - 1], goal, round1(data.billable), ou, round1(data.nonbillable), round1(data.billable + data.nonbillable), avail, util]);
    row.getCell(4).font = { color: { argb: ou >= 0 ? "FF008000" : "FFFF0000" } };
  }
  const ytdUtil = monthsCounted > 0 ? round1((cumBillable / (availPerMonth * monthsCounted)) * 100) : 0;
  const totRow = ws1.addRow(["YTD Total", round1(cumGoal), round1(cumBillable), round1(cumBillable - cumGoal), "", "", "", ytdUtil]);
  totRow.font = { bold: true };
  totRow.getCell(4).font = { bold: true, color: { argb: (cumBillable - cumGoal) >= 0 ? "FF008000" : "FFFF0000" } };

  // Prior-month individual collections, scraped from the firm dashboard (posts ~7th).
  ws1.addRow([]);
  const collHdr = ws1.addRow(["Prior-Month Collections (Individual — from Firm Dashboard)"]);
  collHdr.font = { bold: true };
  const collValueRow = ws1.addRow([
    collectionsLabel || "n/a",
    collectionsValue != null ? collectionsValue : "not yet posted",
  ]);
  if (collectionsValue != null) collValueRow.getCell(2).numFmt = '"$"#,##0.00';
  ws1.addRow(["Dashboard collections post ~7th of each month; figure reflects the most recently posted month."])
    .font = { italic: true, color: { argb: "FF666666" } };

  // Utilization goal legend (text only).
  const utilGoalPct = round1((params.weekly_billable_goal * WORKING_WEEKS_PER_YEAR / ANNUAL_AVAILABLE_HOURS) * 100);
  ws1.addRow([]);
  ws1.addRow(["Utilization Goal"]).font = { bold: true };
  ws1.addRow([`${utilGoalPct}%`, `Billable ÷ available hours (${params.weekly_billable_goal}/wk × 47 ÷ 1,880)`]);
  ws1.addRow(["Firm targets: 75% (partners & paralegals), 80% (associates)."])
    .font = { italic: true, color: { argb: "FF666666" } };

  // Weekly sheet: horizontal layout - weeks as columns, metrics as rows
  const ws2 = wb.addWorksheet("Weekly");
  const headerRow = ws2.getRow(4);
  for (let i = 0; i < allWeeks.length; i++) {
    headerRow.getCell(i + 3).value = allWeeks[i].key;
  }

  // `today` gates which weeks get shaded (only weeks that have actually started).
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  // Billable row — shaded red (< 20), yellow (20 → below goal), green (>= goal).
  ws2.getCell("B5").value = "Billable";
  ws2.getCell("B5").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    const data = weeks[allWeeks[i].key];
    const billable = round1(data?.billable ?? 0);
    const cell = ws2.getRow(5).getCell(i + 3);
    cell.value = billable;
    if (allWeeks[i].monDate <= today) {
      const argb = billable < 20
        ? "FFFFC7CE"                                   // red
        : billable < params.weekly_billable_goal
          ? "FFFFEB9C"                                 // yellow
          : "FFC6EFCE";                                // green
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
    }
  }

  ws2.getCell("B6").value = "Nonbillable";
  ws2.getCell("B6").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    const data = weeks[allWeeks[i].key];
    ws2.getRow(6).getCell(i + 3).value = round1(data?.nonbillable ?? 0);
  }

  ws2.getCell("B7").value = "Total Tracked";
  ws2.getCell("B7").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    const data = weeks[allWeeks[i].key];
    ws2.getRow(7).getCell(i + 3).value = round1((data?.billable ?? 0) + (data?.nonbillable ?? 0));
  }

  ws2.getCell("B9").value = "Billable Goal";
  ws2.getCell("B9").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    ws2.getRow(9).getCell(i + 3).value = params.weekly_billable_goal;
  }

  ws2.getCell("B10").value = "Over/Under";
  ws2.getCell("B10").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    const data = weeks[allWeeks[i].key];
    const billable = data?.billable ?? 0;
    const ou = round1(billable - params.weekly_billable_goal);
    const cell = ws2.getRow(10).getCell(i + 3);
    cell.value = ou;
    cell.font = { color: { argb: ou >= 0 ? "FF008000" : "FFFF0000" } };
  }

  // Row 11: Trailing 4-week average of billable hours (this week + prior 3 that
  // have started). A rolling read of recent pace that smooths single-week noise.
  ws2.getCell("B11").value = "Trailing 4-Wk Avg";
  ws2.getCell("B11").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    if (allWeeks[i].monDate > today) break; // only weeks that have started
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - 3); j <= i; j++) {
      sum += weeks[allWeeks[j].key]?.billable ?? 0;
      cnt++;
    }
    ws2.getRow(11).getCell(i + 3).value = round1(sum / cnt);
  }

  // Row 12: YTD Over/Under — running cumulative, only through current week
  ws2.getCell("B12").value = "YTD Over/Under";
  ws2.getCell("B12").font = { bold: true };
  let cumWeeklyOU = 0;
  for (let i = 0; i < allWeeks.length; i++) {
    // Only include weeks that have started (Monday <= today)
    if (allWeeks[i].monDate > today) break;
    const data = weeks[allWeeks[i].key];
    const billable = data?.billable ?? 0;
    cumWeeklyOU += billable - params.weekly_billable_goal;
    const cell = ws2.getRow(12).getCell(i + 3);
    cell.value = round1(cumWeeklyOU);
    cell.font = { bold: true, color: { argb: cumWeeklyOU >= 0 ? "FF008000" : "FFFF0000" } };
  }

  // Legend for the Billable-row shading (rows 14-17).
  const goalNum = params.weekly_billable_goal;
  ws2.getCell("B14").value = "Legend — Billable hours";
  ws2.getCell("B14").font = { bold: true };
  const legend: Array<[number, string, string]> = [
    [15, "FFFFC7CE", `Below minimum (< 20)`],
    [16, "FFFFEB9C", `Approaching goal (20 to < ${goalNum})`],
    [17, "FFC6EFCE", `At / above goal (≥ ${goalNum})`],
  ];
  for (const [r, argb, label] of legend) {
    const swatch = ws2.getCell(`B${r}`);
    swatch.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
    swatch.border = {
      top: { style: "thin", color: { argb: "FFBFBFBF" } },
      left: { style: "thin", color: { argb: "FFBFBFBF" } },
      bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
      right: { style: "thin", color: { argb: "FFBFBFBF" } },
    };
    ws2.getCell(`C${r}`).value = label;
  }

  ws2.getColumn(2).width = 14;
  for (let i = 0; i < allWeeks.length; i++) {
    ws2.getColumn(i + 3).width = 10;
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const filename = `${userName} Goals ${params.year}.xlsx`;
  const size_kb = Math.round(buffer.byteLength / 1024);

  if (params.box_folder_id !== undefined) {
    const INITIALS_MAP: Record<number, string> = {
      344117381: "PAR", 344134017: "KES", 348755029: "NRN", 359380639: "NAF",
      358528744: "ACA", 358108805: "AFL", 358550509: "AKG", 359711375: "TBS",
      359576660: "MNH", 360091325: "JPB", 360049685: "KGV", 359865560: "CTD",
    };
    const initials = INITIALS_MAP[params.user_id] ?? userName.split(" ").map((p: string) => p[0]?.toUpperCase() ?? "").join("");
    const boxFilename = `${initials} Goals ${params.year}.xlsx`;
    const folderId = params.box_folder_id || "372923594239";
    const result = await uploadToBox({ buffer, filename: boxFilename, folderId });
    if (result.uploaded) {
      return { filename: boxFilename, size_kb: result.size_kb, box_file_id: result.box_file_id, box_url: result.box_url };
    }
    return {
      filename: boxFilename,
      size_kb: result.size_kb,
      direct_download_url: result.direct_download_url,
      expires_at: result.expires_at,
      reason: result.reason,
      note: result.note,
    };
  }

  // No Box target — park the buffer and hand back a direct-download URL.
  console.warn(`[Doc] generate_weekly_goals — returning direct_download_url filename=${filename} size_kb=${size_kb}`);
  const reg = registerDownload(buffer, filename, mimeForFilename(filename));
  return { filename, size_kb, direct_download_url: reg.url, expires_at: reg.expires_at };
}

// ─── ROSTER (hardcoded for batch weekly goals, grouped by team) ──

// Weekly billable goals match the dashboard: partners & paras = 30/wk, associates = 32/wk.
const WEEKLY_GOALS_ROSTER = [
  { name: "Nicholas Noe",    user_id: 348755029, goal: 30, group: "NRN" }, // partner/para
  { name: "Tzipora Simmons", user_id: 359711375, goal: 32, group: "NRN" }, // associate
  { name: "Kaz Gonzalez",    user_id: 358550509, goal: 30, group: "NRN" }, // partner/para
  { name: "Paul Romano",     user_id: 344117381, goal: 30, group: "PAR" }, // partner/para
  { name: "Angela Alanis",   user_id: 358528744, goal: 30, group: "PAR" }, // partner/para
  { name: "Nick Fernelius",  user_id: 359380639, goal: 32, group: "PAR" }, // associate
  { name: "Kenny Sumner",    user_id: 344134017, goal: 30, group: "KES" }, // partner/para
  { name: "Jonathan Barbee", user_id: 360091325, goal: 32, group: "KES" }, // associate
  { name: "Anna Lozano",     user_id: 358108805, goal: 30, group: "KES" }, // partner/para
  { name: "May Huynh",       user_id: 359576660, goal: 32, group: "MNH" }, // associate
];

export function registerDocumentTools(server: McpServer): void {

  // ============================================================
  // TOOL 1: download_vd_statement
  // ============================================================
  server.tool(
    "download_vd_statement",
    "Generate a V&D Of Counsel compensation statement as a downloadable Word document. Includes cover letter from Rachel Trevino, compensation summary with tier breakdown, timekeeper detail, and payment history. Returns a short-lived direct_download_url (1-hour TTL) for the generated .docx.",
    {
      month: z.coerce.number().describe("Month number (1-12)"),
      year: z.coerce.number().describe("Year (e.g. 2026)"),
    },
    async (params) => {
      try {
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const monthName = monthNames[params.month - 1];
        const startDate = `${params.year}-${String(params.month).padStart(2, "0")}-01`;
        const endDay = new Date(params.year, params.month, 0).getDate();
        const endDate = `${params.year}-${String(params.month).padStart(2, "0")}-${endDay}`;

        // Get users
        const allUsers = await fetchAllPages<any>("/users", { fields: "id,name,enabled" });
        const users = allUsers.map((u: any) => ({ id: u.id, name: u.name }));
        const gus = users.find((u) => u.name.toLowerCase().includes("gus"));
        const courtney = users.find((u) => u.name.toLowerCase().includes("courtney") || u.name.toLowerCase().includes("courteney"));
        const vdAttorneys = [gus, courtney].filter(Boolean) as { id: number; name: string }[];
        const vdLastNames = vdAttorneys.map(a => a.name.toLowerCase().split(" ").pop() ?? "");

        // Get fee allocation CSV
        const { rows: csvRows } = await getFeeAllocationCSV();

        // Filter V&D rows
        const vdRows = csvRows.filter(r => {
          const ra = (r["Responsible Attorney"] ?? "").toLowerCase();
          return vdLastNames.some(ln => ra.includes(ln));
        });

        // Classify rows
        const classified = vdRows.map(r => ({
          responsible: r["Responsible Attorney"] ?? "Unknown",
          user: r["User"] ?? "Unknown",
          isAttorneyTime: vdLastNames.some(ln => (r["User"] ?? "").toLowerCase().includes(ln)),
          collected: parseFloat(r["Billed Time Collected"] || r["Total Funds Collected"] || "0"),
          hours: parseFloat(r["Billed Hours"] || "0"),
        }));

        // Calculate splits (pooled tiers)
        let combinedYTD = 0;
        const perAtty: Record<string, { attyCollected: number; attyVD: number; attyFirm: number; staffCollected: number; staffVD: number; staffFirm: number; tks: Record<string, { collected: number; hours: number }> }> = {};
        for (const a of vdAttorneys) {
          perAtty[a.name] = { attyCollected: 0, attyVD: 0, attyFirm: 0, staffCollected: 0, staffVD: 0, staffFirm: 0, tks: {} };
        }

        // Attorney time
        const attyRows = classified.filter(c => c.isAttorneyTime);
        const totalAttyCollected = attyRows.reduce((s, c) => s + c.collected, 0);
        const attySplit = applyTieredSplit(totalAttyCollected, combinedYTD);
        combinedYTD = attySplit.ytdAfter;

        for (const c of attyRows) {
          const pa = Object.entries(perAtty).find(([k]) => c.responsible.toLowerCase().includes(k.toLowerCase().split(" ").pop()!))?.[1];
          if (!pa) continue;
          const prop = totalAttyCollected > 0 ? c.collected / totalAttyCollected : 0;
          pa.attyCollected += c.collected;
          pa.attyVD += attySplit.vd * prop;
          pa.attyFirm += attySplit.firm * prop;
        }

        // Staff time
        const staffRows = classified.filter(c => !c.isAttorneyTime);
        for (const c of staffRows) {
          const pa = Object.entries(perAtty).find(([k]) => c.responsible.toLowerCase().includes(k.toLowerCase().split(" ").pop()!))?.[1];
          if (!pa) continue;
          const split = applyTieredSplit(c.collected, combinedYTD);
          combinedYTD = split.ytdAfter;
          pa.staffCollected += c.collected;
          pa.staffVD += split.vd;
          pa.staffFirm += split.firm;
        }

        // Timekeeper breakdown
        for (const c of classified) {
          const pa = Object.entries(perAtty).find(([k]) => c.responsible.toLowerCase().includes(k.toLowerCase().split(" ").pop()!))?.[1];
          if (!pa) continue;
          if (!pa.tks[c.user]) pa.tks[c.user] = { collected: 0, hours: 0 };
          pa.tks[c.user].collected += c.collected;
          pa.tks[c.user].hours += c.hours;
        }

        // Tier breakdown
        const tier1 = Math.min(combinedYTD, 250000);
        const tier2 = Math.min(Math.max(combinedYTD - 250000, 0), 250000);
        const tier3 = Math.max(combinedYTD - 500000, 0);

        const grandCollected = Object.values(perAtty).reduce((s, a) => s + a.attyCollected + a.staffCollected, 0);
        const grandVD = Object.values(perAtty).reduce((s, a) => s + a.attyVD + a.staffVD, 0);
        const grandFirm = Object.values(perAtty).reduce((s, a) => s + a.attyFirm + a.staffFirm, 0);

        // Generate letter date (15th of next month)
        const nextMonth = params.month === 12 ? 1 : params.month + 1;
        const nextYear = params.month === 12 ? params.year + 1 : params.year;
        const letterDate = new Date(nextYear, nextMonth - 1, 15).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

        // ===== BUILD DOCUMENT =====
        const doc = new Document({
          styles: {
            default: { document: { run: { font: "Arial", size: 20 } } },
            paragraphStyles: [
              { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 28, bold: true, font: "Arial", color: "2E4057" }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 } },
              { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 24, bold: true, font: "Arial", color: "2E4057" }, paragraph: { spacing: { before: 180, after: 120 }, outlineLevel: 1 } },
            ],
          },
          sections: [{
            properties: {
              ...pageProps,
              headers: {
                default: new Header({ children: [
                  new Paragraph({ alignment: AlignmentType.CENTER, children: [$("Romano & Sumner, PLLC", { size: 28, bold: true, color: "2E4057" })] }),
                  new Paragraph({ alignment: AlignmentType.CENTER, children: [$("Of Counsel Compensation Statement", { size: 22, color: "666666" })] }),
                  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [$(`Period: ${monthName} ${params.year}`, { size: 20, color: "666666" })] }),
                ] }),
              },
              footers: {
                default: new Footer({ children: [
                  new Paragraph({ alignment: AlignmentType.CENTER, children: [
                    $("Generated from Clio Fee Allocation Report  |  Romano & Sumner, PLLC Confidential  |  Page ", { size: 16, color: "999999" }),
                    new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 16, color: "999999" }),
                  ] }),
                ] }),
              },
            },
            children: [
              // PAGE 1: COVER LETTER
              makePara(letterDate, { size: 22, spacingAfter: 200 }),
              makePara(`Re: Of Counsel Compensation - ${monthName} ${params.year}`, { bold: true, size: 22, spacingAfter: 200 }),
              makePara("Dear Gus and Courteney:", { size: 22, spacingAfter: 200 }),
              makePara(`Enclosed please find a check in the amount of ${fmt(round2(grandVD))} for V&D compensation for the month of ${monthName} ${params.year}.`, { size: 22, spacingAfter: 120 }),
              ...vdAttorneys.map(a => {
                const pa = perAtty[a.name];
                const total = round2(pa.attyVD + pa.staffVD);
                return new Paragraph({ spacing: { after: 60 }, children: [
                  $(`    ${a.name}: `, { size: 22 }),
                  $(fmt(total), { size: 22, bold: true }),
                ] });
              }),
              makePara("", { spacingAfter: 120 }),
              makePara("Please see the attached compensation statement for a detailed breakdown of collections, tier calculations, and payment history.", { size: 22, spacingAfter: 200 }),
              makePara("Please do not hesitate to reach out with any questions.", { size: 22, spacingAfter: 400 }),
              makePara("Sincerely,", { size: 22, spacingAfter: 400 }),
              makePara("Rachel Trevino", { size: 22, spacingAfter: 0 }),
              makePara("Executive Director", { size: 22, spacingAfter: 0 }),
              makePara("Romano & Sumner, PLLC", { size: 22, spacingAfter: 200 }),

              // PAGE 2: SUMMARY
              pageBreak(),
              makePara(`V&D Compensation Statement - ${monthName} ${params.year}`, { bold: true, size: 28, alignment: AlignmentType.CENTER, spacingAfter: 200 }),
              spacer(),
              (() => {
                const rows: string[][] = [];
                for (const a of vdAttorneys) {
                  const pa = perAtty[a.name];
                  const firstName = a.name.split(" ")[0];
                  rows.push([a.name, "", "", ""]);
                  rows.push(["  Attorney Time", fmt(round2(pa.attyCollected)), fmt(round2(pa.attyVD)), fmt(round2(pa.attyFirm))]);
                  rows.push(["  Staff Time (allowance)", fmt(round2(pa.staffCollected)), fmt(round2(pa.staffVD)), fmt(round2(pa.staffFirm))]);
                  rows.push(["  Staff Time (regular)", fmt(0), fmt(0), fmt(0)]);
                  rows.push([`  ${firstName} Subtotal`, fmt(round2(pa.attyCollected + pa.staffCollected)), fmt(round2(pa.attyVD + pa.staffVD)), fmt(round2(pa.attyFirm + pa.staffFirm))]);
                  rows.push(["", "", "", ""]);
                }
                rows.push(["V&D Total", fmt(round2(grandCollected)), fmt(round2(grandVD)), fmt(round2(grandFirm))]);
                rows.push(["", "", "", ""]);
                rows.push([`Tier 1 ($0-$250K @ 82.5%)`, fmt(round2(tier1)), "", ""]);
                rows.push([`Tier 2 ($250K-$500K @ 80%)`, fmt(round2(tier2)), "", ""]);
                rows.push([`Tier 3 ($500K+ @ 77.5%)`, fmt(round2(tier3)), "", ""]);
                return makeDocxTable(["", "Collected", "V&D Share", "Firm Share"], rows, [3200, 2100, 2100, 1960]);
              })(),
              spacer(),
              makePara(`Amount Due to V&D for ${monthName}: ${fmt(round2(grandVD))}`, { bold: true, size: 24, spacingAfter: 200 }),

              // PAGE 3: DETAIL
              pageBreak(),
              h2("Timekeeper Detail"),
              spacer(),
              (() => {
                const rows: string[][] = [];
                for (const a of vdAttorneys) {
                  const pa = perAtty[a.name];
                  for (const [name, data] of Object.entries(pa.tks).sort(([,a],[,b]) => b.collected - a.collected)) {
                    rows.push([a.name, name, String(round1(data.hours)), fmt(round2(data.collected))]);
                  }
                  rows.push(["", "", "", ""]);
                }
                return makeDocxTable(["Responsible Attorney", "Timekeeper", "Hours", "Collected"], rows, [2400, 2400, 1280, 3280]);
              })(),
              spacer(), spacer(),
              h2("Payment History (YTD)"),
              spacer(),
              ...vdAttorneys.flatMap(a => {
                const pa = perAtty[a.name];
                const total = round2(pa.attyCollected + pa.staffCollected);
                const vd = round2(pa.attyVD + pa.staffVD);
                return [
                  makePara(a.name, { bold: true, spacingAfter: 80 }),
                  makeDocxTable(
                    ["Month", "Collections", "V&D Share", "Amount Paid", "Date Paid"],
                    [
                      [monthName, fmt(total), fmt(vd), "__________", "__________"],
                      ["YTD Total", fmt(total), fmt(vd), "", ""],
                    ],
                    [1800, 1900, 1900, 1900, 1860]
                  ),
                  spacer(),
                ];
              }),
            ],
          }],
        });

        const buffer = await Packer.toBuffer(doc);
        const filename = `V&D Compensation Statement - ${monthName} ${params.year}.docx`;
        const size_kb = Math.round(buffer.length / 1024);
        console.warn(`[Doc] download_vd_statement — returning direct_download_url filename=${filename} size_kb=${size_kb}`);
        const reg = registerDownload(buffer, filename, mimeForFilename(filename));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              filename,
              format: "docx",
              size_kb,
              direct_download_url: reg.url,
              expires_at: reg.expires_at,
              note: "Download the file from direct_download_url within 1 hour.",
              summary: {
                period: `${monthName} ${params.year}`,
                total_vd_compensation: fmt(round2(grandVD)),
                attorneys: vdAttorneys.map(a => ({ name: a.name, vd: fmt(round2(perAtty[a.name].attyVD + perAtty[a.name].staffVD)) })),
              },
            }),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // ============================================================
  // TOOL 2: download_firm_scorecard
  // ============================================================
  server.tool(
    "download_firm_scorecard",
    "Generate the firm-wide development meeting scorecard as a downloadable Excel file. Includes weekly and monthly data for all timekeepers. Returns a short-lived direct_download_url (1-hour TTL); if box_folder_id is provided the file is also versioned to Box when possible.",
    {
      week_of: z.string().optional().describe("Date within the target week (YYYY-MM-DD). Defaults to today."),
      box_folder_id: z.string().optional().describe("Box folder ID. If provided and the generated file has an existing overwrite target, the tool versions it in Box. Otherwise (omitted or upload fails) the tool returns a short-lived direct_download_url (1-hour TTL) the user can click to download the file directly — no base64 inlined in the MCP response."),
    },
    async (params) => {
      try {
        const ROSTER = [
          { initials: "PAR", name: "Paul Romano", user_id: 344117381 },
          { initials: "KES", name: "Kenny Sumner", user_id: 344134017 },
          { initials: "NRN", name: "Nicholas Noe", user_id: 348755029 },
          { initials: "NAF", name: "Nicholas Fernelius", user_id: 359380639 },
          { initials: "ACA", name: "Angela Alanis", user_id: 358528744 },
          { initials: "AFL", name: "Anna Lozano", user_id: 358108805 },
          { initials: "AKG", name: "Kaz Gonzalez", user_id: 358550509 },
          { initials: "TBS", name: "Tzipora Simmons", user_id: 359711375 },
          { initials: "MNH", name: "May Huynh", user_id: 359576660 },
          { initials: "JPB", name: "Jonathan Barbee", user_id: 360091325 },
        ];

        const targetDate = params.week_of ?? new Date().toISOString().split("T")[0];
        const d = new Date(targetDate + "T12:00:00");
        const day = d.getDay();
        const monday = new Date(d); monday.setDate(d.getDate() - ((day + 6) % 7));
        const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
        const fmtDate = (dt: Date) => dt.toISOString().split("T")[0];
        const weekStart = fmtDate(monday);
        const weekEnd = fmtDate(sunday);
        const weekLabel = `${monday.toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${sunday.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

        const monthStart = `${targetDate.slice(0, 7)}-01`;
        const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        const monthEnd = fmtDate(mEnd);
        const monthLabel = d.toLocaleDateString("en-US", { month: "long", year: "numeric" });

        // Fetch time entries for the month (covers the week too)
        const entries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          fields: "id,date,quantity,rounded_quantity,price,billed,user{id,name}",
          created_since: `${monthStart}T00:00:00+00:00`,
        }).then(e => e.filter((x: any) => x.date >= monthStart && x.date <= monthEnd));

        // Build per-user weekly + monthly data
        const userData: Record<number, { weekBillable: number; weekNonbillable: number; monthBillable: number; monthNonbillable: number; monthBilledHrs: number; monthUnbilledHrs: number; monthBillableDollars: number }> = {};
        for (const r of ROSTER) {
          userData[r.user_id] = { weekBillable: 0, weekNonbillable: 0, monthBillable: 0, monthNonbillable: 0, monthBilledHrs: 0, monthUnbilledHrs: 0, monthBillableDollars: 0 };
        }

        for (const e of entries) {
          const uid = e.user?.id;
          if (!uid || !userData[uid]) continue;
          // Use rounded_quantity (billed hours) not raw quantity (actual tracked).
          const hours = (e.rounded_quantity ?? e.quantity) / 3600;
          const isBillable = (e.price || 0) > 0;
          const inWeek = e.date >= weekStart && e.date <= weekEnd;

          if (isBillable) {
            userData[uid].monthBillable += hours;
            userData[uid].monthBillableDollars += hours * (e.price || 0);
            if (e.billed) userData[uid].monthBilledHrs += hours; else userData[uid].monthUnbilledHrs += hours;
            if (inWeek) userData[uid].weekBillable += hours;
          } else {
            userData[uid].monthNonbillable += hours;
            if (inWeek) userData[uid].weekNonbillable += hours;
          }
        }

        // Build Excel
        const wb = new ExcelJS.Workbook();

        // Weekly sheet
        const ws1 = wb.addWorksheet("Weekly");
        ws1.columns = [
          { header: "Initials", key: "initials", width: 10 },
          { header: "Name", key: "name", width: 25 },
          { header: "Billable", key: "billable", width: 12 },
          { header: "Nonbillable", key: "nonbillable", width: 14 },
          { header: "Total", key: "total", width: 12 },
        ];
        ws1.getRow(1).font = { bold: true };
        ws1.mergeCells("A1:E1");
        ws1.getCell("A1").value = `Weekly Scorecard: ${weekLabel}`;
        ws1.getCell("A1").font = { bold: true, size: 14 };
        ws1.addRow({}); // blank
        const hRow1 = ws1.addRow(["Initials", "Name", "Billable", "Nonbillable", "Total"]);
        hRow1.font = { bold: true };

        for (const r of ROSTER) {
          const d = userData[r.user_id];
          ws1.addRow([r.initials, r.name, round1(d.weekBillable), round1(d.weekNonbillable), round1(d.weekBillable + d.weekNonbillable)]);
        }

        // Monthly sheet
        const ws2 = wb.addWorksheet("Monthly");
        ws2.mergeCells("A1:H1");
        ws2.getCell("A1").value = `Monthly Scorecard: ${monthLabel}`;
        ws2.getCell("A1").font = { bold: true, size: 14 };
        ws2.addRow({});
        const hRow2 = ws2.addRow(["Initials", "Name", "Billable Hrs", "Billable $", "Billed Hrs", "Unbilled Hrs", "Nonbillable", "Total"]);
        hRow2.font = { bold: true };

        for (const r of ROSTER) {
          const d = userData[r.user_id];
          ws2.addRow([
            r.initials, r.name,
            round1(d.monthBillable), round2(d.monthBillableDollars),
            round1(d.monthBilledHrs), round1(d.monthUnbilledHrs),
            round1(d.monthNonbillable),
            round1(d.monthBillable + d.monthNonbillable),
          ]);
        }

        // Format currency column
        ws2.getColumn(4).numFmt = '"$"#,##0.00';

        const buffer = Buffer.from(await wb.xlsx.writeBuffer());
        const filename = `Firm Scorecard - ${weekLabel.replace(/\//g, "-")}.xlsx`;
        const size_kb = Math.round(buffer.byteLength / 1024);

        if (params.box_folder_id !== undefined) {
          const folderId = params.box_folder_id || "375771584500";
          const result = await uploadToBox({ buffer, filename, folderId });
          if (result.uploaded) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, filename, size_kb: result.size_kb, box_file_id: result.box_file_id, box_url: result.box_url }) }] };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, filename, size_kb: result.size_kb, direct_download_url: result.direct_download_url, expires_at: result.expires_at, reason: result.reason, note: result.note }) }] };
        }

        console.warn(`[Doc] download_firm_scorecard — returning direct_download_url filename=${filename} size_kb=${size_kb}`);
        const reg = registerDownload(buffer, filename, mimeForFilename(filename));
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ filename, format: "xlsx", size_kb, direct_download_url: reg.url, expires_at: reg.expires_at, note: "Download the file from direct_download_url within 1 hour." }) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message }) }], isError: true };
      }
    }
  );

  // ============================================================
  // TOOL 3: download_weekly_goals
  // ============================================================
  server.tool(
    "download_weekly_goals",
    "Generate an individual weekly goals Excel sheet for a specific timekeeper. Includes monthly and weekly breakdowns with goals and over/under tracking. Returns a short-lived direct_download_url (1-hour TTL); if box_folder_id is provided the file is also versioned to Box when possible.",
    {
      user_id: z.coerce.number().describe("User/timekeeper ID"),
      year: z.coerce.number().describe("Year (e.g. 2026)"),
      weekly_billable_goal: z.coerce.number().describe("Weekly billable hours goal (30 for partners/paras, 32 for associates). Monthly goal is derived as weekly × 47 ÷ 12 to match the dashboard."),
      hours_per_day: z.coerce.number().optional().default(8).describe("Hours in a work day (default 8)"),
      box_folder_id: z.string().optional().describe("Box folder ID. If provided and the generated file has an existing overwrite target, the tool versions it in Box. Otherwise (omitted or upload fails) the tool returns a short-lived direct_download_url (1-hour TTL) the user can click to download the file directly — no base64 inlined in the MCP response."),
    },
    async (params) => {
      try {
        const result = await downloadWeeklyGoals({
          user_id: params.user_id,
          year: params.year,
          weekly_billable_goal: params.weekly_billable_goal,
          hours_per_day: params.hours_per_day,
          box_folder_id: params.box_folder_id,
        });

        if (result.box_file_id) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, filename: result.filename, box_file_id: result.box_file_id, box_url: result.box_url }) }] };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ filename: result.filename, format: "xlsx", size_kb: result.size_kb, base64: result.base64 }) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message }) }], isError: true };
      }
    }
  );

  // ============================================================
  // TOOL 3b: download_all_weekly_goals (batch — entire firm)
  // ============================================================
  server.tool(
    "download_all_weekly_goals",
    "Update the weekly goals spreadsheet for all firm timekeepers. " +
    "Runs all uploads in parallel to Box. No arguments required.",
    {
      year: z.number().optional().describe("Year (defaults to current year)"),
      box_folder_id: z.string().optional().describe(
        "Box folder ID to upload to. Omit or pass empty string for default folder."
      ),
    },
    async ({ year, box_folder_id }) => {
      const targetYear = year ?? new Date().getFullYear();
      const folderId = box_folder_id ?? "";

      const results = await Promise.allSettled(
        WEEKLY_GOALS_ROSTER.map(({ name, user_id, goal, group }) =>
          downloadWeeklyGoals({
            user_id,
            weekly_billable_goal: goal,
            year: targetYear,
            box_folder_id: folderId,
          }).then((res: any) => {
            const uploaded = !!res.box_file_id;
            return {
              name,
              group,
              status: uploaded ? ("uploaded" as const) : ("download_link" as const),
              filename: res.filename ?? null,
              box_url: res.box_url ?? null,
              box_file_id: res.box_file_id ?? null,
              direct_download_url: res.direct_download_url ?? null,
              expires_at: res.expires_at ?? null,
              reason: res.reason ?? null,
            };
          })
            .catch((err: Error) => ({
              name,
              group,
              status: `FAILED: ${err.message}` as const,
              filename: null,
              box_url: null,
              box_file_id: null,
              direct_download_url: null,
              expires_at: null,
              reason: err.message,
            }))
        )
      );

      const uploads = results.map((r) => (r.status === "fulfilled" ? r.value : r.reason));

      // Group by team
      const groups: Record<string, any[]> = {};
      for (const u of uploads) {
        const g = u.group || "Other";
        if (!groups[g]) groups[g] = [];
        groups[g].push({
          name: u.name,
          status: u.status,
          filename: u.filename,
          box_url: u.box_url,
          box_file_id: u.box_file_id,
          direct_download_url: u.direct_download_url,
          expires_at: u.expires_at,
        });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            year: targetYear,
            count: uploads.length,
            succeeded: uploads.filter((u: any) => u.status === "uploaded").length,
            download_link: uploads.filter((u: any) => u.status === "download_link").length,
            failed: uploads.filter((u: any) => typeof u.status === "string" && u.status.startsWith("FAILED")).length,
            by_team: groups,
          }, null, 2),
        }],
      };
    }
  );

  // ============================================================
  // DIAGNOSTIC: probe_clio_report_apis  (read-only)
  // Determines whether Clio's new "Custom Reports" (beta) engine is reachable
  // via the API and under what path, vs the classic /reports surface the
  // dashboard tool uses. Hits candidate endpoints with the firm's token and
  // reports HTTP status + response shape, plus enumerates the classic reports.
  // ============================================================
  server.tool(
    "probe_clio_report_apis",
    "Diagnostic (read-only). Probes candidate Clio report API endpoints with the firm's token and returns HTTP status + response shape for each, to discover whether the new 'Custom Reports' (beta) reporting engine is API-accessible and under what path (vs the classic /reports endpoint the dashboard uses). Also enumerates classic /reports by kind/name/format so a missing or mis-grouped report can be spotted. Run this when the dashboard can't find the expected Revenue Report.",
    {},
    async () => {
      const out: any = {};

      // 1) Report Presets — this is where grouping (group_by) and scheduled-report
      // config live in the classic API. If the "NRN Copy…(like Classic)" report is
      // a classic preset, it'll appear here WITH its options (group_by etc.), and we
      // can generate it on demand. If it's not here, it's beta-only.
      try {
        const presets = await fetchAllPages<any>("/report_presets", {
          fields: "id,name,kind,format,category,options,disabled,report_schedule{id,frequency,next_scheduled_date}",
          order: "name(asc)", // /report_presets rejects the default order=id (422)
        });
        out.report_presets = presets.map((p: any) => ({
          id: p.id, name: p.name, kind: p.kind, format: p.format, category: p.category,
          disabled: p.disabled, options: p.options, report_schedule: p.report_schedule,
        }));
      } catch (e: any) {
        out.report_presets = { error: e?.response?.status ?? String(e), detail: typeof e?.response?.data === "string" ? e.response.data.slice(0, 200) : undefined };
      }

      // 2) Report Schedules
      try {
        out.report_schedules = await fetchAllPages<any>("/report_schedules", {
          fields: "id,frequency,report_preset_id,next_scheduled_date,status,day_of_month,days_of_week",
        });
      } catch (e: any) {
        out.report_schedules = { error: e?.response?.status ?? String(e) };
      }

      // 3) /reports — break down by kind AND source (beta reports, if they land in
      // /reports at all, would show a non-"reports" source), plus recent revenue-kind
      // and completed-CSV reports.
      try {
        const reps = await fetchAllPages<any>("/reports", { fields: "id,name,state,kind,format,source,category,created_at", order: "name(asc)" });
        const byKind: Record<string, number> = {};
        const bySource: Record<string, number> = {};
        for (const r of reps) {
          byKind[r.kind ?? "?"] = (byKind[r.kind ?? "?"] || 0) + 1;
          bySource[r.source ?? "?"] = (bySource[r.source ?? "?"] || 0) + 1;
        }
        out.reports = {
          total: reps.length, by_kind: byKind, by_source: bySource,
          revenue_kind: reps.filter((r: any) => r.kind === "revenue").slice(0, 25)
            .map((r: any) => ({ id: r.id, name: r.name, state: r.state, format: r.format, source: r.source, created_at: r.created_at })),
          completed_csv: reps.filter((r: any) => r.state === "completed" && r.format === "csv").slice(0, 40)
            .map((r: any) => ({ id: r.id, name: r.name, kind: r.kind, source: r.source })),
        };
      } catch (e: any) {
        out.reports = { error: e?.response?.status ?? String(e) };
      }

      // 4) Quick guesses at any separate new-engine endpoints (likely 404 if beta-only).
      out.new_engine_guesses = [];
      for (const path of ["/custom_reports", "/reporting/custom_reports", "/insights"]) {
        try { await rawGetSingle(path, { limit: 1 }); out.new_engine_guesses.push({ path, status: 200 }); }
        catch (e: any) { out.new_engine_guesses.push({ path, status: e?.response?.status ?? "ERR" }); }
      }

      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
  );

  // ============================================================
  // Report Preset tooling (classic API): list presets + their options,
  // create a preset, and generate-on-demand from a preset. Beta custom
  // reports are backed by classic ReportPresets (a report_schedule points at
  // a report_preset_id), so generate_report_from_preset can produce that
  // report NOW — a normal /reports entry, downloadable, usable as
  // download_dashboard_update's revenue_report_id — without waiting on a schedule.
  // ============================================================
  server.tool(
    "list_report_presets",
    "List classic Clio Report Presets with their options (group_by, date_range, etc.). Beta custom reports are backed by presets too, so this reveals the exact options schema and the preset_id behind a scheduled/beta report. Read-only.",
    {},
    async () => {
      try {
        const presets = await fetchAllPages<any>("/report_presets", { fields: "id,name,kind,format,category,disabled,options", order: "name(asc)" });
        return { content: [{ type: "text", text: JSON.stringify(presets.map((p: any) => ({ id: p.id, name: p.name, kind: p.kind, format: p.format, category: p.category, disabled: p.disabled, options: p.options })), null, 2) }] };
      } catch (e: any) {
        // Fallback: the list endpoint may reject the `options` field; fetch options per-record.
        try {
          const presets = await fetchAllPages<any>("/report_presets", { fields: "id,name,kind,format,category,disabled", order: "name(asc)" });
          const detailed: any[] = [];
          for (const p of presets.slice(0, 25)) {
            try { const one = await rawGetSingle(`/report_presets/${p.id}`, { fields: "id,name,kind,format,options" }); detailed.push(one?.data ?? one); }
            catch { detailed.push({ id: p.id, name: p.name, kind: p.kind, options: "(options fetch failed)" }); }
          }
          return { content: [{ type: "text", text: JSON.stringify(detailed, null, 2) }] };
        } catch (e2: any) {
          return { content: [{ type: "text", text: JSON.stringify({ error: e2?.response?.status ?? String(e2), detail: typeof e2?.response?.data === "string" ? e2.response.data.slice(0, 300) : e2?.response?.data }, null, 2) }] };
        }
      }
    }
  );

  server.tool(
    "create_report_preset",
    "Create a classic Clio Report Preset (POST /report_presets). Provide kind (e.g. 'revenue'), format (default csv), and the kind-specific options object (group_by, date_range, start_date, end_date, kind). Returns the created preset or the API error detail. Model options on an existing preset from list_report_presets.",
    {
      name: z.string().describe("Preset name"),
      kind: z.string().describe("Report kind, e.g. 'revenue'"),
      format: z.string().default("csv").describe("csv | xlsx | pdf | html | json | zip"),
      options: z.record(z.any()).describe("Options object, e.g. { date_range:'this_month', format:'csv', group_by:'user', kind:'revenue' }"),
    },
    async (p) => {
      try {
        const res = await rawPostSingle("/report_presets", { data: { name: p.name, kind: p.kind, format: p.format, options: p.options } });
        return { content: [{ type: "text", text: JSON.stringify(res?.data ?? res, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e?.response?.status ?? String(e), detail: e?.response?.data }, null, 2) }] };
      }
    }
  );

  server.tool(
    "generate_report_from_preset",
    "Generate a report on demand from a Report Preset (POST /report_presets/{id}/generate_report), poll until complete (bounded), and return the new report's id, state, and CSV header columns + first row so the grouping/columns can be verified. The returned report_id is a classic /reports id usable as download_dashboard_update's revenue_report_id. Use this to produce a beta/scheduled report's output NOW instead of waiting for its schedule.",
    {
      preset_id: z.coerce.number().describe("ReportPreset id (from list_report_presets, or a report_schedule's report_preset_id)"),
      poll_seconds: z.coerce.number().default(90).describe("Max seconds to poll for completion"),
    },
    async (p) => {
      try {
        const gen = await rawPostSingle(`/report_presets/${p.preset_id}/generate_report`, {});
        const rep = gen?.data ?? gen;
        const reportId = rep?.id;
        let state = rep?.state;
        const deadline = Date.now() + p.poll_seconds * 1000;
        while (reportId && !["completed", "failed", "empty"].includes(state) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 4000));
          try { const s = await rawGetSingle(`/reports/${reportId}`, { fields: "id,name,state,format,progress" }); state = (s?.data ?? s)?.state; }
          catch { break; }
        }
        let columns: string[] = [];
        let firstRow: any = null;
        if (state === "completed") {
          try { const rows = parseCSV(await downloadReport(reportId)); columns = rows[0] ? Object.keys(rows[0]) : []; firstRow = rows[0] ?? null; }
          catch { /* download/parse failed — state still reported */ }
        }
        return { content: [{ type: "text", text: JSON.stringify({ report_id: reportId, state, columns, firstRow }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e?.response?.status ?? String(e), detail: e?.response?.data }, null, 2) }] };
      }
    }
  );

  server.tool(
    "generate_classic_report",
    "Generate a classic Clio report on demand (POST /reports) with explicit parameters — kind, format, an explicit date range, and optional user / responsible_attorney scope — then poll to completion and return report_id, state, CSV columns, row count, and the first rows. Use to produce a per-timekeeper revenue report (kind='revenue', user_id=…, start_date/end_date for the target month) or a firm-wide one. The returned report_id can be passed to download_dashboard_update as revenue_report_id.",
    {
      kind: z.string().default("revenue").describe("Report kind, e.g. 'revenue', 'productivity_by_user'"),
      format: z.string().default("csv").describe("csv | xlsx | pdf | html | json | zip"),
      start_date: z.string().describe("Inclusive start date, YYYY-MM-DD"),
      end_date: z.string().describe("Inclusive end date, YYYY-MM-DD"),
      user_id: z.coerce.number().optional().describe("Scope to a single working timekeeper (for per-attorney revenue)"),
      responsible_attorney_id: z.coerce.number().optional().describe("Scope to a responsible attorney"),
      poll_seconds: z.coerce.number().default(120).describe("Max seconds to poll for completion"),
    },
    async (p) => {
      try {
        const data: any = { kind: p.kind, format: p.format, start_date: p.start_date, end_date: p.end_date };
        if (p.user_id) data.user = { id: p.user_id };
        if (p.responsible_attorney_id) data.responsible_attorney = { id: p.responsible_attorney_id };
        const gen = await rawPostSingle("/reports", { data });
        const rep = gen?.data ?? gen;
        const reportId = rep?.id;
        let state = rep?.state;
        const deadline = Date.now() + p.poll_seconds * 1000;
        while (reportId && !["completed", "failed", "empty"].includes(state) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 4000));
          try { const s = await rawGetSingle(`/reports/${reportId}`, { fields: "id,name,state,format,progress" }); state = (s?.data ?? s)?.state; }
          catch { break; }
        }
        let columns: string[] = [];
        let rowCount = 0;
        let sample: any[] = [];
        if (state === "completed") {
          try { const rows = parseCSV(await downloadReport(reportId)); rowCount = rows.length; columns = rows[0] ? Object.keys(rows[0]) : []; sample = rows.slice(0, 3); }
          catch { /* download/parse failed — state still reported */ }
        }
        return { content: [{ type: "text", text: JSON.stringify({ report_id: reportId, state, columns, rowCount, sample }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e?.response?.status ?? String(e), detail: e?.response?.data }, null, 2) }] };
      }
    }
  );

  server.tool(
    "get_report",
    "Fetch a Clio report by ID: returns its state/kind/format/source, and if completed and CSV, the columns, row count, and first rows. Decouples retrieval from generation — use it to pull a report that finished server-side after a generate call timed out, instead of regenerating (each regenerate spawns a new report). A completed CSV report's id can be passed to download_dashboard_update as revenue_report_id.",
    {
      report_id: z.coerce.number().describe("The Clio report id"),
      rows_sample: z.coerce.number().default(5).describe("How many CSV rows to return as a sample"),
    },
    async (p) => {
      try {
        const meta = await rawGetSingle(`/reports/${p.report_id}`, { fields: "id,name,state,kind,format,progress,source,category,created_at" });
        const m = meta?.data ?? meta;
        let columns: string[] = [];
        let rowCount = 0;
        let sample: any[] = [];
        if (m?.state === "completed" && m?.format === "csv") {
          try { const rows = parseCSV(await downloadReport(p.report_id)); rowCount = rows.length; columns = rows[0] ? Object.keys(rows[0]) : []; sample = rows.slice(0, p.rows_sample); }
          catch { /* download/parse failed — meta still returned */ }
        }
        return { content: [{ type: "text", text: JSON.stringify({ report: { id: m?.id, name: m?.name, state: m?.state, kind: m?.kind, format: m?.format, progress: m?.progress, source: m?.source, created_at: m?.created_at }, columns, rowCount, sample }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e?.response?.status ?? String(e), detail: e?.response?.data }, null, 2) }] };
      }
    }
  );

  // ============================================================
  // TOOL 4: download_dashboard_update
  // ============================================================
  server.tool(
    "download_dashboard_update",
    "Update Rachel's firm dashboard (the 'Claude Version 2' workbook in Box) for the specified month. Sources actual billed figures (billed $, write-offs, line discounts, billable hours — by timekeeper AND responsible attorney), not a hours×rate reconstruction. Revenue source, in priority order: (1) revenue_csv_box_file_id — a month×user 'Revenue Report (Like Classic)' CSV in Box (covers all YTD months in one file); (2) revenue_report_id — same month×user shape from Clio /reports; (3) DEFAULT — replicates Rachel's manual classic method: generates a per-timekeeper classic revenue report for each roster member plus one firm-wide report, for the TARGET MONTH only, on demand (revenue honors the date range). Nonbillable D/E/F/G come from a targeted /activities query on the admin matters (00706/00050/00707/00158); collections from the Fee Allocation Report (target month only). The month×user sources rewrite all YTD months; the classic default writes the target month only. Nonbillable categories (Biz Dev / Potential Clients / CLE) come from a small targeted /activities query on just the admin matters; Other Admin is the remainder. Collections (cols N + S) come from the Fee Allocation Report and are written for the target month only (that CSV is single-period). REWRITES the hours/billable/billed/write-off/discount columns for ALL year-to-date months (Jan through target) in '26 Compare', then rebuilds the Bonus Config/Tracker and Attorney Performance tabs and versions the file back to Box. Pass revenue_report_id to force a specific report if auto-selection picks the wrong one. If the Box upload fails, returns a short-lived direct_download_url (1-hour TTL) instead.",
    {
      month: z.coerce.number().describe("Month number (1-12)"),
      year: z.coerce.number().describe("Year (e.g. 2026)"),
      revenue_report_id: z.coerce.number().optional().describe("Specific Clio report ID for the monthly classic Revenue Report (overrides auto-selection by header signature). Use when multiple revenue-style reports exist and the wrong one is being picked."),
      revenue_csv_box_file_id: z.string().optional().describe("Box file ID of a manually-exported month×user Revenue Report CSV (the beta 'Revenue Report (Like Classic)', grouped by Activity month + User). When set, the dashboard reads revenue from this Box CSV instead of Clio's /reports — the reliable path when the report lives in Clio's beta engine (no API) or the report-generation endpoint is flaky."),
      box_folder_id: z.string().optional().describe("Deprecated / ignored. The tool always versions the Claude Version 2 workbook in its fixed Box folder."),
      update_existing: z.boolean().optional().describe("Deprecated / ignored. The full dashboard update now always runs; this flag no longer changes behavior."),
    },
    async (params) => {
      const jobId = `dash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const job: DashJob = { id: jobId, status: "running", started_at: new Date().toISOString() };
      dashboardJobs.set(jobId, job);
      pruneDashboardJobs();
      // Run detached so the MCP call returns immediately (the work outlasts the
      // ~180s client timeout). Result/error are recorded on the job for polling.
      (async () => {
      let _step = "init";
      try {
        const ROSTER = [
          { initials: "PAR", name: "Paul Romano", user_id: 344117381 },
          { initials: "KES", name: "Kenny Sumner", user_id: 344134017 },
          { initials: "NRN", name: "Nicholas Noe", user_id: 348755029 },
          { initials: "NAF", name: "Nicholas Fernelius", user_id: 359380639 },
          { initials: "ACA", name: "Angela Alanis", user_id: 358528744 },
          { initials: "AFL", name: "Anna Lozano", user_id: 358108805 },
          { initials: "AKG", name: "Kaz Gonzalez", user_id: 358550509 },
          { initials: "TBS", name: "Tzipora Simmons", user_id: 359711375 },
          { initials: "MNH", name: "May Huynh", user_id: 359576660 },
          { initials: "JPB", name: "Jonathan Barbee", user_id: 360091325 },
          { initials: "KGV", name: "Gus Vlahadamis", user_id: 360049685 },
          { initials: "CTD", name: "Courteney Daniel", user_id: 359865560 },
        ];

        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const monthName = monthNames[params.month - 1];
        const monthStart = `${params.year}-${String(params.month).padStart(2, "0")}-01`;
        const endDay = new Date(params.year, params.month, 0).getDate();
        const monthEnd = `${params.year}-${String(params.month).padStart(2, "0")}-${endDay}`;

        type PerUserData = {
          billableHrs: number; nonbillableHrs: number; billedHrs: number; unbilledHrs: number;
          billableDollars: number; billedDollars: number; writeOffs: number; lineDiscounts: number;
          bizDev: number; potentialClients: number; cle: number; otherAdmin: number;
          indivCollected: number; respCollected: number;
        };
        type MonthBundle = { month: number; monthName: string; data: Record<number, PerUserData>; respData: Record<number, { respHrs: number; respBilled: number }> };
        const newPerUser = (): PerUserData => ({
          billableHrs: 0, nonbillableHrs: 0, billedHrs: 0, unbilledHrs: 0,
          billableDollars: 0, billedDollars: 0, writeOffs: 0, lineDiscounts: 0,
          bizDev: 0, potentialClients: 0, cle: 0, otherAdmin: 0,
          indivCollected: 0, respCollected: 0,
        });

        // ---- Pull all numeric metrics from the monthly classic Revenue Report ----
        // ONE download carries every YTD month. Per row (Activity month × User ×
        // Responsible attorney) we get the authoritative billed/billable/write-off/
        // discount figures — no firm-wide /activities pagination, no hours×rate
        // reconstruction. Individual columns aggregate by User; the Responsible
        // section aggregates the same rows by Responsible attorney (so staff work
        // rolls up under the responsible attorney even though the timekeeper isn't
        // on the roster).
        const num = (v: string | undefined) => { const n = parseFloat(v ?? ""); return isNaN(n) ? 0 : n; };
        // month -> user_id -> indiv metrics ; month -> responsible user_id -> rollup
        const indivByMonth: Record<number, Record<number, PerUserData>> = {};
        const respByMonth: Record<number, Record<number, { respHrs: number; respBilled: number }>> = {};

        // Revenue source:
        //   (A) month×user "(like Classic)" CSV — from Box (revenue_csv_box_file_id)
        //       or Clio /reports (revenue_report_id). Covers all YTD months in one file.
        //   (B) DEFAULT: classic per-timekeeper revenue, Rachel's manual method — 12
        //       per-user revenue reports (individual) + 1 firm-wide (responsible),
        //       generated on demand for the TARGET MONTH only. revenue honors the
        //       date range (unlike productivity_by_user, which ignores it).
        const useBox = !!params.revenue_csv_box_file_id;
        const useBeta = useBox || params.revenue_report_id != null;
        let revLabel = "";

        if (useBeta) {
          _step = "downloading Revenue Report (month×user)";
          const { rows: revRows } = useBox
            ? { rows: parseCSV((await downloadFromBox(params.revenue_csv_box_file_id!)).toString("utf8")) }
            : await getRevenueReportCSV(params.revenue_report_id);
          if (!revRows.length || !REVENUE_REPORT_SIGNATURE.every((c) => c in revRows[0])) {
            throw new Error(`Revenue CSV is missing required columns (${REVENUE_REPORT_SIGNATURE.join(", ")}). ${useBox ? `The Box file ${params.revenue_csv_box_file_id} isn't a month×user Revenue Report (got: ${revRows[0] ? Object.keys(revRows[0]).join(", ") : "empty"}).` : ""}`);
          }
          for (const row of revRows) {
            const m = parseInt(row["Activity month"] || "0", 10);
            if (!m || m < 1 || m > params.month) continue;
            const billableHrs = num(row["Billable hours"]);
            const billedDollars = num(row["Billed hours value"]);
            const uid = matchRosterUser(row["User"] || "", ROSTER);
            if (uid != null) {
              const d = ((indivByMonth[m] ??= {})[uid] ??= newPerUser());
              d.billableHrs += billableHrs;
              d.billedDollars += billedDollars;
              d.writeOffs += num(row["Credited hours value"]);
              d.lineDiscounts += Math.abs(num(row["Discounted hours amount"]));
              d.nonbillableHrs += num(row["Non-billable hours"]);
            }
            const rid = matchRosterResponsible(row["Responsible attorney"] || "", ROSTER);
            if (rid != null) {
              const rd = ((respByMonth[m] ??= {})[rid] ??= { respHrs: 0, respBilled: 0 });
              rd.respHrs += billableHrs;
              rd.respBilled += billedDollars;
            }
          }
          revLabel = `month×user (${useBox ? "Box CSV" : "/reports #" + params.revenue_report_id}) rows=${revRows.length}`;
        } else {
          _step = "generating classic revenue reports (per timekeeper + firm-wide)";
          // Generate a classic revenue report (optional user scope) for the target
          // month, poll to completion (the endpoint is flaky), then download + parse.
          const genRevenueRows = async (userId?: number): Promise<Record<string, string>[]> => {
            const data: any = { kind: "revenue", format: "csv", start_date: monthStart, end_date: monthEnd };
            if (userId) data.user = { id: userId };
            const gen = await rawPostSingle("/reports", { data });
            const rep = gen?.data ?? gen;
            const rid = rep?.id;
            let state = rep?.state;
            const deadline = Date.now() + 150000;
            while (rid && !["completed", "failed", "empty"].includes(state) && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 4000));
              try { const s = await rawGetSingle(`/reports/${rid}`, { fields: "id,state" }); state = (s?.data ?? s)?.state; }
              catch { /* transient — keep polling */ }
            }
            if (state !== "completed") throw new Error(`revenue report ${rid} did not complete (state=${state})`);
            return parseCSV(await downloadReport(rid));
          };
          const m = params.month;
          // Firm-wide → responsible-attorney rollup (skip the trailing TOTAL row, which has no Matter Number)
          const firmRows = await genRevenueRows();
          for (const row of firmRows) {
            if (!row["Matter Number"]) continue;
            const rid = matchRosterResponsible(row["Responsible Attorney"] || "", ROSTER);
            if (rid == null) continue;
            const rd = ((respByMonth[m] ??= {})[rid] ??= { respHrs: 0, respBilled: 0 });
            rd.respHrs += num(row["Billed Hours"]) + num(row["Unbilled Hours"]);
            rd.respBilled += num(row["Billed Time"]);
          }
          // Per-timekeeper → individual (one revenue report scoped to each user)
          let okUsers = 0;
          for (const ro of ROSTER) {
            let rows: Record<string, string>[];
            try { rows = await genRevenueRows(ro.user_id); }
            catch (e: any) { console.warn(`[Dashboard] classic revenue failed for ${ro.initials}: ${e?.message ?? e}`); continue; }
            const d = ((indivByMonth[m] ??= {})[ro.user_id] ??= newPerUser());
            for (const row of rows) {
              if (!row["Matter Number"]) continue;
              d.billedDollars += num(row["Billed Time"]);
              d.billableHrs += num(row["Billed Hours"]) + num(row["Unbilled Hours"]);
              d.writeOffs += num(row["Credit Notes"]);
              d.lineDiscounts += num(row["Discounted Time"]);
            }
            okUsers++;
          }
          revLabel = `classic per-timekeeper (${okUsers}/${ROSTER.length} users) + firm-wide, month ${m}`;
        }
        // Months we have revenue data for: all YTD for the month×user file; target-only for classic.
        const revMonths = useBeta ? Array.from({ length: params.month }, (_, i) => i + 1) : [params.month];

        // ---- Nonbillable categories via a targeted /activities query (Rachel #1–4) ----
        // Revenue reports don't carry nonbillable time, so the four nonbillable
        // buckets come straight from their admin matters, exactly as Rachel pulls
        // them: Biz Dev (00706), Potential Clients (00050), CLE (00707), Other
        // Admin (00158). Total nonbillable = the sum of these four.
        _step = "resolving nonbillable category matters";
        type CatKey = "bizDev" | "potentialClients" | "cle" | "otherAdmin";
        const CATEGORY_PREFIXES: { key: CatKey; prefix: string }[] = [
          { key: "bizDev", prefix: "00706" },           // ROMSUM Business Development
          { key: "potentialClients", prefix: "00050" }, // Potential Clients
          { key: "cle", prefix: "00707" },              // Continuing Legal Education
          { key: "otherAdmin", prefix: "00158" },       // Other Admin
        ];
        const allMatters = await fetchAllPages<any>("/matters", { fields: "id,display_number" });
        const matterCat: Record<number, CatKey> = {};
        for (const cm of CATEGORY_PREFIXES) {
          for (const mt of allMatters) {
            if (String(mt.display_number || "").startsWith(cm.prefix)) matterCat[mt.id] = cm.key;
          }
        }

        _step = "fetching nonbillable category activities";
        // month -> user_id -> { bizDev, potentialClients, cle, otherAdmin }
        const catByMonth: Record<number, Record<number, { bizDev: number; potentialClients: number; cle: number; otherAdmin: number }>> = {};
        for (const mid of Object.keys(matterCat).map(Number)) {
          const acts = await fetchAllPages<any>("/activities", {
            type: "TimeEntry",
            fields: "id,date,quantity,rounded_quantity,user{id}",
            matter_id: mid,
            created_since: `${params.year}-01-01T00:00:00+00:00`,
          });
          const cat = matterCat[mid];
          for (const a of acts) {
            if (a.date < `${params.year}-01-01` || a.date > monthEnd) continue;
            const m = parseInt(String(a.date).slice(5, 7), 10);
            if (!m || m > params.month) continue;
            const uid = a.user?.id;
            if (!uid) continue;
            const slot = ((catByMonth[m] ??= {})[uid] ??= { bizDev: 0, potentialClients: 0, cle: 0, otherAdmin: 0 });
            slot[cat] += (a.rounded_quantity ?? a.quantity) / 3600;
          }
        }

        // ---- Fetch fee allocation CSV for collections (target month only) ----
        let csvRows: Record<string, string>[] = [];
        try { const result = await getFeeAllocationCSV(); csvRows = result.rows; } catch { /* may not exist */ }

        // ---- Assemble per-month bundles (only the months we have revenue for) ----
        const monthsData: MonthBundle[] = [];
        for (const m of revMonths) {
          const md: Record<number, PerUserData> = {};
          const mrd: Record<number, { respHrs: number; respBilled: number }> = {};
          for (const r of ROSTER) {
            const src = indivByMonth[m]?.[r.user_id];
            const cat = catByMonth[m]?.[r.user_id];
            const d = newPerUser();
            if (src) {
              d.billableHrs = src.billableHrs;
              d.billedDollars = src.billedDollars;
              d.writeOffs = src.writeOffs;
              d.lineDiscounts = src.lineDiscounts;
            }
            d.bizDev = cat?.bizDev ?? 0;
            d.potentialClients = cat?.potentialClients ?? 0;
            d.cle = cat?.cle ?? 0;
            d.otherAdmin = cat?.otherAdmin ?? 0;
            // Total nonbillable = sum of the four tracked categories (Rachel's definition).
            d.nonbillableHrs = d.bizDev + d.potentialClients + d.cle + d.otherAdmin;
            md[r.user_id] = d;
            mrd[r.user_id] = respByMonth[m]?.[r.user_id] ?? { respHrs: 0, respBilled: 0 };
          }
          monthsData.push({ month: m, monthName: monthNames[m - 1], data: md, respData: mrd });
        }
        console.log(`[Dashboard] revenue source: ${revLabel}; months_built=${monthsData.length}`);

        // ---- Collections from fee allocation CSV (target month only) ----
        // The fee allocation CSV is single-period, so collections are written
        // only for the target month (prior months keep their existing values).
        const targetBundle = monthsData.find((b) => b.month === params.month)!;
        for (const r of csvRows) {
          const userName = r["User"] ?? "";
          const responsible = r["Responsible Attorney"] ?? "";
          const collected = parseFloat(r["Total Funds Collected"] || "0");
          const matchedUser = ROSTER.find(ro => userName.toLowerCase().includes(ro.name.toLowerCase().split(" ").pop()!));
          if (matchedUser && targetBundle.data[matchedUser.user_id]) {
            targetBundle.data[matchedUser.user_id].indivCollected += collected;
          }
          const matchedResp = ROSTER.find(ro => responsible.toLowerCase().includes(ro.name.toLowerCase().split(" ").pop()!));
          if (matchedResp && targetBundle.data[matchedResp.user_id]) {
            targetBundle.data[matchedResp.user_id].respCollected += collected;
          }
        }

        // ---- UPDATE THE DASHBOARD IN BOX ----
        // The rich update always runs and always versions Claude Version 2 —
        // the legacy single-sheet build was retired so no call can overwrite
        // the dashboard with a stub. (update_existing / box_folder_id are kept
        // in the schema for backward compatibility but no longer change paths.)
        {
          const DASHBOARD_FILE_ID = "2199324794140"; // Claude Version 2
          _step = "downloading from Box";
          const fileBuffer = await downloadFromBox(DASHBOARD_FILE_ID);
          _step = "loading workbook";
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(fileBuffer);
          _step = "getting 26 Compare sheet";

          const compareSheet = wb.getWorksheet("26 Compare");
          if (!compareSheet) throw new Error("Sheet '26 Compare' not found in dashboard workbook.");

          // ---- Helper: scan a month block in 26 Compare ----
          // Every row in a block has the month name in col B and initials in col C.
          type MonthBlock = { firstRow: number; lastRow: number; sumRow: number; map: Record<string, number>; initials: string[] };
          function scanMonthBlock(sheet: ExcelJS.Worksheet, targetMonth: string): MonthBlock | null {
            const map: Record<string, number> = {};
            const initials: string[] = [];
            let firstRow = 0, lastRow = 0, sumRow = 0;
            sheet.eachRow((row, rowNum) => {
              const bVal = String(row.getCell(2).value ?? "").trim();
              if (bVal !== targetMonth) return;
              const cVal = String(row.getCell(3).value ?? "").trim();
              if (!firstRow) firstRow = rowNum;
              if (cVal) {
                if (!map[cVal.toUpperCase()]) { map[cVal.toUpperCase()] = rowNum; initials.push(cVal.toUpperCase()); }
                lastRow = rowNum;
              } else {
                sumRow = rowNum;
              }
            });
            return firstRow ? { firstRow, lastRow, sumRow, map, initials } : null;
          }

          // Scan January block (always exists)
          const janBlock = scanMonthBlock(compareSheet, "January");
          if (!janBlock) throw new Error("January block not found in 26 Compare.");

          _step = "creating month block";
          // ---- Create month block if it doesn't exist (overwrite approach) ----
          let monthBlock = scanMonthBlock(compareSheet, monthName);
          let blockCreated = false;

          if (!monthBlock) {
            // Find "2026 Totals" section
            let totalsFirstRow = 0;
            compareSheet.eachRow((row, rowNum) => {
              if (String(row.getCell(2).value ?? "").trim() === "2026 Totals" && !totalsFirstRow) totalsFirstRow = rowNum;
            });

            // Find last existing month's SUM row
            let lastSumRow = 0;
            for (let mi = params.month - 2; mi >= 0; mi--) {
              const prev = scanMonthBlock(compareSheet, monthNames[mi]);
              if (prev?.sumRow) { lastSumRow = prev.sumRow; break; }
            }

            // New month block starts 3 rows after last SUM (gap rows)
            const blockStart = lastSumRow ? lastSumRow + 3 : (totalsFirstRow || compareSheet.rowCount + 3);
            const templateInitials = janBlock.initials;
            const blockSize = templateInitials.length;

            // Write new month block data rows
            const newMap: Record<string, number> = {};
            const newInitials: string[] = [];
            for (let i = 0; i < blockSize; i++) {
              const rowNum = blockStart + i;
              const row = compareSheet.getRow(rowNum);
              row.getCell(2).value = monthName;
              row.getCell(3).value = templateInitials[i];
              newMap[templateInitials[i]] = rowNum;
              newInitials.push(templateInitials[i]);
              row.commit();
            }

            // Write SUM row for the new month
            const newSumRow = blockStart + blockSize;
            const sumRow = compareSheet.getRow(newSumRow);
            sumRow.getCell(2).value = monthName;
            const colLetters = ["D","E","F","G","H","I","J","K","L","M","N","O","Q","R","S"];
            const colNums =    [ 4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 17, 18, 19];
            for (let ci = 0; ci < colLetters.length; ci++) {
              sumRow.getCell(colNums[ci]).value = { formula: `SUM(${colLetters[ci]}${blockStart}:${colLetters[ci]}${blockStart + blockSize - 1})` } as any;
            }
            sumRow.commit();

            // Rewrite "2026 Totals" section after the new block
            // First, collect all existing month blocks to build totals formulas
            const allBlocks: MonthBlock[] = [];
            for (let mi = 0; mi < params.month; mi++) {
              const b = mi === params.month - 1
                ? { firstRow: blockStart, lastRow: blockStart + blockSize - 1, sumRow: newSumRow, map: newMap, initials: newInitials }
                : scanMonthBlock(compareSheet, monthNames[mi]);
              if (b) allBlocks.push(b);
            }

            // Clear old 2026 Totals rows if they exist
            if (totalsFirstRow) {
              for (let r = totalsFirstRow; r <= totalsFirstRow + blockSize + 2; r++) {
                const row = compareSheet.getRow(r);
                for (let c = 1; c <= 19; c++) row.getCell(c).value = null;
                row.commit();
              }
            }

            // Write new 2026 Totals starting 3 rows after new month's SUM
            const newTotalsStart = newSumRow + 3;
            for (let i = 0; i < templateInitials.length; i++) {
              const ini = templateInitials[i];
              const rowNum = newTotalsStart + i;
              const row = compareSheet.getRow(rowNum);
              row.getCell(2).value = "2026 Totals";
              row.getCell(3).value = ini;
              // For each data column, sum that initials' row across all month blocks
              for (let ci = 0; ci < colLetters.length; ci++) {
                const refs = allBlocks.map(b => b.map[ini] ? `${colLetters[ci]}${b.map[ini]}` : null).filter(Boolean);
                if (refs.length > 0) {
                  row.getCell(colNums[ci]).value = { formula: refs.join("+") } as any;
                }
              }
              row.commit();
            }

            // Totals SUM row
            const totalsSumRowNum = newTotalsStart + templateInitials.length;
            const totalsSumRow = compareSheet.getRow(totalsSumRowNum);
            totalsSumRow.getCell(2).value = "2026 Totals";
            for (let ci = 0; ci < colLetters.length; ci++) {
              totalsSumRow.getCell(colNums[ci]).value = { formula: `SUM(${colLetters[ci]}${newTotalsStart}:${colLetters[ci]}${newTotalsStart + templateInitials.length - 1})` } as any;
            }
            totalsSumRow.commit();

            monthBlock = { firstRow: blockStart, lastRow: blockStart + blockSize - 1, sumRow: newSumRow, map: newMap, initials: newInitials };
            blockCreated = true;
          }

          const initialsRowMap = monthBlock.map;

          // ---- ALL YTD MONTHS ----
          // monthsData (months 1..target) was built upfront from the Revenue
          // Report + targeted nonbillable query. Collections (cols N=14, S=19)
          // live only on the target-month bundle because the fee allocation CSV
          // is single-period; prior months keep their existing collection values
          // (we deliberately skip writing N/S for non-target months below).
          _step = "writing Clio data to 26 Compare (all months)";
          let tkUpdated = 0;
          let monthsSkipped = 0;
          for (const md of monthsData) {
            const block = md.month === params.month ? monthBlock : scanMonthBlock(compareSheet, md.monthName);
            if (!block) {
              console.warn(`[Dashboard] no month block for ${md.monthName} — skipping (run the tool with month=${md.month} to create it)`);
              monthsSkipped++;
              continue;
            }
            const rowMap = block.map;
            const isTarget = md.month === params.month;
            for (const r of ROSTER) {
              const row = rowMap[r.initials.toUpperCase()];
              if (!row) continue;
              const d = md.data[r.user_id];
              const rd = md.respData[r.user_id];
              const wsRow = compareSheet.getRow(row);
              // Hours / billable / billed — always rewritten (we have fresh per-month data)
              wsRow.getCell(4).value = round1(d.bizDev);
              wsRow.getCell(5).value = round1(d.potentialClients);
              wsRow.getCell(6).value = round1(d.cle);
              wsRow.getCell(7).value = round1(d.otherAdmin);
              wsRow.getCell(8).value = round1(d.bizDev + d.potentialClients + d.cle + d.otherAdmin);
              wsRow.getCell(9).value = round1(d.billableHrs);
              wsRow.getCell(10).value = round1(d.billableHrs + d.nonbillableHrs);
              wsRow.getCell(11).value = round2(d.billedDollars);
              wsRow.getCell(12).value = round2(d.writeOffs);     // L = Write-offs (Credit Notes)
              wsRow.getCell(13).value = round2(d.lineDiscounts); // M = Line Discounts
              wsRow.getCell(17).value = round1(rd.respHrs);
              wsRow.getCell(18).value = round2(rd.respBilled);
              // Collections — target month only. CSV is single-period so
              // writing the same value to prior months would corrupt them.
              if (isTarget) {
                wsRow.getCell(14).value = round2(d.indivCollected);
                wsRow.getCell(19).value = round2(d.respCollected);
              }
              wsRow.commit();
              tkUpdated++;
            }
          }
          console.log(`[Dashboard] wrote tkUpdated=${tkUpdated} across months_processed=${monthsData.length - monthsSkipped} months_skipped=${monthsSkipped}`);

          _step = "tracking bonus sheets for deletion";
          // ---- TRACK OLD BONUS SHEETS FOR DELETION ----
          // Don't remove from ExcelJS (causes writeBuffer crash) — surgical write handles deletion at zip level
          const sheetsToDelete = wb.worksheets.filter(ws => ws.name.toLowerCase().includes("bonus"));

          _step = "creating Bonus Config";
          // ---- CREATE / UPDATE BONUS CONFIG SHEET ----
          const BONUS_ATTORNEYS = [
            { ini: "PAR", salary: 332340, associate: "JPB", paralegal: "ACA", paraSalary: 80000, legalAsst: 0, payroll: 0.17 },
            { ini: "KES", salary: 332340, associate: "TBS", paralegal: "AFL", paraSalary: 75000, legalAsst: 0, payroll: 0.17 },
            { ini: "NRN", salary: 255000, associate: "KGV", paralegal: "AKG", paraSalary: 75000, legalAsst: 0, payroll: 0.17 },
            { ini: "NAF", salary: 130000, associate: "",    paralegal: "",    paraSalary: 0,     legalAsst: 0, payroll: 0.17 },
            { ini: "MNH", salary: 110000, associate: "",    paralegal: "",    paraSalary: 0,     legalAsst: 0, payroll: 0.17 },
            { ini: "TBS", salary: 167500, associate: "",    paralegal: "",    paraSalary: 0,     legalAsst: 0, payroll: 0.17 },
            { ini: "JPB", salary: 110000, associate: "",    paralegal: "",    paraSalary: 0,     legalAsst: 0, payroll: 0.17 },
          ];
          const FIRM_OVERHEAD = 500000;
          const NUM_ATTORNEYS = 5;
          const BRACKETS = [
            { width: 0, rate: 0 },     // Bracket 1: base target at 0%
            { width: 50000, rate: 0.05 },
            { width: 50000, rate: 0.10 },
            { width: Infinity, rate: 0.15 },
          ];
          const MNH_SPLIT_AMONG = ["PAR", "KES", "NRN"];

          // Read config from existing "Bonus Config" sheet if present, else create with defaults
          let configSheet = wb.getWorksheet("Bonus Config");
          let configAttorneys = BONUS_ATTORNEYS;
          let firmOverhead = FIRM_OVERHEAD;
          let numAttorneys = NUM_ATTORNEYS;

          if (configSheet) {
            // Read existing config
            const readAttorneys: typeof BONUS_ATTORNEYS = [];
            for (let r = 5; r <= 11; r++) {
              const row = configSheet.getRow(r);
              const ini = String(row.getCell(1).value ?? "").trim().toUpperCase();
              if (!ini) continue;
              readAttorneys.push({
                ini,
                salary: Number(row.getCell(2).value) || 0,
                associate: String(row.getCell(3).value ?? "").trim().toUpperCase(),
                paralegal: String(row.getCell(4).value ?? "").trim().toUpperCase(),
                paraSalary: Number(row.getCell(5).value) || 0,
                legalAsst: Number(row.getCell(6).value) || 0,
                payroll: Number(row.getCell(7).value) || 0.17,
              });
            }
            if (readAttorneys.length > 0) configAttorneys = readAttorneys;
            firmOverhead = Number(configSheet.getRow(13).getCell(2).value) || FIRM_OVERHEAD;
            numAttorneys = Number(configSheet.getRow(14).getCell(2).value) || NUM_ATTORNEYS;
          } else {
            // Create Bonus Config with defaults
            configSheet = wb.addWorksheet("Bonus Config");
            configSheet.getRow(1).values = ["Bonus Configuration"];
            configSheet.getRow(1).font = { bold: true, size: 14 };
            configSheet.getRow(3).values = [];
            configSheet.getRow(4).values = ["Attorney", "Base Salary", "Associate", "Paralegal", "Para Salary", "Legal Asst", "Payroll %"];
            configSheet.getRow(4).font = { bold: true };
            for (let i = 0; i < BONUS_ATTORNEYS.length; i++) {
              const a = BONUS_ATTORNEYS[i];
              configSheet.getRow(5 + i).values = [a.ini, a.salary, a.associate, a.paralegal, a.paraSalary, a.legalAsst, a.payroll];
            }
            configSheet.getRow(13).values = ["Firm Overhead", FIRM_OVERHEAD];
            configSheet.getRow(13).font = { bold: true };
            configSheet.getRow(14).values = ["# of Attorneys", NUM_ATTORNEYS];
            configSheet.getRow(16).values = ["Bracket", "Width", "Rate"];
            configSheet.getRow(16).font = { bold: true };
            configSheet.getRow(17).values = [1, "Base Target", 0];
            configSheet.getRow(18).values = [2, 50000, 0.05];
            configSheet.getRow(19).values = [3, 50000, 0.10];
            configSheet.getRow(20).values = [4, "Unlimited", 0.15];
            configSheet.getRow(22).values = ["MNH collections split equally among: PAR, KES, NRN"];
            configSheet.getRow(24).values = ["Paralegal Hours Bonus"];
            configSheet.getRow(24).font = { bold: true };
            configSheet.getRow(25).values = ["Min Hours", "Bonus"];
            configSheet.getRow(25).font = { bold: true };
            configSheet.getRow(26).values = [110, 100];
            configSheet.getRow(27).values = [121, 300];
            configSheet.getRow(28).values = [133, 500];
            configSheet.getRow(30).values = ["Paralegals: ACA, AFL, AKG"];
            configSheet.columns.forEach(col => { col.width = 16; });
          }

          _step = "computing bonus data";
          // ---- COMPUTE BONUS DATA ----
          const overheadShare = firmOverhead / numAttorneys;

          // Gather individual collected (col N) from ALL existing month blocks
          const monthCollections: Record<string, Record<string, number>> = {}; // monthName -> initials -> collected
          for (let mi = 0; mi < 12; mi++) {
            const mn = monthNames[mi];
            const block = scanMonthBlock(compareSheet, mn);
            if (!block) continue;
            monthCollections[mn] = {};
            for (const [ini, rowNum] of Object.entries(block.map)) {
              const val = compareSheet.getRow(rowNum).getCell(14).value; // col N
              monthCollections[mn][ini] = typeof val === "number" ? val : (parseFloat(String(val)) || 0);
            }
          }

          // Compute per-attorney bonus
          interface BonusRow { month: string; collections: number; ytd: number; bracket: string; toNext: number; bonusEarned: number; cumBonus: number; }
          const bonusData: Record<string, { baseTarget: number; rows: BonusRow[] }> = {};

          for (const atty of configAttorneys) {
            const baseTarget = atty.salary + atty.paraSalary + atty.legalAsst + (atty.payroll * (atty.salary + atty.paraSalary)) + overheadShare;
            const bracketCeilings = [baseTarget, baseTarget + BRACKETS[1].width, baseTarget + BRACKETS[1].width + BRACKETS[2].width];
            const rows: BonusRow[] = [];
            let ytd = 0;
            let cumBonus = 0;

            for (let mi = 0; mi < 12; mi++) {
              const mn = monthNames[mi];
              const mc = monthCollections[mn];
              if (!mc) { rows.push({ month: mn, collections: 0, ytd, bracket: "-", toNext: 0, bonusEarned: 0, cumBonus }); continue; }

              // Attributed collections = own + associate + paralegal + MNH split
              let collections = mc[atty.ini] || 0;
              if (atty.associate) collections += mc[atty.associate] || 0;
              if (atty.paralegal) collections += mc[atty.paralegal] || 0;
              if (MNH_SPLIT_AMONG.includes(atty.ini)) {
                collections += (mc["MNH"] || 0) / MNH_SPLIT_AMONG.length;
              }
              collections = round2(collections);

              const prevYtd = ytd;
              ytd = round2(ytd + collections);

              // Bracket label
              let bracket = "Bracket 1";
              if (ytd > bracketCeilings[2]) bracket = "Bracket 4";
              else if (ytd > bracketCeilings[1]) bracket = "Bracket 3";
              else if (ytd > bracketCeilings[0]) bracket = "Bracket 2";

              // To next bracket
              let toNext = 0;
              if (ytd <= bracketCeilings[0]) toNext = round2(bracketCeilings[0] - ytd + 0.01);
              else if (ytd <= bracketCeilings[1]) toNext = round2(bracketCeilings[1] - ytd + 0.01);
              else if (ytd <= bracketCeilings[2]) toNext = round2(bracketCeilings[2] - ytd + 0.01);

              // Bonus earned this month (incremental bracket calculation)
              let bonusEarned = 0;
              // Apply each bracket rate to the portion of this month's collections that falls in it
              let remaining = collections;
              let cursor = prevYtd;
              for (let bi = 0; bi < BRACKETS.length && remaining > 0; bi++) {
                const ceil = bi < bracketCeilings.length ? bracketCeilings[bi] : Infinity;
                const space = Math.max(0, ceil - cursor);
                const inBracket = Math.min(remaining, space);
                bonusEarned += inBracket * BRACKETS[bi].rate;
                cursor += inBracket;
                remaining -= inBracket;
              }
              // Any remaining above all ceilings gets the last bracket rate
              if (remaining > 0) bonusEarned += remaining * BRACKETS[BRACKETS.length - 1].rate;
              bonusEarned = round2(bonusEarned);
              cumBonus = round2(cumBonus + bonusEarned);

              rows.push({ month: mn, collections, ytd, bracket, toNext, bonusEarned, cumBonus });
            }
            bonusData[atty.ini] = { baseTarget: round2(baseTarget), rows };
          }

          _step = "creating Bonus Tracker";
          // ---- CREATE BONUS TRACKER SHEET ----
          let trackerSheet = wb.getWorksheet("Bonus Tracker");
          if (trackerSheet) wb.removeWorksheet(trackerSheet.id);
          trackerSheet = wb.addWorksheet("Bonus Tracker");

          const attys = configAttorneys;
          const colsPerAtty = 4; // Collections, YTD, Bonus Earned, Cum Bonus
          const startCol = 2; // Col B onwards (Col A = month labels)

          // Row 1: Title
          trackerSheet.getRow(1).getCell(1).value = `${params.year} Bonus Tracker`;
          trackerSheet.getRow(1).getCell(1).font = { bold: true, size: 14 };

          // Row 3: Attorney headers (merged across 4 cols each)
          for (let ai = 0; ai < attys.length; ai++) {
            const col = startCol + ai * colsPerAtty;
            trackerSheet.getRow(3).getCell(col).value = attys[ai].ini;
            trackerSheet.getRow(3).getCell(col).font = { bold: true, size: 12 };
          }

          // Row 4: Sub-headers
          trackerSheet.getRow(4).getCell(1).value = "Month";
          trackerSheet.getRow(4).getCell(1).font = { bold: true };
          for (let ai = 0; ai < attys.length; ai++) {
            const col = startCol + ai * colsPerAtty;
            trackerSheet.getRow(4).getCell(col).value = "Collections";
            trackerSheet.getRow(4).getCell(col + 1).value = "YTD";
            trackerSheet.getRow(4).getCell(col + 2).value = "Bonus";
            trackerSheet.getRow(4).getCell(col + 3).value = "Cum Bonus";
          }
          trackerSheet.getRow(4).font = { bold: true };

          // Rows 5-16: Monthly data
          for (let mi = 0; mi < 12; mi++) {
            const rowNum = 5 + mi;
            const row = trackerSheet.getRow(rowNum);
            row.getCell(1).value = monthNames[mi];
            for (let ai = 0; ai < attys.length; ai++) {
              const col = startCol + ai * colsPerAtty;
              const br = bonusData[attys[ai].ini]?.rows[mi];
              if (br && (br.collections > 0 || br.ytd > 0)) {
                row.getCell(col).value = br.collections;
                row.getCell(col + 1).value = br.ytd;
                row.getCell(col + 2).value = br.bonusEarned;
                row.getCell(col + 3).value = br.cumBonus;
              }
            }
            row.commit();
          }

          // Row 17: Totals
          const totalsRow = trackerSheet.getRow(17);
          totalsRow.getCell(1).value = "TOTAL";
          totalsRow.font = { bold: true };
          for (let ai = 0; ai < attys.length; ai++) {
            const col = startCol + ai * colsPerAtty;
            const bd = bonusData[attys[ai].ini];
            if (bd) {
              const lastRow = bd.rows.filter(r => r.collections > 0).pop();
              totalsRow.getCell(col).value = bd.rows.reduce((s, r) => s + r.collections, 0);
              totalsRow.getCell(col + 1).value = lastRow?.ytd || 0;
              totalsRow.getCell(col + 2).value = bd.rows.reduce((s, r) => s + r.bonusEarned, 0);
              totalsRow.getCell(col + 3).value = lastRow?.cumBonus || 0;
            }
          }
          totalsRow.commit();

          // Row 19+: Summary block
          trackerSheet.getRow(19).getCell(1).value = "Attorney Summary";
          trackerSheet.getRow(19).getCell(1).font = { bold: true, size: 12 };
          const sumHeaders = ["Attorney", "Base Target", "YTD Collections", "Current Bracket", "To Next Bracket", "Total Bonus Earned", "Paid", "Balance"];
          trackerSheet.getRow(20).values = sumHeaders;
          trackerSheet.getRow(20).font = { bold: true };

          for (let ai = 0; ai < attys.length; ai++) {
            const row = trackerSheet.getRow(21 + ai);
            const bd = bonusData[attys[ai].ini];
            if (!bd) continue;
            const lastActive = bd.rows.filter(r => r.collections > 0).pop() || bd.rows[0];
            row.getCell(1).value = attys[ai].ini;
            row.getCell(2).value = bd.baseTarget;
            row.getCell(3).value = lastActive.ytd;
            row.getCell(4).value = lastActive.bracket;
            row.getCell(5).value = lastActive.toNext;
            row.getCell(6).value = lastActive.cumBonus;
            row.getCell(7).value = 0; // Paid — manually editable
            row.getCell(8).value = lastActive.cumBonus; // Balance = bonus - paid
            row.commit();
          }

          // Format currency columns for attorney section
          for (let ai = 0; ai < attys.length; ai++) {
            const col = startCol + ai * colsPerAtty;
            for (const c of [col, col + 1, col + 2, col + 3]) {
              trackerSheet.getColumn(c).numFmt = '"$"#,##0.00';
            }
          }
          for (const c of [2, 3, 5, 6, 7, 8]) {
            trackerSheet.getColumn(c).numFmt = '"$"#,##0.00';
          }

          _step = "paralegal hours bonus";
          // ---- PARALEGAL HOURS BONUS SECTION ----
          const PARALEGALS = ["ACA", "AFL", "AKG"];
          const PARA_BONUS_TIERS = [
            { minHours: 133, bonus: 500 },
            { minHours: 121, bonus: 300 },
            { minHours: 110, bonus: 100 },
          ];

          // Gather billable hours (col I) from all month blocks
          const monthBillableHrs: Record<string, Record<string, number>> = {}; // month -> initials -> hours
          for (let mi = 0; mi < 12; mi++) {
            const mn = monthNames[mi];
            const block = scanMonthBlock(compareSheet, mn);
            if (!block) continue;
            monthBillableHrs[mn] = {};
            for (const [ini, rowNum] of Object.entries(block.map)) {
              const val = compareSheet.getRow(rowNum).getCell(9).value; // col I = billable hours
              monthBillableHrs[mn][ini] = typeof val === "number" ? val : (parseFloat(String(val)) || 0);
            }
          }

          const paraStartRow = 21 + attys.length + 2;
          trackerSheet.getRow(paraStartRow).getCell(1).value = "Paralegal Hours Bonus";
          trackerSheet.getRow(paraStartRow).getCell(1).font = { bold: true, size: 12 };

          // Sub-headers
          const paraHeaderRow = paraStartRow + 1;
          trackerSheet.getRow(paraHeaderRow).getCell(1).value = "Month";
          trackerSheet.getRow(paraHeaderRow).getCell(1).font = { bold: true };
          for (let pi = 0; pi < PARALEGALS.length; pi++) {
            const col = 2 + pi * 3;
            trackerSheet.getRow(paraStartRow).getCell(col).value = PARALEGALS[pi];
            trackerSheet.getRow(paraStartRow).getCell(col).font = { bold: true, size: 12 };
            trackerSheet.getRow(paraHeaderRow).getCell(col).value = "Billable Hrs";
            trackerSheet.getRow(paraHeaderRow).getCell(col + 1).value = "Tier";
            trackerSheet.getRow(paraHeaderRow).getCell(col + 2).value = "Bonus";
          }
          trackerSheet.getRow(paraHeaderRow).font = { bold: true };

          // Monthly rows
          const paraTotals: Record<string, { hours: number; bonus: number }> = {};
          for (const p of PARALEGALS) paraTotals[p] = { hours: 0, bonus: 0 };

          for (let mi = 0; mi < 12; mi++) {
            const mn = monthNames[mi];
            const rowNum = paraHeaderRow + 1 + mi;
            const row = trackerSheet.getRow(rowNum);
            row.getCell(1).value = mn;

            for (let pi = 0; pi < PARALEGALS.length; pi++) {
              const col = 2 + pi * 3;
              const hrs = monthBillableHrs[mn]?.[PARALEGALS[pi]] || 0;
              if (hrs > 0) {
                // Determine bonus tier
                let bonus = 0;
                let tier = "-";
                for (const t of PARA_BONUS_TIERS) {
                  if (hrs >= t.minHours) { bonus = t.bonus; tier = `≥${t.minHours}`; break; }
                }
                row.getCell(col).value = round1(hrs);
                row.getCell(col + 1).value = tier;
                row.getCell(col + 2).value = bonus;
                paraTotals[PARALEGALS[pi]].hours += hrs;
                paraTotals[PARALEGALS[pi]].bonus += bonus;
              }
            }
            row.commit();
          }

          // Totals row
          const paraTotalRowNum = paraHeaderRow + 13;
          const paraTotalRow = trackerSheet.getRow(paraTotalRowNum);
          paraTotalRow.getCell(1).value = "TOTAL";
          paraTotalRow.font = { bold: true };
          for (let pi = 0; pi < PARALEGALS.length; pi++) {
            const col = 2 + pi * 3;
            paraTotalRow.getCell(col).value = round1(paraTotals[PARALEGALS[pi]].hours);
            paraTotalRow.getCell(col + 2).value = paraTotals[PARALEGALS[pi]].bonus;
          }
          paraTotalRow.commit();

          // Format paralegal bonus columns as currency
          for (let pi = 0; pi < PARALEGALS.length; pi++) {
            const col = 2 + pi * 3 + 2; // bonus column
            trackerSheet.getColumn(col).numFmt = '"$"#,##0';
          }

          trackerSheet.columns.forEach(col => { col.width = Math.max(col.width || 10, 14); });

          _step = "deleting NAF tabs";
          // ---- DELETE OLD NAF TABS ----
          const nafSheets = wb.worksheets.filter(ws =>
            ws.name.includes("NAF(") || ws.name.includes("NAF Admin")
          );
          for (const ws of nafSheets) { sheetsToDelete.push(ws); }

          _step = "building Attorney Performance";
          // ---- ATTORNEY PERFORMANCE SHEET ----
          // Read 2026 Goals for per-attorney annual goals and billing rates
          const goalsSheet = wb.getWorksheet("2026 Goals ") || wb.getWorksheet("2026 Goals");
          const attyGoals: Record<string, { annualGoal: number; billingRate: number; availableHrs: number; utilGoal: number; realGoal: number; collGoal: number }> = {};
          if (goalsSheet) {
            for (let r = 3; r <= 15; r++) {
              const row = goalsSheet.getRow(r);
              const ini = String(row.getCell(1).value ?? "").trim().toUpperCase();
              if (!ini || ini === "TOTAL") continue;
              const availRaw = row.getCell(2).value;
              const availHrs = typeof availRaw === "object" && availRaw !== null && "result" in (availRaw as any)
                ? (availRaw as any).result : (typeof availRaw === "number" ? availRaw : 1880);
              const utilGoal = Number(row.getCell(3).value) || 0.75;
              const realGoal = Number(row.getCell(5).value) || 0.75;
              const collGoal = Number(row.getCell(7).value) || 0.75;
              const billingRate = Number(row.getCell(9).value) || 0;
              const goalRaw = row.getCell(10).value;
              const annualGoal = typeof goalRaw === "object" && goalRaw !== null && "result" in (goalRaw as any)
                ? (goalRaw as any).result : (typeof goalRaw === "number" ? goalRaw : 0);
              attyGoals[ini] = { annualGoal, billingRate, availableHrs: availHrs, utilGoal, realGoal, collGoal };
            }
          }

          // Read ALL columns from 26 Compare for each month (including L=write-offs, M=discounts)
          const monthFullData: Record<string, Record<string, {
            bizDev: number; potClients: number; cle: number; admin: number; tnb: number;
            billableHrs: number; totalHrs: number; billedAmt: number; writeOffs: number;
            discounts: number; collected: number;
          }>> = {};
          for (let mi = 0; mi < 12; mi++) {
            const mn = monthNames[mi];
            const block = scanMonthBlock(compareSheet, mn);
            if (!block) continue;
            monthFullData[mn] = {};
            for (const [ini, rowNum] of Object.entries(block.map)) {
              const r = compareSheet.getRow(rowNum);
              const getNum = (col: number) => { const v = r.getCell(col).value; return typeof v === "number" ? v : (parseFloat(String(v)) || 0); };
              monthFullData[mn][ini] = {
                bizDev: getNum(4), potClients: getNum(5), cle: getNum(6), admin: getNum(7),
                tnb: getNum(8), billableHrs: getNum(9), totalHrs: getNum(10), billedAmt: getNum(11),
                writeOffs: getNum(12), discounts: getNum(13), collected: getNum(14),
              };
            }
          }

          // Create the sheet
          let perfSheet = wb.getWorksheet("Attorney Performance");
          if (perfSheet) wb.removeWorksheet(perfSheet.id);
          perfSheet = wb.addWorksheet("Attorney Performance");

          const PERF_HEADERS = [
            "Month", "BizDev", "Pot Clients", "CLE", "Admin", "TNB",
            "Billable Hrs", "Total Hrs", "Billed $", "Write-offs", "Discounts",
            "Collected", "Goal", "vs Goal",
            "Util Rate", "Util Goal", "Real Rate", "Real Goal", "Coll Rate", "Coll Goal",
          ];

          let perfRow = 1;
          perfSheet.getRow(perfRow).getCell(1).value = `${params.year} Attorney Performance`;
          perfSheet.getRow(perfRow).getCell(1).font = { bold: true, size: 14 };
          perfRow += 2;

          for (const r of ROSTER) {
            const goals = attyGoals[r.initials] || { annualGoal: 0, billingRate: 0, availableHrs: 1880, utilGoal: 0.75, realGoal: 0.75, collGoal: 0.75 };
            const monthlyGoal = round2(goals.annualGoal / 12);
            const monthlyAvail = round1(goals.availableHrs / 12);

            // Attorney header
            perfSheet.getRow(perfRow).getCell(1).value = `${r.name} (${r.initials})`;
            perfSheet.getRow(perfRow).getCell(1).font = { bold: true, size: 12 };
            perfRow++;

            // Column headers
            const hdrRow = perfSheet.getRow(perfRow);
            PERF_HEADERS.forEach((h, i) => { hdrRow.getCell(i + 1).value = h; });
            hdrRow.font = { bold: true };
            perfRow++;

            // Monthly data
            let ytdCollected = 0, ytdBilled = 0, ytdBillableHrs = 0;
            const dataStartRow = perfRow;

            for (let mi = 0; mi < 12; mi++) {
              const mn = monthNames[mi];
              const md = monthFullData[mn]?.[r.initials];
              const row = perfSheet.getRow(perfRow);
              row.getCell(1).value = mn;

              if (md && (md.billableHrs > 0 || md.collected > 0 || md.totalHrs > 0)) {
                ytdCollected += md.collected;
                ytdBilled += md.billedAmt;
                ytdBillableHrs += md.billableHrs;

                row.getCell(2).value = round1(md.bizDev);
                row.getCell(3).value = round1(md.potClients);
                row.getCell(4).value = round1(md.cle);
                row.getCell(5).value = round1(md.admin);
                row.getCell(6).value = round1(md.tnb);
                row.getCell(7).value = round1(md.billableHrs);
                row.getCell(8).value = round1(md.totalHrs);
                row.getCell(9).value = round2(md.billedAmt);
                row.getCell(10).value = round2(md.writeOffs);
                row.getCell(11).value = round2(md.discounts);
                row.getCell(12).value = round2(md.collected);
                row.getCell(13).value = monthlyGoal;
                row.getCell(14).value = round2(md.collected - monthlyGoal);

                const utilRate = monthlyAvail > 0 ? md.billableHrs / monthlyAvail : 0;
                row.getCell(15).value = round2(utilRate);
                row.getCell(16).value = goals.utilGoal;

                const expectedBilled = md.billableHrs * goals.billingRate;
                const realRate = expectedBilled > 0 ? md.billedAmt / expectedBilled : 0;
                row.getCell(17).value = round2(realRate);
                row.getCell(18).value = goals.realGoal;

                const collRate = md.billedAmt > 0 ? md.collected / md.billedAmt : 0;
                row.getCell(19).value = round2(collRate);
                row.getCell(20).value = goals.collGoal;
              }
              row.commit();
              perfRow++;
            }

            // Totals row
            const totRow = perfSheet.getRow(perfRow);
            totRow.getCell(1).value = "YTD";
            totRow.font = { bold: true };
            // Sum columns 2-12 from data rows
            for (let ci = 2; ci <= 12; ci++) {
              let sum = 0;
              for (let dr = dataStartRow; dr < dataStartRow + 12; dr++) {
                const v = perfSheet.getRow(dr).getCell(ci).value;
                if (typeof v === "number") sum += v;
              }
              totRow.getCell(ci).value = round2(sum);
            }
            totRow.getCell(13).value = round2(monthlyGoal * 12);
            totRow.getCell(14).value = round2(ytdCollected - goals.annualGoal);
            // Average rates
            const monthsWithData = Object.keys(monthFullData).filter(mn => monthFullData[mn]?.[r.initials]?.totalHrs > 0).length;
            if (monthsWithData > 0) {
              const avgUtil = monthlyAvail * monthsWithData > 0 ? ytdBillableHrs / (monthlyAvail * monthsWithData) : 0;
              totRow.getCell(15).value = round2(avgUtil);
              const expectedTotal = ytdBillableHrs * goals.billingRate;
              totRow.getCell(17).value = expectedTotal > 0 ? round2(ytdBilled / expectedTotal) : 0;
              totRow.getCell(19).value = ytdBilled > 0 ? round2(ytdCollected / ytdBilled) : 0;
            }
            totRow.commit();
            perfRow += 2; // gap before next attorney
          }

          // Format currency columns
          for (const col of [9, 10, 11, 12, 13, 14]) {
            perfSheet.getColumn(col).numFmt = '"$"#,##0.00';
          }
          // Format rate columns as percentages
          for (const col of [15, 16, 17, 18, 19, 20]) {
            perfSheet.getColumn(col).numFmt = '0%';
          }
          perfSheet.columns.forEach(col => { col.width = Math.max(col.width || 10, 14); });

          _step = "surgical write + upload";
          // ---- SAVE AND UPLOAD (direct XML, no ExcelJS write) ----
          // Style indices from the original 26 Compare sheet:
          const S = { monthStr: "369", initials: "170", hrs1: "311", hrs: "171", hrsFormula: "330", totalFormula: "327", currency: "172", writeoffs: "62", collected: "173", respHrs: "174", respBilled: "175", respColl: "176", bold: "1" };
          // Excel column letter for a 1-based column index. Must handle >26
          // (AA, AB, …): the Bonus Tracker lays out 7 attorneys × 4 cols and
          // runs past Z. The old `String.fromCharCode(64 + c)` produced bytes
          // like "[", "\\", "]" for cols 27-29, yielding invalid cell refs that
          // corrupt the workbook (and make ExcelJS throw "A Cell needs a Row").
          const colLetter = (c: number): string => {
            let s = "";
            while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
            return s;
          };

          // --- 26 Compare: patch the original XML ---
          const origZip = await JSZip.loadAsync(fileBuffer);
          const compareSheetMap = await getZipSheetMap(origZip);
          const comparePath = compareSheetMap["26 Compare"];
          let compareXml = await origZip.file(comparePath)!.async("string");

          // Helper: update a cell value in the XML
          function patchCell(xml: string, ref: string, val: number): string {
            const re = new RegExp(`(<c\\s[^>]*r="${ref}"[^>]*>)([\\s\\S]*?)(</c>)`);
            const m = xml.match(re);
            if (m) {
              let inner = m[2];
              if (/<v>/.test(inner)) inner = inner.replace(/<v>[^<]*<\/v>/, `<v>${val}</v>`);
              else inner += `<v>${val}</v>`;
              return xml.replace(re, `${m[1]}${inner}${m[3]}`);
            }
            return xml;
          }

          // Patch existing month data cells (cells that already exist in the XML)
          // for EVERY backfilled YTD month — not just the target — so prior
          // months get the fresh per-month aggregation written to "26 Compare"
          // (matches the ExcelJS backfill loop above; mirrors its column rules).
          // Collections (cols N=14, S=19) are target-month-only: the fee
          // allocation CSV is single-period, so prior months' data has them
          // zero and we must not overwrite their existing values.
          // The target month's rows may not exist yet when blockCreated — in
          // that case patchCell is a no-op and the blockCreated section below
          // writes those rows.
          for (const md of monthsData) {
            const isTarget = md.month === params.month;
            const block = isTarget ? monthBlock : scanMonthBlock(compareSheet, md.monthName);
            if (!block) continue;
            const rowMap = block.map;
            for (const r of ROSTER) {
              const row = rowMap[r.initials.toUpperCase()];
              if (!row) continue;
              const d = md.data[r.user_id];
              const rd = md.respData[r.user_id];
              const patches: [number, number][] = [
                [4, round1(d.bizDev)], [5, round1(d.potentialClients)], [6, round1(d.cle)], [7, round1(d.otherAdmin)],
                [8, round1(d.bizDev + d.potentialClients + d.cle + d.otherAdmin)],
                [9, round1(d.billableHrs)], [10, round1(d.billableHrs + d.nonbillableHrs)],
                [11, round2(d.billedDollars)],
                [12, round2(d.writeOffs)], [13, round2(d.lineDiscounts)],
                [17, round1(rd.respHrs)], [18, round2(rd.respBilled)],
              ];
              if (isTarget) {
                patches.push([14, round2(d.indivCollected)], [19, round2(d.respCollected)]);
              }
              for (const [col, val] of patches) {
                compareXml = patchCell(compareXml, `${colLetter(col)}${row}`, val);
              }
            }
          }

          // If month block was created, we need to add new rows to the XML
          if (blockCreated) {
            // Build new row XML strings for the April block
            const newRowsXml: string[] = [];
            for (const ini of janBlock.initials) {
              const row = initialsRowMap[ini];
              if (!row) continue;
              const rosterEntry = ROSTER.find(r => r.initials.toUpperCase() === ini);
              const d = rosterEntry ? targetBundle.data[rosterEntry.user_id] : null;
              const rd = rosterEntry ? targetBundle.respData[rosterEntry.user_id] : null;

              const cells = [
                xmlCell(`B${row}`, monthName, { style: S.monthStr }),
                xmlCell(`C${row}`, ini, { style: S.initials }),
                xmlCell(`D${row}`, d ? round1(d.bizDev) : 0, { style: S.hrs1 }),
                xmlCell(`E${row}`, d ? round1(d.potentialClients) : 0, { style: S.hrs }),
                xmlCell(`F${row}`, d ? round1(d.cle) : 0, { style: S.hrs }),
                xmlCell(`G${row}`, d ? round1(d.otherAdmin) : 0, { style: S.hrs }),
                xmlCell(`H${row}`, null, { style: S.hrsFormula, formula: `SUM(D${row}:G${row})` }),
                xmlCell(`I${row}`, d ? round1(d.billableHrs) : 0, { style: S.hrsFormula }),
                xmlCell(`J${row}`, null, { style: S.totalFormula, formula: `H${row}+I${row}` }),
                xmlCell(`K${row}`, d ? round2(d.billedDollars) : 0, { style: S.currency }),
                xmlCell(`L${row}`, d ? round2(d.writeOffs) : 0, { style: S.writeoffs }),
                xmlCell(`M${row}`, d ? round2(d.lineDiscounts) : 0, { style: S.currency }),
                xmlCell(`N${row}`, d ? round2(d.indivCollected) : 0, { style: S.collected }),
                xmlCell(`Q${row}`, rd ? round1(rd.respHrs) : 0, { style: S.respHrs }),
                xmlCell(`R${row}`, rd ? round2(rd.respBilled) : 0, { style: S.respBilled }),
                xmlCell(`S${row}`, d ? round2(d.respCollected) : 0, { style: S.respColl }),
              ];
              newRowsXml.push(xmlRow(row, cells));
            }

            // Add SUM row for the month
            if (monthBlock.sumRow) {
              const sr = monthBlock.sumRow;
              const first = monthBlock.firstRow;
              const last = monthBlock.lastRow;
              const sumCells = [4,5,6,7,8,9,10,11,12,13,14,17,18,19].map(col =>
                xmlCell(`${colLetter(col)}${sr}`, null, { formula: `SUM(${colLetter(col)}${first}:${colLetter(col)}${last})` })
              );
              sumCells.unshift(xmlCell(`B${sr}`, monthName, { style: S.monthStr }));
              newRowsXml.push(xmlRow(sr, sumCells));
            }

            // Insert before </sheetData>
            compareXml = compareXml.replace("</sheetData>", newRowsXml.join("") + "</sheetData>");
          }

          // --- Build new sheet XMLs from data ---
          // Bonus Config
          const configRows: string[] = [];
          configRows.push(xmlRow(1, [xmlCell("A1", "Bonus Configuration")]));
          configRows.push(xmlRow(4, [xmlCell("A4", "Attorney"), xmlCell("B4", "Base Salary"), xmlCell("C4", "Associate"), xmlCell("D4", "Paralegal"), xmlCell("E4", "Para Salary"), xmlCell("F4", "Legal Asst"), xmlCell("G4", "Payroll %")]));
          for (let i = 0; i < configAttorneys.length; i++) {
            const a = configAttorneys[i];
            configRows.push(xmlRow(5 + i, [xmlCell(`A${5+i}`, a.ini), xmlCell(`B${5+i}`, a.salary), xmlCell(`C${5+i}`, a.associate), xmlCell(`D${5+i}`, a.paralegal), xmlCell(`E${5+i}`, a.paraSalary), xmlCell(`F${5+i}`, a.legalAsst), xmlCell(`G${5+i}`, a.payroll)]));
          }
          configRows.push(xmlRow(13, [xmlCell("A13", "Firm Overhead"), xmlCell("B13", firmOverhead)]));
          configRows.push(xmlRow(14, [xmlCell("A14", "# of Attorneys"), xmlCell("B14", numAttorneys)]));
          configRows.push(xmlRow(16, [xmlCell("A16", "Bracket"), xmlCell("B16", "Width"), xmlCell("C16", "Rate")]));
          configRows.push(xmlRow(17, [xmlCell("A17", 1), xmlCell("B17", "Base Target"), xmlCell("C17", 0)]));
          configRows.push(xmlRow(18, [xmlCell("A18", 2), xmlCell("B18", 50000), xmlCell("C18", 0.05)]));
          configRows.push(xmlRow(19, [xmlCell("A19", 3), xmlCell("B19", 50000), xmlCell("C19", 0.10)]));
          configRows.push(xmlRow(20, [xmlCell("A20", 4), xmlCell("B20", "Unlimited"), xmlCell("C20", 0.15)]));
          configRows.push(xmlRow(22, [xmlCell("A22", "MNH collections split equally among: PAR, KES, NRN")]));
          configRows.push(xmlRow(24, [xmlCell("A24", "Paralegal Hours Bonus")]));
          configRows.push(xmlRow(25, [xmlCell("A25", "Min Hours"), xmlCell("B25", "Bonus")]));
          configRows.push(xmlRow(26, [xmlCell("A26", 110), xmlCell("B26", 100)]));
          configRows.push(xmlRow(27, [xmlCell("A27", 121), xmlCell("B27", 300)]));
          configRows.push(xmlRow(28, [xmlCell("A28", 133), xmlCell("B28", 500)]));
          configRows.push(xmlRow(30, [xmlCell("A30", "Paralegals: ACA, AFL, AKG")]));
          const bonusConfigXml = buildSheetXml(configRows);

          // Bonus Tracker
          const trackerRows: string[] = [];
          trackerRows.push(xmlRow(1, [xmlCell("A1", `${params.year} Bonus Tracker`)]));
          // Attorney headers
          const xmlColsPerAtty = 4;
          const trackerHeaderCells: string[] = [];
          const trackerSubCells: string[] = [xmlCell("A4", "Month")];
          for (let ai = 0; ai < attys.length; ai++) {
            const col = 2 + ai * xmlColsPerAtty;
            const L = colLetter(col);
            trackerHeaderCells.push(xmlCell(`${L}3`, attys[ai].ini));
            trackerSubCells.push(xmlCell(`${colLetter(col)}4`, "Collections"));
            trackerSubCells.push(xmlCell(`${colLetter(col+1)}4`, "YTD"));
            trackerSubCells.push(xmlCell(`${colLetter(col+2)}4`, "Bonus"));
            trackerSubCells.push(xmlCell(`${colLetter(col+3)}4`, "Cum Bonus"));
          }
          trackerRows.push(xmlRow(3, trackerHeaderCells));
          trackerRows.push(xmlRow(4, trackerSubCells));

          for (let mi = 0; mi < 12; mi++) {
            const rn = 5 + mi;
            const cells: string[] = [xmlCell(`A${rn}`, monthNames[mi])];
            for (let ai = 0; ai < attys.length; ai++) {
              const col = 2 + ai * xmlColsPerAtty;
              const br = bonusData[attys[ai].ini]?.rows[mi];
              if (br && (br.collections > 0 || br.ytd > 0)) {
                cells.push(xmlCell(`${colLetter(col)}${rn}`, br.collections));
                cells.push(xmlCell(`${colLetter(col+1)}${rn}`, br.ytd));
                cells.push(xmlCell(`${colLetter(col+2)}${rn}`, br.bonusEarned));
                cells.push(xmlCell(`${colLetter(col+3)}${rn}`, br.cumBonus));
              }
            }
            trackerRows.push(xmlRow(rn, cells));
          }

          // Summary section
          trackerRows.push(xmlRow(19, [xmlCell("A19", "Attorney Summary")]));
          trackerRows.push(xmlRow(20, [xmlCell("A20", "Attorney"), xmlCell("B20", "Base Target"), xmlCell("C20", "YTD Collections"), xmlCell("D20", "Current Bracket"), xmlCell("E20", "To Next Bracket"), xmlCell("F20", "Total Bonus"), xmlCell("G20", "Paid"), xmlCell("H20", "Balance")]));
          for (let ai = 0; ai < attys.length; ai++) {
            const rn = 21 + ai;
            const bd = bonusData[attys[ai].ini];
            if (!bd) continue;
            const lastActive = bd.rows.filter(r => r.collections > 0).pop() || bd.rows[0];
            trackerRows.push(xmlRow(rn, [
              xmlCell(`A${rn}`, attys[ai].ini), xmlCell(`B${rn}`, bd.baseTarget), xmlCell(`C${rn}`, lastActive.ytd),
              xmlCell(`D${rn}`, lastActive.bracket), xmlCell(`E${rn}`, lastActive.toNext),
              xmlCell(`F${rn}`, lastActive.cumBonus), xmlCell(`G${rn}`, 0), xmlCell(`H${rn}`, lastActive.cumBonus),
            ]));
          }

          // Paralegal section
          const paraStart = 21 + attys.length + 2;
          const paraHdr = paraStart + 1;
          // Row `paraStart`: section title + paralegal name headers.
          // Row `paraHdr`:   per-paralegal column sub-headers.
          // NB: each cell's ref row MUST match the row it's emitted in — a
          // cell like B30 inside <row r="31"> is invalid OOXML and Excel
          // discards the sheet's cell data ("Removed Records").
          const paraTitleCells: string[] = [xmlCell(`A${paraStart}`, "Paralegal Hours Bonus")];
          const paraHdrCells: string[] = [xmlCell(`A${paraHdr}`, "Month")];
          const XML_PARALEGALS = ["ACA", "AFL", "AKG"];
          const XML_PARA_TIERS = [{ minHours: 133, bonus: 500 }, { minHours: 121, bonus: 300 }, { minHours: 110, bonus: 100 }];
          for (let pi = 0; pi < XML_PARALEGALS.length; pi++) {
            const col = 2 + pi * 3;
            paraTitleCells.push(xmlCell(`${colLetter(col)}${paraStart}`, XML_PARALEGALS[pi]));
            paraHdrCells.push(xmlCell(`${colLetter(col)}${paraHdr}`, "Billable Hrs"));
            paraHdrCells.push(xmlCell(`${colLetter(col+1)}${paraHdr}`, "Tier"));
            paraHdrCells.push(xmlCell(`${colLetter(col+2)}${paraHdr}`, "Bonus"));
          }
          trackerRows.push(xmlRow(paraStart, paraTitleCells));
          trackerRows.push(xmlRow(paraHdr, paraHdrCells));

          for (let mi = 0; mi < 12; mi++) {
            const rn = paraHdr + 1 + mi;
            const cells: string[] = [xmlCell(`A${rn}`, monthNames[mi])];
            for (let pi = 0; pi < XML_PARALEGALS.length; pi++) {
              const col = 2 + pi * 3;
              const hrs = monthBillableHrs[monthNames[mi]]?.[XML_PARALEGALS[pi]] || 0;
              if (hrs > 0) {
                let bonus = 0, tier = "-";
                for (const t of XML_PARA_TIERS) { if (hrs >= t.minHours) { bonus = t.bonus; tier = `≥${t.minHours}`; break; } }
                cells.push(xmlCell(`${colLetter(col)}${rn}`, round1(hrs)));
                cells.push(xmlCell(`${colLetter(col+1)}${rn}`, tier));
                cells.push(xmlCell(`${colLetter(col+2)}${rn}`, bonus));
              }
            }
            trackerRows.push(xmlRow(rn, cells));
          }
          const bonusTrackerXml = buildSheetXml(trackerRows);

          // Attorney Performance
          const perfRows: string[] = [];
          perfRows.push(xmlRow(1, [xmlCell("A1", `${params.year} Attorney Performance`)]));
          const PERF_HDRS = ["Month","BizDev","Pot Clients","CLE","Admin","TNB","Billable Hrs","Total Hrs","Billed $","Write-offs","Discounts","Collected","Goal","vs Goal","Util Rate","Util Goal","Real Rate","Real Goal","Coll Rate","Coll Goal"];
          let pRow = 3;
          for (const r of ROSTER) {
            const goals = attyGoals[r.initials] || { annualGoal: 0, billingRate: 0, availableHrs: 1880, utilGoal: 0.75, realGoal: 0.75, collGoal: 0.75 };
            const monthlyGoal = round2(goals.annualGoal / 12);
            const monthlyAvail = round1(goals.availableHrs / 12);
            perfRows.push(xmlRow(pRow, [xmlCell(`A${pRow}`, `${r.name} (${r.initials})`)]));
            pRow++;
            perfRows.push(xmlRow(pRow, PERF_HDRS.map((h, i) => xmlCell(`${colLetter(i + 1)}${pRow}`, h))));
            pRow++;
            let ytdColl = 0, ytdBilled = 0, ytdBillHrs = 0;
            const dataStart = pRow;
            for (let mi = 0; mi < 12; mi++) {
              const mn = monthNames[mi];
              const md = monthFullData[mn]?.[r.initials];
              const cells: string[] = [xmlCell(`A${pRow}`, mn)];
              if (md && (md.billableHrs > 0 || md.collected > 0 || md.totalHrs > 0)) {
                ytdColl += md.collected; ytdBilled += md.billedAmt; ytdBillHrs += md.billableHrs;
                cells.push(xmlCell(`B${pRow}`, round1(md.bizDev)), xmlCell(`C${pRow}`, round1(md.potClients)),
                  xmlCell(`D${pRow}`, round1(md.cle)), xmlCell(`E${pRow}`, round1(md.admin)),
                  xmlCell(`F${pRow}`, round1(md.tnb)), xmlCell(`G${pRow}`, round1(md.billableHrs)),
                  xmlCell(`H${pRow}`, round1(md.totalHrs)), xmlCell(`I${pRow}`, round2(md.billedAmt)),
                  xmlCell(`J${pRow}`, round2(md.writeOffs)), xmlCell(`K${pRow}`, round2(md.discounts)),
                  xmlCell(`L${pRow}`, round2(md.collected)), xmlCell(`M${pRow}`, monthlyGoal),
                  xmlCell(`N${pRow}`, round2(md.collected - monthlyGoal)));
                const utilRate = monthlyAvail > 0 ? round2(md.billableHrs / monthlyAvail) : 0;
                const expectedBilled = md.billableHrs * goals.billingRate;
                const realRate = expectedBilled > 0 ? round2(md.billedAmt / expectedBilled) : 0;
                const collRate = md.billedAmt > 0 ? round2(md.collected / md.billedAmt) : 0;
                cells.push(xmlCell(`O${pRow}`, utilRate), xmlCell(`P${pRow}`, goals.utilGoal),
                  xmlCell(`Q${pRow}`, realRate), xmlCell(`R${pRow}`, goals.realGoal),
                  xmlCell(`S${pRow}`, collRate), xmlCell(`T${pRow}`, goals.collGoal));
              }
              perfRows.push(xmlRow(pRow, cells));
              pRow++;
            }
            // YTD row
            const ytdCells: string[] = [xmlCell(`A${pRow}`, "YTD")];
            ytdCells.push(xmlCell(`L${pRow}`, round2(ytdColl)), xmlCell(`M${pRow}`, round2(monthlyGoal * 12)),
              xmlCell(`N${pRow}`, round2(ytdColl - goals.annualGoal)));
            const mwd = Object.keys(monthFullData).filter(mn => monthFullData[mn]?.[r.initials]?.totalHrs > 0).length;
            if (mwd > 0) {
              ytdCells.push(xmlCell(`O${pRow}`, round2(monthlyAvail * mwd > 0 ? ytdBillHrs / (monthlyAvail * mwd) : 0)));
              const et = ytdBillHrs * goals.billingRate;
              ytdCells.push(xmlCell(`Q${pRow}`, et > 0 ? round2(ytdBilled / et) : 0));
              ytdCells.push(xmlCell(`S${pRow}`, ytdBilled > 0 ? round2(ytdColl / ytdBilled) : 0));
            }
            perfRows.push(xmlRow(pRow, ytdCells));
            pRow += 2;
          }
          const perfXml = buildSheetXml(perfRows);

          // --- Assemble and upload ---
          // Use placeholder styles, then replace after surgicalWriteXlsx injects real indices
          const deletedSheets = new Set(sheetsToDelete.map((ws: any) => ws.name));
          const outputBuffer = await surgicalWriteXlsx(fileBuffer, (ST: StyleIndices) => {
            // Post-process new sheet XMLs to add style attributes
            // For Bonus Config: numbers use general, currency uses currency
            // For Bonus Tracker: collections/bonus use currency
            // For Attorney Performance: hours use decimal, $ use currency, rates use percent
            function addStyles(xml: string): string {
              // All <c> elements without s= attribute and with <v> (number) get general style
              // This prevents the default date format from being applied
              return xml.replace(/<c r="([^"]+)">/g, (match, ref) => `<c r="${ref}" s="${ST.general}">`);
            }
            return {
              "26 Compare": compareXml,  // already has correct styles from original
              "Bonus Config": addStyles(bonusConfigXml),
              "Bonus Tracker": addStyles(bonusTrackerXml),
              "Attorney Performance": addStyles(perfXml),
            };
          }, deletedSheets);
          const result = await uploadToBox({
            buffer: outputBuffer,
            filename: `${params.year} Firm Dashboard - Claude Version 2.xlsx`,
            folderId: "348313592902",
            overwriteFileId: DASHBOARD_FILE_ID,
          });

          const common = {
            updated_sheet: "26 Compare",
            month: monthName,
            year: params.year,
            timekeepers_updated: tkUpdated,
            months_processed: params.month - monthsSkipped,
            months_skipped: monthsSkipped,
            backfilled_through: `${monthNames[0]}–${monthName}`,
            block_created: blockCreated,
            bonus_tracker_rebuilt: true,
            attorneys_tracked: attys.length,
          };

          if (result.uploaded) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  ...common,
                  box_file_id: result.box_file_id,
                  box_url: result.box_url,
                }),
              }],
            };
          }

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                ...common,
                size_kb: result.size_kb,
                direct_download_url: result.direct_download_url,
                expires_at: result.expires_at,
                reason: result.reason,
                note: result.note,
              }),
            }],
          };
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, step: _step, message: err.message, stack: err.stack?.split("\n").slice(0, 5).join(" | ") }) }], isError: true };
      }
      })()
        .then((res: any) => { job.result = res; job.status = res?.isError ? "error" : "done"; job.finished_at = new Date().toISOString(); })
        .catch((err: any) => { job.status = "error"; job.error = String(err?.message ?? err); job.finished_at = new Date().toISOString(); });
      return { content: [{ type: "text" as const, text: JSON.stringify({ job_id: jobId, status: "started", message: "Dashboard update is running in the background. Classic (default) mode takes ~1–5 min — it generates a revenue report per timekeeper. Poll get_dashboard_status with this job_id; the workbook versions in Box when done. (Tip: revenue_csv_box_file_id is much faster.)" }) }] };
    }
  );

  // ============================================================
  // get_dashboard_status — poll a download_dashboard_update background job
  // ============================================================
  server.tool(
    "get_dashboard_status",
    "Check a download_dashboard_update background job by job_id: returns running | done | error, timestamps, and (when finished) the full result or error. Poll this after calling download_dashboard_update, which returns immediately with a job_id.",
    { job_id: z.string().describe("The job_id returned by download_dashboard_update") },
    async (p) => {
      const j = dashboardJobs.get(p.job_id);
      if (!j) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `No job '${p.job_id}' found — it may have expired or the server restarted. Re-run download_dashboard_update.`, known_jobs: [...dashboardJobs.keys()] }) }] };
      }
      let result: any;
      const inner = j.result?.content?.[0]?.text;
      if (inner) { try { result = JSON.parse(inner); } catch { result = inner; } }
      const elapsed_s = Math.round(((j.finished_at ? new Date(j.finished_at).getTime() : Date.now()) - new Date(j.started_at).getTime()) / 1000);
      return { content: [{ type: "text" as const, text: JSON.stringify({ id: j.id, status: j.status, started_at: j.started_at, finished_at: j.finished_at, elapsed_s, error: j.error, result }, null, 2) }] };
    }
  );
}
