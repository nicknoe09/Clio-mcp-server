import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle } from "../clio/pagination";
import ExcelJS from "exceljs";

// Harris County Probate Court picklist IDs
const HC_COURT_IDS = new Set([
  2225269,  // Harris County Probate Court 1
  2225284,  // Harris County Probate Court 2
  2225299,  // Harris County Probate Court 3
  2225314,  // Harris County Probate Court 4
  10358840, // Harris County Probate Court 5
]);

// HC rate caps by experience bracket (years → max hourly rate)
const HC_RATE_CAPS: { label: string; max: number }[] = [
  { label: "0-2 yrs",  max: 250 },
  { label: "3-5 yrs",  max: 300 },
  { label: "6-10 yrs", max: 400 },
  { label: "11-20 yrs", max: 500 },
  { label: "20+ yrs",  max: 600 },
];
const HC_PARALEGAL_MAX = 175;

// --- Programmatic flag detection ---

type Flag = {
  code: string;
  severity: "strike" | "reduce" | "review" | "rephrase";
  message: string;
};

const CLERICAL_PATTERNS = [
  /\b(schedul(?:e|ed|ing)\s+(hearing|deposition|meeting|call|appointment))/i,
  /\b(calendar(?:ed|ing)?)\b/i,
  /\b(fil(?:e|ed|ing)\s+(document|pleading|motion|order|petition))\b/i,
  /\b(mail(?:ed|ing)\s+(copies|documents))/i,
  /\b(sav(?:e|ed|ing)\s+(document|file|email))/i,
  /\b(print(?:ed|ing))\b/i,
  /\b(scan(?:ned|ning))\b/i,
  /\b(organiz(?:e|ed|ing)\s+file)/i,
  /\b(updat(?:e|ed|ing)\s+(calendar|spreadsheet|tracker|log))/i,
  /\b(download(?:ed|ing))\b/i,
];

// E-filing is OK for general hygiene, flagged only for HC
const EFILING_PATTERN = /\be-?fil(?:e|ed|ing)\b/i;

const BLOCK_BILLING_INDICATORS = [
  /;\s*[A-Z]/,                    // Semicolon followed by capital letter
  /\.\s+[A-Z][a-z]+\s/,          // Period + new sentence pattern (multiple sentences)
];

const VAGUE_PATTERNS = [
  /^(work on (case|matter|file)\.?)$/i,
  /^(review (file|matter|case)\.?)$/i,
  /^(attention to (case|matter|file)\.?)$/i,
  /^(legal (work|services|research)\.?)$/i,
  /^(various (tasks|matters|services)\.?)$/i,
];

const CONFERENCE_PATTERN = /\b(confer(?:red|ence|ring)?|discuss(?:ed|ion|ing)?|meet(?:ing)?|spoke|call)\s+(with|re(?:garding)?:?)\s/i;
const CONFERENCE_LEGAL_KEYWORDS = /\b(strateg|hearing|motion|discovery|settlement|mediation|trial|deposition|claims?|defense|argument|brief|pleading|objection|response|opposition|estate plan|guardian|ward|fiduciary|trustee|executor|probate)\b/i;

const RESEARCH_PATTERN = /\b(research(?:ed|ing)?|legal research)\b/i;

const FEE_PETITION_PATTERN = /\b(fee (application|petition|statement|affidavit)|prepar(?:e|ed|ing)\s+(fee|billing))/i;
const COURT_STAFF_PATTERN = /\b(call(?:ed)?\s+(clerk|coordinator|court staff)|email(?:ed)?\s+(clerk|coordinator))\b/i;
const TRAVEL_PATTERN = /\b(travel(?:ed|ing)?|drove|driving|commut)/i;

