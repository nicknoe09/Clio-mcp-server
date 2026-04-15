import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, downloadReport } from "../clio/pagination";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageBreak, PageNumber, LevelFormat,
} from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { uploadToBox, downloadFromBox } from "../utils/box";

// ========== XLSX SURGICAL WRITE HELPER ==========
// ExcelJS corrupts Excel Table objects on round-trip. This helper preserves
// the original raw XML bytes for sheets we didn't modify, only replacing
// sheets we actually changed or created.

async function surgicalWriteXlsx(
  originalBuffer: Buffer,
  modifiedSheetWb: ExcelJS.Workbook,  // small workbook with ONLY modified/new sheets
  modifiedSheetNames: Set<string>,
  deletedSheetNames: Set<string>,
): Promise<Buffer> {
  // Strategy: start with original zip, inject only the sheets we changed/created.
  // ExcelJS never touches the original — it only builds the new sheet XMLs.
  const origZip = await JSZip.loadAsync(originalBuffer);

  // Build a small workbook with only modified sheets, write it, extract sheet XMLs
  const modBuffer = Buffer.from(await modifiedSheetWb.xlsx.writeBuffer());
  const modZip = await JSZip.loadAsync(modBuffer);

  // Parse sheet maps
  async function getSheetMap(zip: JSZip): Promise<Record<string, string>> {
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

  const origSheetMap = await getSheetMap(origZip);
  const modSheetMap = await getSheetMap(modZip);

  // Start with the ORIGINAL zip as the base (preserves everything)
  const resultZip = origZip;

  // For modified sheets that already exist in original, replace their XML
  for (const name of modifiedSheetNames) {
    const origPath = origSheetMap[name];
    const modPath = modSheetMap[name];
    if (origPath && modPath) {
      // Overwrite original sheet XML with modified version
      const modFile = modZip.file(modPath);
      if (modFile) {
        const content = await modFile.async("uint8array");
        resultZip.file(origPath, content);
      }
    }
  }

  // For new sheets (in modified but not in original), add them
  // Find the highest sheet number in the original to avoid collisions
  const existingSheetFiles = Object.keys(origZip.files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
  let maxSheetNum = 0;
  for (const f of existingSheetFiles) {
    const num = parseInt(f.match(/sheet(\d+)\.xml/)?.[1] || "0");
    if (num > maxSheetNum) maxSheetNum = num;
  }

  // Find max rId and sheetId in original workbook.xml
  const origWbXml = await resultZip.file("xl/workbook.xml")!.async("string");
  const origRelsXml = await resultZip.file("xl/_rels/workbook.xml.rels")!.async("string");
  let maxRid = 0;
  const ridRegex = /Id="rId(\d+)"/g;
  let rm: RegExpExecArray | null;
  while ((rm = ridRegex.exec(origRelsXml)) !== null) {
    const n = parseInt(rm[1]); if (n > maxRid) maxRid = n;
  }
  let maxSheetId = 0;
  const sidRegex = /sheetId="(\d+)"/g;
  while ((rm = sidRegex.exec(origWbXml)) !== null) {
    const n = parseInt(rm[1]); if (n > maxSheetId) maxSheetId = n;
  }

  let updatedWbXml = origWbXml;
  let updatedRelsXml = origRelsXml;
  let updatedContentTypes = await resultZip.file("[Content_Types].xml")!.async("string");

  for (const name of modifiedSheetNames) {
    if (origSheetMap[name]) continue; // already handled above
    const modPath = modSheetMap[name];
    if (!modPath) continue;

    maxSheetNum++;
    maxRid++;
    maxSheetId++;

    const newFileName = `sheet${maxSheetNum}.xml`;
    const newFilePath = `xl/worksheets/${newFileName}`;
    const newRid = `rId${maxRid}`;

    // Copy sheet XML from mod zip
    const modFile = modZip.file(modPath);
    if (modFile) {
      const content = await modFile.async("uint8array");
      resultZip.file(newFilePath, content);
    }

    // Add to workbook.xml (before </sheets>)
    const sheetEntry = `<sheet name="${name}" sheetId="${maxSheetId}" r:id="${newRid}"/>`;
    updatedWbXml = updatedWbXml.replace("</sheets>", sheetEntry + "</sheets>");

    // Add to relationships
    const relEntry = `<Relationship Id="${newRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${newFileName}"/>`;
    updatedRelsXml = updatedRelsXml.replace("</Relationships>", relEntry + "</Relationships>");

    // Add to content types
    const ctEntry = `<Override PartName="/xl/worksheets/${newFileName}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
    updatedContentTypes = updatedContentTypes.replace("</Types>", ctEntry + "</Types>");
  }

  // Remove deleted sheets
  for (const delName of deletedSheetNames) {
    const origPath = origSheetMap[delName];
    if (!origPath) continue;

    // Remove sheet XML file
    resultZip.remove(origPath);
    const relsPath = origPath.replace("worksheets/", "worksheets/_rels/") + ".rels";
    if (resultZip.file(relsPath)) resultZip.remove(relsPath);

    // Remove from workbook.xml
    const escaped = delName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    updatedWbXml = updatedWbXml.replace(new RegExp(`<sheet[^>]+name="${escaped}"[^>]*/?>`, "g"), "");
  }

  // Write updated metadata files
  resultZip.file("xl/workbook.xml", updatedWbXml);
  resultZip.file("xl/_rels/workbook.xml.rels", updatedRelsXml);
  resultZip.file("[Content_Types].xml", updatedContentTypes);

  // Also copy shared strings from the mod workbook (new sheets may reference them)
  const modSharedStrings = modZip.file("xl/sharedStrings.xml");
  if (modSharedStrings) {
    // Merge: for now, keep original shared strings (our sheets mostly use inline values)
    // If needed, we could merge shared string tables here
  }

  return Buffer.from(await resultZip.generateAsync({ type: "nodebuffer" }));
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
  const lines = csv.split("\n");
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

interface WeeklyGoalsParams {
  user_id: number;
  year: number;
  weekly_billable_goal: number;
  hours_per_day?: number;
  box_folder_id?: string;
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
  const dailyGoal = params.weekly_billable_goal / 5;

  const rawEntries = await fetchAllPages<any>("/activities", {
    type: "TimeEntry", fields: "id,date,quantity,price,user{id,name}", user_id: params.user_id,
    created_since: `${startDate}T00:00:00+00:00`,
  });
  const entries = rawEntries.filter((e: any) => e.date >= startDate && e.date <= endDate);
  const userName = entries[0]?.user?.name ?? "Unknown";

  // Group by month and week
  const months: Record<string, { billable: number; nonbillable: number }> = {};
  const weeks: Record<string, { billable: number; nonbillable: number }> = {};

  for (const e of entries) {
    const hours = e.quantity / 3600;
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

  // Build Excel
  const wb = new ExcelJS.Workbook();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Summary (Monthly) sheet
  const ws1 = wb.addWorksheet("Summary");
  ws1.addRow(["Month", "Billable Goal", "Billable Actual", "Over/Under", "Nonbillable", "Total", "Available"]).font = { bold: true };

  let cumBillable = 0, cumGoal = 0;
  const currentMonth = new Date().getMonth() + 1; // 1-indexed
  const isCurrentYear = params.year === new Date().getFullYear();
  for (let m = 1; m <= 12; m++) {
    const key = `${params.year}-${String(m).padStart(2, "0")}`;
    const data = months[key] || { billable: 0, nonbillable: 0 };
    const wd = getWorkingDays(params.year, m);
    const goal = round1(wd * dailyGoal);
    const avail = wd * hoursPerDay;
    // Only accumulate YTD totals for months up to current month (or all months for past years)
    if (!isCurrentYear || m <= currentMonth) {
      cumBillable += data.billable; cumGoal += goal;
    }
    const ou = round1(data.billable - goal);
    const row = ws1.addRow([monthNames[m - 1], goal, round1(data.billable), ou, round1(data.nonbillable), round1(data.billable + data.nonbillable), avail]);
    row.getCell(4).font = { color: { argb: ou >= 0 ? "FF008000" : "FFFF0000" } };
  }
  const totRow = ws1.addRow(["YTD Total", round1(cumGoal), round1(cumBillable), round1(cumBillable - cumGoal), "", "", ""]);
  totRow.font = { bold: true };
  totRow.getCell(4).font = { bold: true, color: { argb: (cumBillable - cumGoal) >= 0 ? "FF008000" : "FFFF0000" } };

  // Weekly sheet: horizontal layout - weeks as columns, metrics as rows
  const ws2 = wb.addWorksheet("Weekly");
  const headerRow = ws2.getRow(4);
  for (let i = 0; i < allWeeks.length; i++) {
    headerRow.getCell(i + 3).value = allWeeks[i].key;
  }

  ws2.getCell("B5").value = "Billable";
  ws2.getCell("B5").font = { bold: true };
  for (let i = 0; i < allWeeks.length; i++) {
    const data = weeks[allWeeks[i].key];
    ws2.getRow(5).getCell(i + 3).value = round1(data?.billable ?? 0);
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

  // Row 12: YTD Over/Under — running cumulative, only through current week
  ws2.getCell("B12").value = "YTD Over/Under";
  ws2.getCell("B12").font = { bold: true };
  const today = new Date();
  today.setHours(12, 0, 0, 0);
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

  ws2.getColumn(2).width = 14;
  for (let i = 0; i < allWeeks.length; i++) {
    ws2.getColumn(i + 3).width = 10;
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const filename = `${userName} Goals ${params.year}.xlsx`;

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
    return { filename: boxFilename, box_file_id: result.box_file_id, box_url: result.box_url };
  }

  const base64 = buffer.toString("base64");
  return { filename, base64, size_kb: Math.round(buffer.byteLength / 1024) };
}

// ─── ROSTER (hardcoded for batch weekly goals, grouped by team) ──

const WEEKLY_GOALS_ROSTER = [
  { name: "Nicholas Noe",    user_id: 348755029, goal: 35, group: "NRN" },
  { name: "Tzipora Simmons", user_id: 359711375, goal: 30, group: "NRN" },
  { name: "Kaz Gonzalez",    user_id: 358550509, goal: 28, group: "NRN" },
  { name: "Paul Romano",     user_id: 344117381, goal: 30, group: "PAR" },
  { name: "Angela Alanis",   user_id: 358528744, goal: 28, group: "PAR" },
  { name: "Nick Fernelius",  user_id: 359380639, goal: 30, group: "PAR" },
  { name: "Kenny Sumner",    user_id: 344134017, goal: 30, group: "KES" },
  { name: "Jonathan Barbee", user_id: 360091325, goal: 30, group: "KES" },
  { name: "Anna Lozano",     user_id: 358108805, goal: 28, group: "KES" },
  { name: "May Huynh",       user_id: 359576660, goal: 30, group: "MNH" },
];

export function registerDocumentTools(server: McpServer): void {

  // ============================================================
  // TOOL 1: download_vd_statement
  // ============================================================
  server.tool(
    "download_vd_statement",
    "Generate a V&D Of Counsel compensation statement as a downloadable Word document. Includes cover letter from Rachel Trevino, compensation summary with tier breakdown, timekeeper detail, and payment history. Returns the document as base64 for download.",
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
        const base64 = buffer.toString("base64");
        const filename = `V&D Compensation Statement - ${monthName} ${params.year}.docx`;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              filename,
              format: "docx",
              size_kb: Math.round(buffer.length / 1024),
              base64,
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
    "Generate the firm-wide development meeting scorecard as a downloadable Excel file. Includes weekly and monthly data for all timekeepers. Returns the file as base64 for download.",
    {
      week_of: z.string().optional().describe("Date within the target week (YYYY-MM-DD). Defaults to today."),
      box_folder_id: z.string().optional().describe("Box folder ID to upload to. Omit to return base64. Empty string uses default folder."),
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
          fields: "id,date,quantity,price,billed,user{id,name}",
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
          const hours = e.quantity / 3600;
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

        if (params.box_folder_id !== undefined) {
          const folderId = params.box_folder_id || "375771584500";
          const result = await uploadToBox({ buffer, filename, folderId });
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, filename, box_file_id: result.box_file_id, box_url: result.box_url }) }] };
        }

        const base64 = buffer.toString("base64");
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ filename, format: "xlsx", size_kb: Math.round(buffer.byteLength / 1024), base64 }) }],
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
    "Generate an individual weekly goals Excel sheet for a specific timekeeper. Includes monthly and weekly breakdowns with goals and over/under tracking. Returns as base64 for download.",
    {
      user_id: z.coerce.number().describe("User/timekeeper ID"),
      year: z.coerce.number().describe("Year (e.g. 2026)"),
      weekly_billable_goal: z.coerce.number().describe("Weekly billable hours goal (e.g. 30 for TBS, 28 for Kaz)"),
      hours_per_day: z.coerce.number().optional().default(8).describe("Hours in a work day (default 8)"),
      box_folder_id: z.string().optional().describe("Box folder ID to upload to. Omit to return base64. Empty string uses default folder."),
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
          }).then((res) => ({ name, group, status: "uploaded" as const, filename: res.filename, box_url: res.box_url, box_file_id: res.box_file_id }))
            .catch((err: Error) => ({ name, group, status: `FAILED: ${err.message}` as const, filename: null, box_url: null, box_file_id: null }))
        )
      );

      const uploads = results.map((r) => (r.status === "fulfilled" ? r.value : r.reason));

      // Group by team
      const groups: Record<string, any[]> = {};
      for (const u of uploads) {
        const g = u.group || "Other";
        if (!groups[g]) groups[g] = [];
        groups[g].push({ name: u.name, status: u.status, filename: u.filename, box_url: u.box_url, box_file_id: u.box_file_id });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            year: targetYear,
            count: uploads.length,
            succeeded: uploads.filter((u: any) => u.status === "uploaded").length,
            failed: uploads.filter((u: any) => u.status !== "uploaded").length,
            by_team: groups,
          }, null, 2),
        }],
      };
    }
  );

  // ============================================================
  // TOOL 4: download_dashboard_update
  // ============================================================
  server.tool(
    "download_dashboard_update",
    "Generate a firm dashboard data update as a downloadable Excel file. Pulls all metrics from Clio for the specified month: individual hours, billed $, collected $, responsible collected $, utilization, realization, potential calls, case counts. Returns as base64 for download. Use this to update Rachel's monthly dashboard.",
    {
      month: z.coerce.number().describe("Month number (1-12)"),
      year: z.coerce.number().describe("Year (e.g. 2026)"),
      box_folder_id: z.string().optional().describe("Box folder ID to upload to. Omit to return base64. Empty string uses default folder."),
      update_existing: z.boolean().optional().describe("If true, downloads the firm dashboard from Box, updates the '26 Compare' sheet and bonus tabs, then uploads the modified file back."),
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
          { initials: "KGV", name: "Gus Vlahadamis", user_id: 360049685 },
          { initials: "CTD", name: "Courteney Daniel", user_id: 359865560 },
        ];

        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const monthName = monthNames[params.month - 1];
        const monthStart = `${params.year}-${String(params.month).padStart(2, "0")}-01`;
        const endDay = new Date(params.year, params.month, 0).getDate();
        const monthEnd = `${params.year}-${String(params.month).padStart(2, "0")}-${endDay}`;

        // Fetch time entries
        const entries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          fields: "id,date,quantity,price,billed,note,user{id,name},matter{id,display_number,responsible_attorney}",
          created_since: `${monthStart}T00:00:00+00:00`,
        }).then(e => e.filter((x: any) => x.date >= monthStart && x.date <= monthEnd));

        // Fetch fee allocation CSV for collections
        let csvRows: Record<string, string>[] = [];
        try { const result = await getFeeAllocationCSV(); csvRows = result.rows; } catch { /* may not exist */ }

        // Build per-user data
        const data: Record<number, {
          billableHrs: number; nonbillableHrs: number; billedHrs: number; unbilledHrs: number;
          billableDollars: number; billedDollars: number;
          bizDev: number; potentialClients: number; cle: number; otherAdmin: number;
          indivCollected: number; respCollected: number;
        }> = {};

        for (const r of ROSTER) {
          data[r.user_id] = {
            billableHrs: 0, nonbillableHrs: 0, billedHrs: 0, unbilledHrs: 0,
            billableDollars: 0, billedDollars: 0,
            bizDev: 0, potentialClients: 0, cle: 0, otherAdmin: 0,
            indivCollected: 0, respCollected: 0,
          };
        }

        for (const e of entries) {
          const uid = e.user?.id;
          if (!uid || !data[uid]) continue;
          const hours = e.quantity / 3600;
          const rate = e.price || 0;

          if (rate > 0) {
            data[uid].billableHrs += hours;
            data[uid].billableDollars += hours * rate;
            if (e.billed) { data[uid].billedHrs += hours; data[uid].billedDollars += hours * rate; }
            else { data[uid].unbilledHrs += hours; }
          } else {
            data[uid].nonbillableHrs += hours;
            // Categorize nonbillable by note keywords
            const note = (e.note || "").toLowerCase();
            if (note.includes("biz dev") || note.includes("business dev") || note.includes("marketing")) data[uid].bizDev += hours;
            else if (note.includes("potential") || note.includes("consult")) data[uid].potentialClients += hours;
            else if (note.includes("cle") || note.includes("education") || note.includes("training")) data[uid].cle += hours;
            else data[uid].otherAdmin += hours;
          }
        }

        // Collections from fee allocation CSV
        for (const r of csvRows) {
          const userName = r["User"] ?? "";
          const responsible = r["Responsible Attorney"] ?? "";
          const collected = parseFloat(r["Total Funds Collected"] || "0");

          // Individual collected
          const matchedUser = ROSTER.find(ro => userName.toLowerCase().includes(ro.name.toLowerCase().split(" ").pop()!));
          if (matchedUser && data[matchedUser.user_id]) {
            data[matchedUser.user_id].indivCollected += collected;
          }

          // Responsible collected
          const matchedResp = ROSTER.find(ro => responsible.toLowerCase().includes(ro.name.toLowerCase().split(" ").pop()!));
          if (matchedResp && data[matchedResp.user_id]) {
            data[matchedResp.user_id].respCollected += collected;
          }
        }

        // Pre-compute responsible hours/billed for each roster member (used by both paths)
        const respData: Record<number, { respHrs: number; respBilled: number }> = {};
        for (const r of ROSTER) {
          const respHrs = entries.filter((e: any) => e.matter?.responsible_attorney?.id === r.user_id && (e.price || 0) > 0)
            .reduce((s: number, e: any) => s + e.quantity / 3600, 0);
          const respBilled = entries.filter((e: any) => e.matter?.responsible_attorney?.id === r.user_id && (e.price || 0) > 0)
            .reduce((s: number, e: any) => s + (e.quantity / 3600) * (e.price || 0), 0);
          respData[r.user_id] = { respHrs, respBilled };
        }

        // ---- UPDATE EXISTING DASHBOARD IN BOX ----
        if (params.update_existing) {
          const DASHBOARD_FILE_ID = "2199202082188";
          const fileBuffer = await downloadFromBox(DASHBOARD_FILE_ID);
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(fileBuffer);

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

          // ---- Write Clio data into 26 Compare ----
          let tkUpdated = 0;
          for (const r of ROSTER) {
            const row = initialsRowMap[r.initials.toUpperCase()];
            if (!row) continue;
            const d = data[r.user_id];
            const rd = respData[r.user_id];
            const wsRow = compareSheet.getRow(row);
            wsRow.getCell(4).value = round1(d.bizDev);
            wsRow.getCell(5).value = round1(d.potentialClients);
            wsRow.getCell(6).value = round1(d.cle);
            wsRow.getCell(7).value = round1(d.otherAdmin);
            wsRow.getCell(8).value = round1(d.bizDev + d.potentialClients + d.cle + d.otherAdmin);
            wsRow.getCell(9).value = round1(d.billableHrs);
            wsRow.getCell(10).value = round1(d.billableHrs + d.nonbillableHrs);
            wsRow.getCell(11).value = round2(d.billedDollars);
            wsRow.getCell(14).value = round2(d.indivCollected);
            wsRow.getCell(17).value = round1(rd.respHrs);
            wsRow.getCell(18).value = round2(rd.respBilled);
            wsRow.getCell(19).value = round2(d.respCollected);
            wsRow.commit();
            tkUpdated++;
          }

          // ---- TRACK OLD BONUS SHEETS FOR DELETION ----
          // Don't remove from ExcelJS (causes writeBuffer crash) — surgical write handles deletion at zip level
          const sheetsToDelete = wb.worksheets.filter(ws => ws.name.toLowerCase().includes("bonus"));

          // ---- CREATE / UPDATE BONUS CONFIG SHEET ----
          const BONUS_ATTORNEYS = [
            { ini: "PAR", salary: 332340, associate: "JPB", paralegal: "ACA", paraSalary: 80000, legalAsst: 0, payroll: 0.17 },
            { ini: "KES", salary: 332340, associate: "TBS", paralegal: "AFL", paraSalary: 75000, legalAsst: 0, payroll: 0.17 },
            { ini: "NRN", salary: 255000, associate: "KGV", paralegal: "AKG", paraSalary: 75000, legalAsst: 0, payroll: 0.17 },
            { ini: "NAF", salary: 130000, associate: "",    paralegal: "",    paraSalary: 0,     legalAsst: 0, payroll: 0.17 },
            { ini: "MNH", salary: 110000, associate: "",    paralegal: "",    paraSalary: 0,     legalAsst: 0, payroll: 0.17 },
            { ini: "TBS", salary: 137500, associate: "",    paralegal: "",    paraSalary: 0,     legalAsst: 0, payroll: 0.17 },
            { ini: "JPB", salary: 129167, associate: "",    paralegal: "",    paraSalary: 0,     legalAsst: 0, payroll: 0.17 },
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

          // ---- DELETE OLD NAF TABS ----
          const nafSheets = wb.worksheets.filter(ws =>
            ws.name.includes("NAF(") || ws.name.includes("NAF Admin")
          );
          for (const ws of nafSheets) { sheetsToDelete.push(ws); }

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

          // ---- SAVE AND UPLOAD (surgical write to preserve Excel Tables) ----
          // Build a clean workbook with ONLY the sheets we modified/created.
          // ExcelJS can't round-trip the original file (corrupts Excel Tables),
          // so we only use it to generate the sheet XMLs we need.
          const cleanWb = new ExcelJS.Workbook();
          const sheetsToCopy = ["26 Compare", "Bonus Config", "Bonus Tracker", "Attorney Performance"];
          for (const sheetName of sheetsToCopy) {
            const srcSheet = wb.getWorksheet(sheetName);
            if (!srcSheet) continue;
            const dstSheet = cleanWb.addWorksheet(sheetName);
            // Copy cell values, converting shared formulas to avoid ExcelJS serialization crashes
            srcSheet.eachRow({ includeEmpty: false }, (srcRow, rowNum) => {
              const dstRow = dstSheet.getRow(rowNum);
              srcRow.eachCell({ includeEmpty: false }, (srcCell, colNum) => {
                const dstCell = dstRow.getCell(colNum);
                const val = srcCell.value as any;
                if (val && typeof val === "object") {
                  if ("sharedFormula" in val) {
                    // Shared formula clone — use cached result only
                    dstCell.value = val.result ?? null;
                  } else if ("formula" in val && "shareType" in val) {
                    // Shared formula master — convert to regular formula
                    dstCell.value = { formula: val.formula } as any;
                  } else if ("formula" in val) {
                    // Regular formula — keep as-is
                    dstCell.value = { formula: val.formula } as any;
                  } else if ("error" in val) {
                    // Error value — write empty
                    dstCell.value = null;
                  } else {
                    dstCell.value = val;
                  }
                } else {
                  dstCell.value = val;
                }
                if (srcCell.numFmt) dstCell.numFmt = srcCell.numFmt;
                if (srcCell.font) dstCell.font = srcCell.font;
              });
              dstRow.commit();
            });
            // Copy column widths
            srcSheet.columns.forEach((col, i) => {
              if (col.width) dstSheet.getColumn(i + 1).width = col.width;
            });
          }

          const modifiedSheets = new Set(sheetsToCopy);
          const deletedSheets = new Set(sheetsToDelete.map(ws => ws.name));
          const outputBuffer = await surgicalWriteXlsx(fileBuffer, cleanWb, modifiedSheets, deletedSheets);
          const result = await uploadToBox({
            buffer: outputBuffer,
            filename: `${params.year} Firm Dashboard - Claude Version.xlsx`,
            folderId: "348313592902",
            overwriteFileId: DASHBOARD_FILE_ID,
          });

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                updated_sheet: "26 Compare",
                month: monthName,
                year: params.year,
                timekeepers_updated: tkUpdated,
                block_created: blockCreated,
                bonus_tracker_rebuilt: true,
                attorneys_tracked: attys.length,
                box_file_id: result.box_file_id,
                box_url: result.box_url,
              }),
            }],
          };
        }

        // Build Excel
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet(`${monthName} ${params.year}`);

        ws.mergeCells("A1:N1");
        ws.getCell("A1").value = `Firm Dashboard Data - ${monthName} ${params.year}`;
        ws.getCell("A1").font = { bold: true, size: 14 };
        ws.addRow({});

        const hRow = ws.addRow([
          "Initials", "Name",
          "Biz Dev", "Potential Clients", "CLE", "Other Admin", "Total Nonbillable",
          "Billable Hours", "Total Hours",
          "Billed $ (Time)", "Indiv Collected $",
          "Resp Billable Hrs", "Resp Billed $", "Resp Collected $",
        ]);
        hRow.font = { bold: true };

        for (const r of ROSTER) {
          const d = data[r.user_id];
          const totalNonbill = round1(d.bizDev + d.potentialClients + d.cle + d.otherAdmin);
          const totalHrs = round1(d.billableHrs + d.nonbillableHrs);

          const rd = respData[r.user_id];

          ws.addRow([
            r.initials, r.name,
            round1(d.bizDev), round1(d.potentialClients), round1(d.cle), round1(d.otherAdmin), totalNonbill,
            round1(d.billableHrs), totalHrs,
            round2(d.billedDollars), round2(d.indivCollected),
            round1(rd.respHrs), round2(rd.respBilled), round2(d.respCollected),
          ]);
        }

        // Format currency columns
        for (const col of [10, 11, 13, 14]) {
          ws.getColumn(col).numFmt = '"$"#,##0.00';
        }

        // Auto-fit columns
        ws.columns.forEach(col => { col.width = Math.max(col.width || 10, 14); });

        const buffer = Buffer.from(await wb.xlsx.writeBuffer());

        if (params.box_folder_id !== undefined) {
          const boxFilename = `${params.year} Firm Dashboard.xlsx`;
          const folderId = params.box_folder_id || "375774779182";
          const result = await uploadToBox({ buffer, filename: boxFilename, folderId, overwriteFileId: "2191795122500" });
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, filename: boxFilename, box_file_id: result.box_file_id, box_url: result.box_url }) }] };
        }

        const base64 = buffer.toString("base64");
        const filename = `Dashboard Update - ${monthName} ${params.year}.xlsx`;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ filename, format: "xlsx", size_kb: Math.round(buffer.byteLength / 1024), base64 }) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message }) }], isError: true };
      }
    }
  );
}
