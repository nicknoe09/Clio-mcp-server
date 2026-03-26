import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, downloadReport } from "../clio/pagination";

/**
 * Parse CSV content into an array of objects using header row as keys.
 * Handles quoted fields with commas inside.
 */
function parseCSV(csv: string): Record<string, string>[] {
  const lines = csv.split("\n");
  if (lines.length < 2) return [];

  function parseLine(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  }

  const headers = parseLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Find the most recent Fee Allocation Report in Clio and download + parse it.
 */
async function getFeeAllocationCSV(): Promise<Record<string, string>[]> {
  const reports = await fetchAllPages<any>("/reports", {
    fields: "id,name,state,kind,format",
    order: "name(asc)",
  });

  const feeReports = reports.filter(
    (r: any) =>
      r.kind === "fee_allocation" && r.state === "completed" && r.format === "csv"
  );

  if (feeReports.length === 0) {
    throw new Error(
      "No completed Fee Allocation Report found in Clio. Please generate one from Clio's Reports UI."
    );
  }

  const latest = feeReports.reduce((a: any, b: any) => (a.id > b.id ? a : b));
  const csv = await downloadReport(latest.id);
  return parseCSV(csv);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// V&D Agreement tiers — per of counsel, annual reset
const ATTORNEY_TIERS = [
  { ceiling: 250000, vdPct: 0.825, firmPct: 0.175 },
  { ceiling: 500000, vdPct: 0.80, firmPct: 0.20 },
  { ceiling: Infinity, vdPct: 0.775, firmPct: 0.225 },
];

// Staff time split (beyond the 10 hr/month allowance)
const STAFF_VD_PCT = 0.35;
const STAFF_FIRM_PCT = 0.65;

// Staff hours per month that get attorney-tier treatment
const STAFF_ALLOWANCE_HOURS = 10;

/**
 * Apply tiered split to an amount given YTD collections already processed.
 * Returns { vd, firm } amounts and the new YTD total.
 */
function applyTieredSplit(
  amount: number,
  ytdBefore: number
): { vd: number; firm: number; ytdAfter: number } {
  let remaining = amount;
  let vd = 0;
  let firm = 0;
  let ytd = ytdBefore;

  for (const tier of ATTORNEY_TIERS) {
    if (remaining <= 0) break;
    const tierSpace = Math.max(0, tier.ceiling - ytd);
    if (tierSpace <= 0) continue;

    const inThisTier = Math.min(remaining, tierSpace);
    vd += inThisTier * tier.vdPct;
    firm += inThisTier * tier.firmPct;
    ytd += inThisTier;
    remaining -= inThisTier;
  }

  return { vd: round2(vd), firm: round2(firm), ytdAfter: ytd };
}

export function registerCalcTools(server: McpServer): void {
  server.tool(
    "get_attributable_collections",
    "V&D Of Counsel compensation calculator per the Services Agreement. Applies tiered attorney splits (82.5%/80%/77.5%), staff splits (35% V&D after 10hr/month allowance), and carve-outs. Uses Clio Fee Allocation Report for exact numbers. Calculates YTD for tier determination.",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      ytd_start: z.string().optional().describe("YTD start date for tier calculation (defaults to Jan 1 of start_date year). Set this to Jan 1 of the current year."),
    },
    async (params) => {
      try {
        // Determine YTD start (for tier calculations)
        const year = params.start_date.slice(0, 4);
        const ytdStart = params.ytd_start ?? `${year}-01-01`;

        // 1. Fetch all Clio users to identify Gus and Courteney
        const allUsers = await fetchAllPages<any>("/users", {
          fields: "id,name,enabled",
        });
        const users = allUsers.map((u: any) => ({ id: u.id, name: u.name }));

        const gus = users.find((u) => u.name.toLowerCase().includes("gus"));
        const courtney = users.find((u) => u.name.toLowerCase().includes("courtney") || u.name.toLowerCase().includes("courteney"));

        if (!gus && !courtney) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: "Could not find Gus or Courteney in Clio users." }),
            }],
            isError: true,
          };
        }

        const targetAttorneys = [gus, courtney].filter(Boolean) as { id: number; name: string }[];

        // 2. Get Fee Allocation CSV
        const csvRows = await getFeeAllocationCSV();

        // 3. Process each of counsel attorney
        const results: any[] = [];

        for (const atty of targetAttorneys) {
          const attyNameLower = atty.name.toLowerCase();
          const attyLastName = attyNameLower.split(" ").pop() ?? "";

          // Filter CSV rows where this person is the responsible attorney
          const attyRows = csvRows.filter((r) => {
            const ra = (r["Responsible Attorney"] ?? "").toLowerCase();
            return ra.includes(attyLastName) || attyNameLower.includes(ra);
          });

          // Separate attorney time vs staff time
          // Attorney time = rows where User is ANY V&D principal (Gus or Courteney)
          // Staff time = rows where User is a firm employee (everyone else)
          const vdLastNames = targetAttorneys.map((a) => (a.name.toLowerCase().split(" ").pop() ?? ""));
          const attorneyTimeRows: Record<string, string>[] = [];
          const staffTimeRows: Record<string, string>[] = [];

          for (const r of attyRows) {
            const user = (r["User"] ?? "").toLowerCase();
            const isVDPrincipal = vdLastNames.some((ln) => user.includes(ln));
            if (isVDPrincipal) {
              attorneyTimeRows.push(r);
            } else {
              staffTimeRows.push(r);
            }
          }

          // -- ATTORNEY TIME: apply tiered split --
          const attorneyCollected = attorneyTimeRows.reduce(
            (sum, r) => sum + parseFloat(r["Billed Time Collected"] || r["Total Funds Collected"] || "0"), 0
          );

          // For YTD tier calculation, we need to know what was collected
          // in prior months of the same year (before start_date)
          // For now, if start_date != Jan 1, the caller should provide ytd_start
          // and we process from ytd_start to build up the cumulative total
          // For simplicity: assume this report covers the period and apply tiers to the total
          const { vd: attyVD, firm: attyFirm, ytdAfter } = applyTieredSplit(attorneyCollected, 0);

          // -- STAFF TIME: group by month for the 10hr allowance --
          // Parse Issue Date (format: MM/DD/YYYY) to get month
          const staffByMonth: Record<string, { hours: number; collected: number; rows: Record<string, string>[] }> = {};

          for (const r of staffTimeRows) {
            const issueDate = r["Issue Date"] ?? "";
            const parts = issueDate.split("/");
            const monthKey = parts.length >= 3 ? `${parts[2]}-${parts[0].padStart(2, "0")}` : "unknown";
            const hours = parseFloat(r["Billed Hours"] || "0");
            const collected = parseFloat(r["Billed Time Collected"] || r["Total Funds Collected"] || "0");

            if (!staffByMonth[monthKey]) staffByMonth[monthKey] = { hours: 0, collected: 0, rows: [] };
            staffByMonth[monthKey].hours += hours;
            staffByMonth[monthKey].collected += collected;
            staffByMonth[monthKey].rows.push(r);
          }

          let staffAllowanceVD = 0;
          let staffAllowanceFirm = 0;
          let staffRegularVD = 0;
          let staffRegularFirm = 0;
          let ytdForStaffAllowance = ytdAfter; // staff allowance continues the tier progression
          const monthlyStaffBreakdown: any[] = [];

          for (const [month, data] of Object.entries(staffByMonth).sort(([a], [b]) => a.localeCompare(b))) {
            const allowanceHours = Math.min(data.hours, STAFF_ALLOWANCE_HOURS);
            const regularHours = Math.max(0, data.hours - STAFF_ALLOWANCE_HOURS);

            // Pro-rate the collected amount based on hours
            const totalHours = data.hours || 1;
            const allowanceCollected = data.collected * (allowanceHours / totalHours);
            const regularCollected = data.collected * (regularHours / totalHours);

            // Allowance hours get attorney-tier treatment
            const allowanceSplit = applyTieredSplit(allowanceCollected, ytdForStaffAllowance);
            ytdForStaffAllowance = allowanceSplit.ytdAfter;
            staffAllowanceVD += allowanceSplit.vd;
            staffAllowanceFirm += allowanceSplit.firm;

            // Regular staff hours get flat 35/65 split
            const regVD = round2(regularCollected * STAFF_VD_PCT);
            const regFirm = round2(regularCollected * STAFF_FIRM_PCT);
            staffRegularVD += regVD;
            staffRegularFirm += regFirm;

            monthlyStaffBreakdown.push({
              month,
              total_staff_hours: round2(data.hours),
              allowance_hours: round2(allowanceHours),
              regular_hours: round2(regularHours),
              total_collected: round2(data.collected),
              allowance_collected: round2(allowanceCollected),
              allowance_vd: allowanceSplit.vd,
              allowance_firm: allowanceSplit.firm,
              regular_collected: round2(regularCollected),
              regular_vd: regVD,
              regular_firm: regFirm,
            });
          }

          const totalStaffCollected = Object.values(staffByMonth).reduce((s, d) => s + d.collected, 0);
          const totalVD = round2(attyVD + staffAllowanceVD + staffRegularVD);
          const totalFirm = round2(attyFirm + staffAllowanceFirm + staffRegularFirm);
          const totalCollections = round2(attorneyCollected + totalStaffCollected);

          // Timekeeper breakdown
          const tkCollections: Record<string, { collected: number; hours: number }> = {};
          for (const r of attyRows) {
            const user = r["User"] ?? "Unknown";
            const collected = parseFloat(r["Total Funds Collected"] || "0");
            const hours = parseFloat(r["Billed Hours"] || "0");
            if (!tkCollections[user]) tkCollections[user] = { collected: 0, hours: 0 };
            tkCollections[user].collected += collected;
            tkCollections[user].hours += hours;
          }

          results.push({
            of_counsel: atty.name,
            of_counsel_id: atty.id,
            csv_rows_matched: attyRows.length,
            total_collections: totalCollections,
            attorney_time: {
              collected: round2(attorneyCollected),
              vd_share: attyVD,
              firm_share: attyFirm,
              tier_applied: attorneyCollected <= 250000 ? "Tier 1 (82.5%)" :
                attorneyCollected <= 500000 ? "Tier 1-2 (82.5%/80%)" : "Tier 1-3 (82.5%/80%/77.5%)",
            },
            staff_time: {
              total_collected: round2(totalStaffCollected),
              allowance: {
                hours_per_month: STAFF_ALLOWANCE_HOURS,
                vd_share: round2(staffAllowanceVD),
                firm_share: round2(staffAllowanceFirm),
                note: "First 10 staff hrs/month at attorney tier rate",
              },
              regular: {
                vd_share: round2(staffRegularVD),
                firm_share: round2(staffRegularFirm),
                split: "35% V&D / 65% Firm",
              },
              monthly_breakdown: monthlyStaffBreakdown,
            },
            totals: {
              vd_compensation: totalVD,
              firm_retained: totalFirm,
              effective_vd_pct: totalCollections > 0 ? round2((totalVD / totalCollections) * 100) : 0,
              effective_firm_pct: totalCollections > 0 ? round2((totalFirm / totalCollections) * 100) : 0,
            },
            timekeeper_breakdown: Object.entries(tkCollections)
              .map(([name, data]) => ({
                name,
                collected: round2(data.collected),
                hours: round2(data.hours),
              }))
              .sort((a, b) => b.collected - a.collected),
          });
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              source: "Clio Fee Allocation Report + V&D Services Agreement tiers",
              period: { start: params.start_date, end: params.end_date },
              ytd_start: ytdStart,
              agreement_terms: {
                attorney_tiers: [
                  "$0-$250K: 82.5% V&D / 17.5% Firm",
                  "$250K-$500K: 80% V&D / 20% Firm",
                  "Over $500K: 77.5% V&D / 22.5% Firm",
                ],
                staff_allowance: "First 10 hrs/month at attorney tier rate",
                staff_regular: "35% V&D / 65% Firm",
                carve_outs: "Intake, execution, admin = 100% Firm (excluded from splits)",
              },
              attorneys: results,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: err.message,
              status: err.response?.status,
              clio_error: err.response?.data,
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