function detectFlags(
  note: string,
  rate: number,
  hours: number,
  isHC: boolean
): Flag[] {
  const flags: Flag[] = [];
  if (!note || note.trim().length === 0) {
    flags.push({ code: "NO_DESC", severity: "strike", message: "No description provided" });
    return flags;
  }

  const trimmed = note.trim();

  // Block billing
  const semicolons = (trimmed.match(/;/g) || []).length;
  const sentences = trimmed.split(/\.\s+[A-Z]/).length;
  if (semicolons >= 2 || sentences >= 3) {
    flags.push({ code: "BLOCK_BILL", severity: "reduce", message: `Block billing detected (${semicolons} semicolons, ~${sentences} tasks). HC standard: 15-40% reduction.` });
  } else if (BLOCK_BILLING_INDICATORS.some(p => p.test(trimmed)) && (semicolons >= 1 || sentences >= 2)) {
    flags.push({ code: "BLOCK_BILL_MILD", severity: "review", message: "Possible block billing — multiple tasks in one entry" });
  }

  // Vague entries
  if (trimmed.length < 15 || VAGUE_PATTERNS.some(p => p.test(trimmed))) {
    flags.push({ code: "VAGUE", severity: "reduce", message: "Vague entry — lacks who/what/why specificity" });
  }

  // Clerical work
  const isClerical = CLERICAL_PATTERNS.some(p => p.test(trimmed));
  const isEfiling = EFILING_PATTERN.test(trimmed);

  if (isClerical && !isEfiling) {
    flags.push({ code: "CLERICAL", severity: isHC ? "strike" : "strike", message: "Clerical/administrative work — non-compensable" });
  } else if (isEfiling && isHC) {
    flags.push({ code: "EFILING_HC", severity: "strike", message: "E-filing is non-compensable under HC standards" });
  }
  // E-filing is OK under general hygiene — no flag

  // Fee petition prep (HC: strike; general: review)
  if (FEE_PETITION_PATTERN.test(trimmed)) {
    flags.push({ code: "FEE_PETITION", severity: isHC ? "strike" : "review", message: isHC ? "Fee petition preparation — not recoverable under HC standards" : "Fee petition preparation — consider whether recoverable" });
  }

  // Court staff communication (HC only)
  if (isHC && COURT_STAFF_PATTERN.test(trimmed)) {
    flags.push({ code: "COURT_STAFF", severity: "strike", message: "Court staff communication — not billable under HC standards (except narrow correction scenarios)" });
  }

  // Travel (HC only — not reimbursable within Harris County)
  if (isHC && TRAVEL_PATTERN.test(trimmed)) {
    flags.push({ code: "TRAVEL_HC", severity: "strike", message: "Travel — not reimbursable within Harris County" });
  }

  // Research — HC: only if novel; general: OK but suggest rephrasing
  if (RESEARCH_PATTERN.test(trimmed)) {
    if (isHC) {
      flags.push({ code: "RESEARCH_HC", severity: "review", message: "Research — only compensable if novel issue under HC standards. Verify novelty." });
    } else {
      flags.push({ code: "RESEARCH_REPHRASE", severity: "rephrase", message: "Research — consider rephrasing to specify the issue researched" });
    }
  }

  // Internal conferencing
  if (CONFERENCE_PATTERN.test(trimmed)) {
    if (!CONFERENCE_LEGAL_KEYWORDS.test(trimmed)) {
      flags.push({ code: "CONFERENCE_VAGUE", severity: "review", message: "Internal conference — description doesn't reference legal strategy or substance. Rephrase or justify." });
    }
  }

  // Excessive time
  if (hours >= 4.0 && /\b(hearing|appearance|court)\b/i.test(trimmed)) {
    flags.push({ code: "EXCESS_HEARING", severity: "review", message: `${hours} hrs for hearing/appearance — HC guideline: simple hearings < 3-4 hrs total` });
  }
  if (hours >= 2.0 && /\b(pleading|motion|order)\b/i.test(trimmed) && /\b(routine|standard|simple)\b/i.test(trimmed)) {
    flags.push({ code: "EXCESS_ROUTINE", severity: "review", message: `${hours} hrs for routine pleading — HC guideline: 1-2 hrs` });
  }
  if (hours >= 0.3 && /^(call|email|voicemail|text|message)\b/i.test(trimmed) && trimmed.length < 60) {
    flags.push({ code: "EXCESS_COMMS", severity: "review", message: `${hours} hrs for brief communication — review for reasonableness` });
  }

  // Round-number billing (pattern, not auto-reduce)
  if (hours > 0 && hours === Math.floor(hours) && hours >= 2) {
    flags.push({ code: "ROUND_NUMBER", severity: "review", message: `Exact ${hours}.0 hrs — round-number billing pattern` });
  }

  return flags;
}

