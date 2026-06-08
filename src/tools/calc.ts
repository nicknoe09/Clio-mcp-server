import { z } from "zod/v4";
import { applyTieredSplit, STAFF_VD_PCT, STAFF_FIRM_PCT, STAFF_ALLOWANCE_HOURS } from "../domain/vd";
import { round2 } from "../utils/num";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, downloadReport } from "../clio/pagination";
import { getFeeAllocationCSV } from "../clio/reportCsv";



// V&D Agreement tiers — COMBINED (Gus + Courteney pooled), annual reset

/**
 * Get month key from Issue Date (MM/DD/YYYY format)
 */
function getMonthKey(issueDate: string): string {
  const parts = issueDate.split("/");
  return parts.length >= 3 ? `${parts[2]}-${parts[0].padStart(2, "0")}` : "unknown";
}

/**
 * Determine current tier label based on YTD amount
 */
function tierLabel(ytd: number): string {
  if (ytd <= 250000) return "Tier 1 (82.5%)";
  if (ytd <= 500000) return "Tier 2 (80%)";
  return "Tier 3 (77.5%)";
}

export function registerCalcTools(server: McpServer): void {
  server.tool(
    "get_attributable_collections",
    "V&D Of Counsel compensation calculator per the Services Agreement. Gus and Courteney are treated as a JOINT UNIT for tier thresholds ($250K/$500K). Applies tiered attorney splits (82.5%/80%/77.5%), staff splits (35% V&D after 10hr/month allowance per of counsel). Uses Clio Fee Allocation Report. Always calculates from Jan 1 for accurate YTD tier placement. Optionally specify report_id from list_fee_allocation_reports to use a specific report instead of the latest.",
    {
      start_date: z.string().describe("Start date for display period (YYYY-MM-DD)"),
      end_date: z.string().describe("End date for display period (YYYY-MM-DD)"),
      report_id: z.coerce.number().optional().describe("Specific Clio report ID to use (from list_fee_allocation_reports). If omitted, uses the latest report."),
    },
    async (params) => {
      try {
        const year = params.start_date.slice(0, 4);

        // 1. Fetch all Clio users to identify V&D principals
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

        const vdAttorneys = [gus, courtney].filter(Boolean) as { id: number; name: string }[];
        const vdLastNames = vdAttorneys.map((a) => (a.name.toLowerCase().split(" ").pop() ?? ""));

        // 2. Get Fee Allocation CSV
        const { rows: csvRows, report: usedReport } = await getFeeAllocationCSV(params.report_id);

        // 3. Gather ALL V&D rows (where responsible attorney is Gus or Courteney)
        const vdRows: Record<string, string>[] = [];
        for (const r of csvRows) {
          const ra = (r["Responsible Attorney"] ?? "").toLowerCase();
          if (vdLastNames.some((ln) => ra.includes(ln))) {
            vdRows.push(r);
          }
        }

        // 4. Classify each row as attorney time or staff time, and tag with responsible attorney + month
        interface ClassifiedRow {
          row: Record<string, string>;
          responsibleName: string;
          userName: string;
          month: string;
          isAttorneyTime: boolean;
          collected: number;
          hours: number;
        }

        const classified: ClassifiedRow[] = vdRows.map((r) => {
          const userName = (r["User"] ?? "").toLowerCase();
          const isVD = vdLastNames.some((ln) => userName.includes(ln));
          return {
            row: r,
            responsibleName: r["Responsible Attorney"] ?? "Unknown",
            userName: r["User"] ?? "Unknown",
            month: getMonthKey(r["Issue Date"] ?? ""),
            isAttorneyTime: isVD,
            collected: parseFloat(r["Billed Time Collected"] || r["Total Funds Collected"] || "0"),
            hours: parseFloat(r["Billed Hours"] || "0"),
          };
        });

        // 5. Sort by month to process chronologically for tier accumulation
        const months = [...new Set(classified.map((c) => c.month))].sort();

        // 6. Process month by month — COMBINED YTD for tier calculation
        let combinedYTD = 0; // tracks combined attorney time for tier thresholds
        const monthlyResults: any[] = [];

        // Per-attorney accumulators
        const perAttorney: Record<string, {
          attorney_collected: number;
          attorney_vd: number;
          attorney_firm: number;
          staff_collected: number;
          staff_allowance_vd: number;
          staff_allowance_firm: number;
          staff_regular_vd: number;
          staff_regular_firm: number;
          total_vd: number;
          total_firm: number;
        }> = {};

        for (const atty of vdAttorneys) {
          perAttorney[atty.name] = {
            attorney_collected: 0, attorney_vd: 0, attorney_firm: 0,
            staff_collected: 0, staff_allowance_vd: 0, staff_allowance_firm: 0,
            staff_regular_vd: 0, staff_regular_firm: 0, total_vd: 0, total_firm: 0,
          };
        }

        for (const month of months) {
          const monthRows = classified.filter((c) => c.month === month);
          const tierAtStart = tierLabel(combinedYTD);

          // -- Attorney time this month (combined for tier) --
          const attyTimeRows = monthRows.filter((c) => c.isAttorneyTime);
          const monthAttyCollected = attyTimeRows.reduce((s, c) => s + c.collected, 0);

          const attySplit = applyTieredSplit(monthAttyCollected, combinedYTD);
          combinedYTD = attySplit.ytdAfter;

          // Attribute the attorney split back to each responsible attorney proportionally
          const attyByResponsible: Record<string, number> = {};
          for (const c of attyTimeRows) {
            attyByResponsible[c.responsibleName] = (attyByResponsible[c.responsibleName] || 0) + c.collected;
          }
          for (const [name, collected] of Object.entries(attyByResponsible)) {
            const proportion = monthAttyCollected > 0 ? collected / monthAttyCollected : 0;
            const pa = perAttorney[name] ?? Object.values(perAttorney)[0];
            if (pa) {
              pa.attorney_collected += collected;
              pa.attorney_vd += attySplit.vd * proportion;
              pa.attorney_firm += attySplit.firm * proportion;
            }
          }

          // -- Staff time this month (per responsible attorney, 10hr allowance each) --
          const staffTimeRows = monthRows.filter((c) => !c.isAttorneyTime);
          const staffByResponsible: Record<string, { hours: number; collected: number }> = {};
          for (const c of staffTimeRows) {
            if (!staffByResponsible[c.responsibleName]) staffByResponsible[c.responsibleName] = { hours: 0, collected: 0 };
            staffByResponsible[c.responsibleName].hours += c.hours;
            staffByResponsible[c.responsibleName].collected += c.collected;
          }

          let monthStaffAllowanceVD = 0, monthStaffAllowanceFirm = 0;
          let monthStaffRegularVD = 0, monthStaffRegularFirm = 0;

          for (const [name, data] of Object.entries(staffByResponsible)) {
            const allowanceHours = Math.min(data.hours, STAFF_ALLOWANCE_HOURS);
            const regularHours = Math.max(0, data.hours - STAFF_ALLOWANCE_HOURS);
            const totalHours = data.hours || 1;

            const allowanceCollected = data.collected * (allowanceHours / totalHours);
            const regularCollected = data.collected * (regularHours / totalHours);

            // Allowance gets attorney-tier treatment (using current combined YTD)
            const allowanceSplit = applyTieredSplit(allowanceCollected, combinedYTD);
            combinedYTD = allowanceSplit.ytdAfter;
            monthStaffAllowanceVD += allowanceSplit.vd;
            monthStaffAllowanceFirm += allowanceSplit.firm;

            // Regular staff gets flat 35/65
            const regVD = round2(regularCollected * STAFF_VD_PCT);
            const regFirm = round2(regularCollected * STAFF_FIRM_PCT);
            monthStaffRegularVD += regVD;
            monthStaffRegularFirm += regFirm;

            const pa = perAttorney[name] ?? Object.values(perAttorney)[0];
            if (pa) {
              pa.staff_collected += data.collected;
              pa.staff_allowance_vd += allowanceSplit.vd;
              pa.staff_allowance_firm += allowanceSplit.firm;
              pa.staff_regular_vd += regVD;
              pa.staff_regular_firm += regFirm;
            }
          }

          monthlyResults.push({
            month,
            tier_at_start: tierAtStart,
            combined_ytd_after: round2(combinedYTD),
            attorney_time: { collected: round2(monthAttyCollected), vd: attySplit.vd, firm: attySplit.firm },
            staff_time: {
              allowance_vd: round2(monthStaffAllowanceVD),
              allowance_firm: round2(monthStaffAllowanceFirm),
              regular_vd: round2(monthStaffRegularVD),
              regular_firm: round2(monthStaffRegularFirm),
            },
          });
        }

        // 7. Finalize per-attorney totals
        const attorneyResults = vdAttorneys.map((atty) => {
          const pa = perAttorney[atty.name];
          const totalVD = round2(pa.attorney_vd + pa.staff_allowance_vd + pa.staff_regular_vd);
          const totalFirm = round2(pa.attorney_firm + pa.staff_allowance_firm + pa.staff_regular_firm);
          const totalCollections = round2(pa.attorney_collected + pa.staff_collected);
          pa.total_vd = totalVD;
          pa.total_firm = totalFirm;

          // Timekeeper breakdown for this responsible attorney
          const tkRows = classified.filter((c) => c.responsibleName === atty.name ||
            c.responsibleName.toLowerCase().includes(atty.name.toLowerCase().split(" ").pop() ?? ""));
          const tkMap: Record<string, { collected: number; hours: number }> = {};
          for (const c of tkRows) {
            if (!tkMap[c.userName]) tkMap[c.userName] = { collected: 0, hours: 0 };
            tkMap[c.userName].collected += c.collected;
            tkMap[c.userName].hours += c.hours;
          }

          return {
            of_counsel: atty.name,
            of_counsel_id: atty.id,
            total_collections: totalCollections,
            attorney_time: {
              collected: round2(pa.attorney_collected),
              vd_share: round2(pa.attorney_vd),
              firm_share: round2(pa.attorney_firm),
            },
            staff_time: {
              collected: round2(pa.staff_collected),
              allowance_vd: round2(pa.staff_allowance_vd),
              allowance_firm: round2(pa.staff_allowance_firm),
              regular_vd: round2(pa.staff_regular_vd),
              regular_firm: round2(pa.staff_regular_firm),
            },
            totals: {
              vd_compensation: totalVD,
              firm_retained: totalFirm,
              effective_vd_pct: totalCollections > 0 ? round2((totalVD / totalCollections) * 100) : 0,
              effective_firm_pct: totalCollections > 0 ? round2((totalFirm / totalCollections) * 100) : 0,
            },
            timekeeper_breakdown: Object.entries(tkMap)
              .map(([name, data]) => ({ name, collected: round2(data.collected), hours: round2(data.hours) }))
              .sort((a, b) => b.collected - a.collected),
          };
        });

        const grandTotalVD = round2(attorneyResults.reduce((s, a) => s + a.totals.vd_compensation, 0));
        const grandTotalFirm = round2(attorneyResults.reduce((s, a) => s + a.totals.firm_retained, 0));
        const grandTotalCollections = round2(attorneyResults.reduce((s, a) => s + a.total_collections, 0));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              source: "Clio Fee Allocation Report + V&D Services Agreement",
              report: { id: usedReport.id, name: usedReport.name },
              display_period: { start: params.start_date, end: params.end_date },
              ytd_calculated_from: `${year}-01-01`,
              note: "Gus + Courteney collections are POOLED for tier thresholds",
              agreement_terms: {
                attorney_tiers: [
                  "$0-$250K combined: 82.5% V&D / 17.5% Firm",
                  "$250K-$500K combined: 80% V&D / 20% Firm",
                  "Over $500K combined: 77.5% V&D / 22.5% Firm",
                ],
                staff_allowance: "First 10 hrs/month per of counsel at attorney tier rate",
                staff_regular: "35% V&D / 65% Firm",
              },
              combined_ytd: {
                total_attorney_collections: round2(combinedYTD),
                current_tier: tierLabel(combinedYTD),
              },
              grand_totals: {
                total_collections: grandTotalCollections,
                vd_compensation: grandTotalVD,
                firm_retained: grandTotalFirm,
              },
              per_attorney: attorneyResults,
              monthly_progression: monthlyResults,
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
