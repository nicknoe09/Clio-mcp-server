import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, downloadReport } from "../clio/pagination";
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageBreak, PageNumber, LevelFormat,
} from "docx";
import ExcelJS from "exceljs";
import { uploadToBox } from "../utils/box";

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

        // Build Excel
        const wb = new ExcelJS.Workbook();
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

        // Monthly sheet
        const ws1 = wb.addWorksheet("Monthly");
        ws1.mergeCells("A1:G1");
        ws1.getCell("A1").value = `${userName} - ${params.year} Goals (Weekly Goal: ${params.weekly_billable_goal} hrs)`;
        ws1.getCell("A1").font = { bold: true, size: 14 };
        ws1.addRow({});
        ws1.addRow(["Month", "Billable Goal", "Billable Actual", "Over/Under", "Nonbillable", "Total", "Available"]).font = { bold: true };

        let cumBillable = 0, cumGoal = 0;
        for (let m = 1; m <= 12; m++) {
          const key = `${params.year}-${String(m).padStart(2, "0")}`;
          const data = months[key] || { billable: 0, nonbillable: 0 };
          const wd = getWorkingDays(params.year, m);
          const goal = round1(wd * dailyGoal);
          const avail = wd * params.hours_per_day;
          cumBillable += data.billable; cumGoal += goal;
          ws1.addRow([monthNames[m - 1], goal, round1(data.billable), round1(data.billable - goal), round1(data.nonbillable), round1(data.billable + data.nonbillable), avail]);
        }
        const totRow = ws1.addRow(["YTD Total", round1(cumGoal), round1(cumBillable), round1(cumBillable - cumGoal), "", "", ""]);
        totRow.font = { bold: true };

        // Conditional formatting for over/under
        for (let r = 4; r <= ws1.rowCount; r++) {
          const cell = ws1.getCell(`D${r}`);
          if (typeof cell.value === "number") {
            cell.font = { color: { argb: cell.value >= 0 ? "FF008000" : "FFFF0000" } };
          }
        }

        // Weekly sheet
        const ws2 = wb.addWorksheet("Weekly");
        ws2.mergeCells("A1:E1");
        ws2.getCell("A1").value = `${userName} - Weekly Detail ${params.year}`;
        ws2.getCell("A1").font = { bold: true, size: 14 };
        ws2.addRow({});
        ws2.addRow(["Week", "Billable", "Goal", "Over/Under", "Nonbillable"]).font = { bold: true };

        const sortedWeeks = Object.entries(weeks).sort(([a], [b]) => {
          const parseW = (w: string) => { const p = w.split("-")[0].split("/"); return new Date(params.year, parseInt(p[0]) - 1, parseInt(p[1])); };
          return parseW(a).getTime() - parseW(b).getTime();
        });

        for (const [week, data] of sortedWeeks) {
          const row = ws2.addRow([week, round1(data.billable), params.weekly_billable_goal, round1(data.billable - params.weekly_billable_goal), round1(data.nonbillable)]);
          const ouCell = row.getCell(4);
          if (typeof ouCell.value === "number") {
            ouCell.font = { color: { argb: ouCell.value >= 0 ? "FF008000" : "FFFF0000" } };
          }
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
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, filename: boxFilename, box_file_id: result.box_file_id, box_url: result.box_url }) }] };
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
  // TOOL 4: download_dashboard_update
  // ============================================================
  server.tool(
    "download_dashboard_update",
    "Generate a firm dashboard data update as a downloadable Excel file. Pulls all metrics from Clio for the specified month: individual hours, billed $, collected $, responsible collected $, utilization, realization, potential calls, case counts. Returns as base64 for download. Use this to update Rachel's monthly dashboard.",
    {
      month: z.coerce.number().describe("Month number (1-12)"),
      year: z.coerce.number().describe("Year (e.g. 2026)"),
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

          // Responsible hours = sum of all time on matters where this person is responsible attorney
          const respHrs = entries.filter((e: any) => e.matter?.responsible_attorney?.id === r.user_id && (e.price || 0) > 0)
            .reduce((s: number, e: any) => s + e.quantity / 3600, 0);
          const respBilled = entries.filter((e: any) => e.matter?.responsible_attorney?.id === r.user_id && (e.price || 0) > 0)
            .reduce((s: number, e: any) => s + (e.quantity / 3600) * (e.price || 0), 0);

          ws.addRow([
            r.initials, r.name,
            round1(d.bizDev), round1(d.potentialClients), round1(d.cle), round1(d.otherAdmin), totalNonbill,
            round1(d.billableHrs), totalHrs,
            round2(d.billedDollars), round2(d.indivCollected),
            round1(respHrs), round2(respBilled), round2(d.respCollected),
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