function detectDuplicates(entries: any[]): Map<number, string> {
  const dupeFlags = new Map<number, string>();
  const seen = new Map<string, number[]>();

  for (const e of entries) {
    const key = `${e.date}|${e.user_id}|${(e.note || "").trim().toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key)!.push(e.line_item_id);
  }

  for (const [key, ids] of seen) {
    if (ids.length > 1) {
      for (const id of ids) {
        dupeFlags.set(id, `Duplicate entry (${ids.length} identical entries on same date/timekeeper)`);
      }
    }
  }

  return dupeFlags;
}

function detectBillingSpikes(entries: any[]): Map<number, string> {
  const spikeFlags = new Map<number, string>();
  // Group by user + week
  const weeklyHours = new Map<string, { total: number; ids: number[] }>();

  for (const e of entries) {
    const d = new Date(e.date);
    const weekNum = Math.floor(d.getTime() / (7 * 24 * 60 * 60 * 1000));
    const key = `${e.user_id}|${weekNum}`;
    if (!weeklyHours.has(key)) weeklyHours.set(key, { total: 0, ids: [] });
    const w = weeklyHours.get(key)!;
    w.total += e.hours;
    w.ids.push(e.line_item_id);
  }

  // Flag weeks with >50 hours from a single timekeeper as a spike
  for (const [, w] of weeklyHours) {
    if (w.total > 50) {
      for (const id of w.ids) {
        spikeFlags.set(id, `Billing spike — ${w.total.toFixed(1)} hrs in one week from this timekeeper`);
      }
    }
  }

  return spikeFlags;
}

export function registerAuditTools(server: McpServer): void {

  // ============================================================
  //  audit_draft_bills — Pull and review time from draft bills
  // ============================================================
  server.tool(
    "audit_draft_bills",
    "Pull all time entries from DRAFT bills for a responsible attorney and review for billing compliance. Automatically determines whether to apply Harris County Probate Court fee standards (based on Court custom field) or general billing hygiene. Returns flagged entries with severity codes and a structured summary. Use download_bill_audit for Excel output.",
    {
      responsible_attorney_id: z.coerce.number().describe("Clio user ID of the responsible attorney"),
      practice_area: z.string().optional().describe("Optional: filter to a specific practice area (e.g. 'Guardianship', 'Probate')"),
    },
    async (params) => {
      try {
        // Step 1: Get all matters for this responsible attorney
        const matterParams: Record<string, any> = {
          fields: "id,display_number,description,practice_area{name},responsible_attorney{id,name},custom_field_values{id,field_name,value}",
          responsible_attorney_id: params.responsible_attorney_id,
          status: "open",
        };
        const matters = await fetchAllPages<any>("/matters", matterParams);

        // Build matter lookup with court classification
        const matterMap = new Map<number, {
          id: number;
          display_number: string;
          description: string;
          practice_area: string;
          court_id: number | null;
          court_name: string | null;
          is_hc: boolean;
          responsible_attorney: string;
        }>();

        for (const m of matters) {
          const pa = m.practice_area?.name || "Unknown";
          if (params.practice_area && pa.toLowerCase() !== params.practice_area.toLowerCase()) continue;

          const cfvs = m.custom_field_values || [];
          const courtField = cfvs.find((c: any) => c.field_name === "Court");
          const courtId = courtField?.value || null;
          const isHC = courtId ? HC_COURT_IDS.has(courtId) : false;

          matterMap.set(m.id, {
            id: m.id,
            display_number: m.display_number,
            description: m.description,
            practice_area: pa,
            court_id: courtId,
            court_name: courtId ? (HC_COURT_IDS.has(courtId) ? `Harris County Probate Court` : `Non-HC Court (${courtId})`) : null,
            is_hc: isHC,
            responsible_attorney: m.responsible_attorney?.name || "Unknown",
          });
        }

        if (matterMap.size === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: "No matching matters found for this attorney" + (params.practice_area ? ` with practice area '${params.practice_area}'` : "") }) }],
            isError: true,
          };
        }

        // Step 2: Get all draft bills
        const draftBills = await fetchAllPages<any>("/bills", {
          fields: "id,number,state,total,balance,issued_at,due_at,matters",
          state: "draft",
        });

        // Filter to bills that belong to this attorney's matters
        const matterIds = new Set(matterMap.keys());
        const relevantBills = draftBills.filter((b: any) => {
          const billMatter = b.matters?.[0];
          return billMatter && matterIds.has(billMatter.id);
        });

        if (relevantBills.length === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `No draft bills found for this attorney's ${matterMap.size} matters.` }) }],
            isError: true,
          };
        }

        // Step 3: Pull line items for each draft bill
        const allEntries: any[] = [];

        for (const bill of relevantBills) {
          const lineItems = await fetchAllPages<any>("/line_items", {
            fields: "id,total,type,date,description,quantity,price,bill{id,number},matter{id,display_number},user{id,name},activity{id,type,note}",
            bill_id: bill.id,
          });

          const matterId = bill.matters?.[0]?.id;
          const matterInfo = matterId ? matterMap.get(matterId) : null;

          for (const li of lineItems) {
            if (li.activity?.type !== "TimeEntry") continue;

            const hours = li.quantity ? li.quantity / 3600 : 0;
            const rate = li.price || 0;
            const note = li.activity?.note || li.description || "";
            const isHC = matterInfo?.is_hc || false;

            const flags = detectFlags(note, rate, hours, isHC);

            allEntries.push({
              line_item_id: li.id,
              bill_id: bill.id,
              bill_number: bill.number,
              bill_total: bill.total,
              matter_id: matterId,
              matter_number: matterInfo?.display_number || li.matter?.display_number || "Unknown",
              practice_area: matterInfo?.practice_area || "Unknown",
              is_hc: isHC,
              court_name: matterInfo?.court_name,
              date: li.date,
              user_id: li.user?.id,
              timekeeper: li.user?.name || "Unknown",
              hours: Math.round(hours * 100) / 100,
              rate,
              amount: Math.round((li.total || 0) * 100) / 100,
              note,
              flags,
            });
          }

          // Courtesy delay between bill fetches
          if (relevantBills.indexOf(bill) < relevantBills.length - 1) {
            await new Promise(r => setTimeout(r, 150));
          }
        }

        // Step 4: Cross-entry pattern detection
        const dupeFlags = detectDuplicates(allEntries);
        const spikeFlags = detectBillingSpikes(allEntries);

        for (const e of allEntries) {
          if (dupeFlags.has(e.line_item_id)) {
            e.flags.push({ code: "DUPLICATE", severity: "strike", message: dupeFlags.get(e.line_item_id) });
          }
          if (spikeFlags.has(e.line_item_id)) {
            e.flags.push({ code: "BILLING_SPIKE", severity: "review", message: spikeFlags.get(e.line_item_id) });
          }
        }

        // Step 5: Build summary
        const flaggedEntries = allEntries.filter(e => e.flags.length > 0);
        const totalHours = allEntries.reduce((s, e) => s + e.hours, 0);
        const totalAmount = allEntries.reduce((s, e) => s + e.amount, 0);
        const flaggedHours = flaggedEntries.reduce((s, e) => s + e.hours, 0);
        const flaggedAmount = flaggedEntries.reduce((s, e) => s + e.amount, 0);

        // Count flags by severity
        const severityCounts: Record<string, number> = { strike: 0, reduce: 0, review: 0, rephrase: 0 };
        const codeCounts: Record<string, number> = {};
        for (const e of flaggedEntries) {
          for (const f of e.flags) {
            severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
            codeCounts[f.code] = (codeCounts[f.code] || 0) + 1;
          }
        }

        // Group by bill for structured output
        const byBill = new Map<string, any[]>();
        for (const e of flaggedEntries) {
          const key = `${e.bill_number} (${e.matter_number})`;
          if (!byBill.has(key)) byBill.set(key, []);
          byBill.get(key)!.push({
            date: e.date,
            timekeeper: e.timekeeper,
            hours: e.hours,
            rate: e.rate,
            amount: e.amount,
            note: e.note?.slice(0, 200),
            flags: e.flags,
          });
        }

        const hcMatters = [...matterMap.values()].filter(m => m.is_hc).length;
        const generalMatters = [...matterMap.values()].filter(m => !m.is_hc).length;

        const result = {
          summary: {
            responsible_attorney: [...matterMap.values()][0]?.responsible_attorney || "Unknown",
            matters_reviewed: matterMap.size,
            hc_standard_matters: hcMatters,
            general_hygiene_matters: generalMatters,
            draft_bills: relevantBills.length,
            total_entries: allEntries.length,
            total_hours: Math.round(totalHours * 100) / 100,
            total_amount: Math.round(totalAmount * 100) / 100,
            flagged_entries: flaggedEntries.length,
            flagged_hours: Math.round(flaggedHours * 100) / 100,
            flagged_amount: Math.round(flaggedAmount * 100) / 100,
            flag_rate_pct: allEntries.length > 0 ? Math.round((flaggedEntries.length / allEntries.length) * 100) : 0,
            severity_counts: severityCounts,
            top_issues: Object.entries(codeCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([code, count]) => ({ code, count })),
          },
          flagged_by_bill: Object.fromEntries(byBill),
          _meta: {
            hc_court_ids: [...HC_COURT_IDS],
            standards_note: "HC = Harris County Probate Court fee standards (March 2025). General = billing hygiene (block billing, vague entries, clerical, duplicates).",
            severity_key: {
              strike: "Non-compensable — recommend striking entirely",
              reduce: "Reduce — entry overbilled or block-billed",
              review: "Needs human review — may be fine with justification",
              rephrase: "OK but should be rephrased for clarity",
            },
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }) }],
          isError: true,
        };
      }
    }
  );

  // ============================================================
  //  download_bill_audit — Excel export of audit results
  // ============================================================
  server.tool(
    "download_bill_audit",
    "Generate a downloadable Excel audit report of draft bill time entries for a responsible attorney. Includes all entries with flag annotations, severity ratings, and a summary sheet. Same data as audit_draft_bills but in spreadsheet format.",
    {
      responsible_attorney_id: z.coerce.number().describe("Clio user ID of the responsible attorney"),
      practice_area: z.string().optional().describe("Optional: filter to a specific practice area (e.g. 'Guardianship', 'Probate')"),
    },
    async (params) => {
      try {
        // --- Identical data pull as audit_draft_bills ---
        const matterParams: Record<string, any> = {
          fields: "id,display_number,description,practice_area{name},responsible_attorney{id,name},custom_field_values{id,field_name,value}",
          responsible_attorney_id: params.responsible_attorney_id,
          status: "open",
        };
        const matters = await fetchAllPages<any>("/matters", matterParams);

        const matterMap = new Map<number, {
          id: number;
          display_number: string;
          practice_area: string;
          court_id: number | null;
          is_hc: boolean;
          responsible_attorney: string;
        }>();

        for (const m of matters) {
          const pa = m.practice_area?.name || "Unknown";
          if (params.practice_area && pa.toLowerCase() !== params.practice_area.toLowerCase()) continue;

          const cfvs = m.custom_field_values || [];
          const courtField = cfvs.find((c: any) => c.field_name === "Court");
          const courtId = courtField?.value || null;

          matterMap.set(m.id, {
            id: m.id,
            display_number: m.display_number,
            practice_area: pa,
            court_id: courtId,
            is_hc: courtId ? HC_COURT_IDS.has(courtId) : false,
            responsible_attorney: m.responsible_attorney?.name || "Unknown",
          });
        }

        if (matterMap.size === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: "No matching matters found." }) }],
            isError: true,
          };
        }

        const draftBills = await fetchAllPages<any>("/bills", {
          fields: "id,number,state,total,balance,matters",
          state: "draft",
        });

        const matterIds = new Set(matterMap.keys());
        const relevantBills = draftBills.filter((b: any) => {
          const billMatter = b.matters?.[0];
          return billMatter && matterIds.has(billMatter.id);
        });

        if (relevantBills.length === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: "No draft bills found for this attorney's matters." }) }],
            isError: true,
          };
        }

        const allEntries: any[] = [];

        for (const bill of relevantBills) {
          const lineItems = await fetchAllPages<any>("/line_items", {
            fields: "id,total,type,date,description,quantity,price,bill{id,number},matter{id,display_number},user{id,name},activity{id,type,note}",
            bill_id: bill.id,
          });

          const matterId = bill.matters?.[0]?.id;
          const matterInfo = matterId ? matterMap.get(matterId) : null;

          for (const li of lineItems) {
            if (li.activity?.type !== "TimeEntry") continue;

            const hours = li.quantity ? li.quantity / 3600 : 0;
            const rate = li.price || 0;
            const note = li.activity?.note || li.description || "";
            const isHC = matterInfo?.is_hc || false;

            const flags = detectFlags(note, rate, hours, isHC);

            allEntries.push({
              line_item_id: li.id,
              bill_number: bill.number,
              bill_total: bill.total,
              matter_number: matterInfo?.display_number || li.matter?.display_number || "Unknown",
              practice_area: matterInfo?.practice_area || "Unknown",
              is_hc: isHC,
              date: li.date,
              timekeeper: li.user?.name || "Unknown",
              hours: Math.round(hours * 100) / 100,
              rate,
              amount: Math.round((li.total || 0) * 100) / 100,
              note,
              flags,
            });
          }

          if (relevantBills.indexOf(bill) < relevantBills.length - 1) {
            await new Promise(r => setTimeout(r, 150));
          }
        }

        // Cross-entry detection
        const dupeFlags = detectDuplicates(allEntries);
        const spikeFlags = detectBillingSpikes(allEntries);
        for (const e of allEntries) {
          if (dupeFlags.has(e.line_item_id)) {
            e.flags.push({ code: "DUPLICATE", severity: "strike", message: dupeFlags.get(e.line_item_id) });
          }
          if (spikeFlags.has(e.line_item_id)) {
            e.flags.push({ code: "BILLING_SPIKE", severity: "review", message: spikeFlags.get(e.line_item_id) });
          }
        }

        // --- Build Excel ---
        const wb = new ExcelJS.Workbook();
        const attorneyName = [...matterMap.values()][0]?.responsible_attorney || "Unknown";

        // Sheet 1: All Entries
        const ws1 = wb.addWorksheet("All Entries");
        ws1.columns = [
          { header: "Bill #", key: "bill", width: 10 },
          { header: "Matter", key: "matter", width: 45 },
          { header: "Practice Area", key: "pa", width: 18 },
          { header: "Standard", key: "standard", width: 10 },
          { header: "Date", key: "date", width: 12 },
          { header: "Timekeeper", key: "tk", width: 22 },
          { header: "Hours", key: "hours", width: 8 },
          { header: "Rate", key: "rate", width: 10 },
          { header: "Amount", key: "amount", width: 12 },
          { header: "Description", key: "note", width: 60 },
          { header: "Flags", key: "flags", width: 15 },
          { header: "Severity", key: "severity", width: 12 },
          { header: "Flag Details", key: "details", width: 50 },
        ];
        ws1.getRow(1).font = { bold: true };

        const severityColor: Record<string, string> = {
          strike: "FFFF0000",
          reduce: "FFFF8C00",
          review: "FFFFCC00",
          rephrase: "FF87CEEB",
        };

        for (const e of allEntries) {
          const worstSeverity = e.flags.length > 0
            ? (e.flags.some((f: Flag) => f.severity === "strike") ? "strike"
              : e.flags.some((f: Flag) => f.severity === "reduce") ? "reduce"
              : e.flags.some((f: Flag) => f.severity === "review") ? "review"
              : "rephrase")
            : "";

          const row = ws1.addRow({
            bill: e.bill_number,
            matter: e.matter_number,
            pa: e.practice_area,
            standard: e.is_hc ? "HC" : "General",
            date: e.date,
            tk: e.timekeeper,
            hours: e.hours,
            rate: e.rate,
            amount: e.amount,
            note: e.note?.slice(0, 300),
            flags: e.flags.map((f: Flag) => f.code).join(", "),
            severity: worstSeverity,
            details: e.flags.map((f: Flag) => f.message).join("; "),
          });

          if (worstSeverity && severityColor[worstSeverity]) {
            row.eachCell((cell) => {
              cell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: severityColor[worstSeverity] + "33" },
              };
            });
          }
        }

        ws1.getColumn("rate").numFmt = '"$"#,##0.00';
        ws1.getColumn("amount").numFmt = '"$"#,##0.00';

        // Sheet 2: Summary
        const ws2 = wb.addWorksheet("Summary");
        const flaggedEntries = allEntries.filter(e => e.flags.length > 0);
        const totalHours = allEntries.reduce((s, e) => s + e.hours, 0);
        const totalAmount = allEntries.reduce((s, e) => s + e.amount, 0);
        const flaggedHours = flaggedEntries.reduce((s, e) => s + e.hours, 0);
        const flaggedAmount = flaggedEntries.reduce((s, e) => s + e.amount, 0);

        ws2.getColumn(1).width = 30;
        ws2.getColumn(2).width = 20;

        ws2.addRow(["Draft Bill Audit Report", ""]).font = { bold: true, size: 14 };
        ws2.addRow([`Attorney: ${attorneyName}`, ""]);
        ws2.addRow([`Generated: ${new Date().toISOString().split("T")[0]}`, ""]);
        ws2.addRow([]);
        ws2.addRow(["Metric", "Value"]).font = { bold: true };
        ws2.addRow(["Matters Reviewed", matterMap.size]);
        ws2.addRow(["HC Standard Matters", [...matterMap.values()].filter(m => m.is_hc).length]);
        ws2.addRow(["General Hygiene Matters", [...matterMap.values()].filter(m => !m.is_hc).length]);
        ws2.addRow(["Draft Bills", relevantBills.length]);
        ws2.addRow(["Total Entries", allEntries.length]);
        ws2.addRow(["Total Hours", Math.round(totalHours * 100) / 100]);
        ws2.addRow(["Total Amount", Math.round(totalAmount * 100) / 100]);
        ws2.addRow([]);
        ws2.addRow(["Flagged Entries", flaggedEntries.length]);
        ws2.addRow(["Flagged Hours", Math.round(flaggedHours * 100) / 100]);
        ws2.addRow(["Flagged Amount", Math.round(flaggedAmount * 100) / 100]);
        ws2.addRow(["Flag Rate", `${allEntries.length > 0 ? Math.round((flaggedEntries.length / allEntries.length) * 100) : 0}%`]);

        ws2.addRow([]);
        ws2.addRow(["Severity Breakdown", ""]).font = { bold: true };
        const severityCounts: Record<string, number> = { strike: 0, reduce: 0, review: 0, rephrase: 0 };
        for (const e of flaggedEntries) {
          for (const f of e.flags) {
            severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
          }
        }
        ws2.addRow(["Strike (non-compensable)", severityCounts.strike]);
        ws2.addRow(["Reduce", severityCounts.reduce]);
        ws2.addRow(["Review needed", severityCounts.review]);
        ws2.addRow(["Rephrase", severityCounts.rephrase]);

        // Sheet 3: Flagged Only
        const ws3 = wb.addWorksheet("Flagged Only");
        ws3.columns = ws1.columns.map(c => ({ ...c }));
        ws3.getRow(1).font = { bold: true };

        for (const e of flaggedEntries) {
          const worstSeverity = e.flags.some((f: Flag) => f.severity === "strike") ? "strike"
            : e.flags.some((f: Flag) => f.severity === "reduce") ? "reduce"
            : e.flags.some((f: Flag) => f.severity === "review") ? "review"
            : "rephrase";

          const row = ws3.addRow({
            bill: e.bill_number,
            matter: e.matter_number,
            pa: e.practice_area,
            standard: e.is_hc ? "HC" : "General",
            date: e.date,
            tk: e.timekeeper,
            hours: e.hours,
            rate: e.rate,
            amount: e.amount,
            note: e.note?.slice(0, 300),
            flags: e.flags.map((f: Flag) => f.code).join(", "),
            severity: worstSeverity,
            details: e.flags.map((f: Flag) => f.message).join("; "),
          });

          if (severityColor[worstSeverity]) {
            row.eachCell((cell) => {
              cell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: severityColor[worstSeverity] + "33" },
              };
            });
          }
        }

        ws3.getColumn("rate").numFmt = '"$"#,##0.00';
        ws3.getColumn("amount").numFmt = '"$"#,##0.00';

        const buffer = await wb.xlsx.writeBuffer() as Buffer;
        const base64 = Buffer.from(buffer).toString("base64");
        const filename = `Bill Audit - ${attorneyName} - ${new Date().toISOString().split("T")[0]}.xlsx`;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              filename,
              format: "xlsx",
              size_kb: Math.round(buffer.byteLength / 1024),
              base64,
              summary: {
                attorney: attorneyName,
                matters: matterMap.size,
                draft_bills: relevantBills.length,
                total_entries: allEntries.length,
                flagged_entries: flaggedEntries.length,
                total_amount: Math.round(totalAmount * 100) / 100,
                flagged_amount: Math.round(flaggedAmount * 100) / 100,
              },
            }),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }) }],
          isError: true,
        };
      }
    }
  );
}
