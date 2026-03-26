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

/**
 * Look up a Clio user by partial name match. Returns { id, name } or null.
 */
async function findUserByName(
  users: { id: number; name: string }[],
  search: string
): Promise<{ id: number; name: string } | null> {
  const lower = search.toLowerCase();
  return users.find((u) => u.name.toLowerCase().includes(lower)) ?? null;
}

// May Huynh's credit cap in hours per matter
const MAY_CREDIT_HOURS_CAP = 10;

export function registerCalcTools(server: McpServer): void {
  server.tool(
    "get_attributable_collections",
    "Attributable collections for Gus and Courtney. Shows total collections on matters where they are the responsible attorney, plus a credit for May Huynh's first 10 billable hours on each of those matters (valued at May's billed rate).",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
    },
    async (params) => {
      try {
        // 1. Fetch all Clio users to find Gus, Courtney, and May
        const allUsers = await fetchAllPages<any>("/users", {
          fields: "id,name,enabled",
        });
        const users = allUsers.map((u: any) => ({ id: u.id, name: u.name }));

        const gus = await findUserByName(users, "Gus");
        const courtney = await findUserByName(users, "Courtney");
        const may = await findUserByName(users, "May");

        if (!gus && !courtney) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: "Could not find Gus or Courtney in Clio users.",
                available_users: users.map((u) => u.name),
              }),
            }],
            isError: true,
          };
        }

        if (!may) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: "Could not find May in Clio users.",
                available_users: users.map((u) => u.name),
              }),
            }],
            isError: true,
          };
        }

        const targetAttorneys = [gus, courtney].filter(Boolean) as {
          id: number;
          name: string;
        }[];

        // 2. Get Fee Allocation CSV for collections data
        const csvRows = await getFeeAllocationCSV();

        // 3. Fetch matters where Gus or Courtney is the responsible attorney
        const targetIds = targetAttorneys.map((a) => a.id);
        const allMatters = await fetchAllPages<any>("/matters", {
          fields: "id,display_number,description,status,responsible_attorney{id,name}",
          status: "open",
        });

        // Also include closed matters that may have had collections in the period
        const closedMatters = await fetchAllPages<any>("/matters", {
          fields: "id,display_number,description,status,responsible_attorney{id,name}",
          status: "closed",
        });

        const allMattersList = [...allMatters, ...closedMatters];
        const mattersByAttorney: Record<
          number,
          { id: number; display_number: string; description: string }[]
        > = {};

        for (const atty of targetAttorneys) {
          mattersByAttorney[atty.id] = allMattersList
            .filter((m: any) => m.responsible_attorney?.id === atty.id)
            .map((m: any) => ({
              id: m.id,
              display_number: m.display_number,
              description: m.description,
            }));
        }

        // 4. For each attorney, sum collections from Fee Allocation CSV
        const results: any[] = [];

        for (const atty of targetAttorneys) {
          const attyNameLower = atty.name.toLowerCase();
          const matters = mattersByAttorney[atty.id] || [];
          const matterIds = new Set(matters.map((m) => m.id));

          // Match CSV rows by responsible attorney name
          const attyRows = csvRows.filter((r) => {
            const ra = (r["Responsible Attorney"] ?? "").toLowerCase();
            return ra.includes(attyNameLower) || attyNameLower.includes(ra);
          });

          const totalCollections = attyRows.reduce(
            (sum, r) => sum + parseFloat(r["Total Funds Collected"] || "0"),
            0
          );

          // Break down collections by timekeeper
          const tkCollections: Record<string, number> = {};
          for (const r of attyRows) {
            const user = r["User"] ?? "Unknown";
            tkCollections[user] =
              (tkCollections[user] || 0) +
              parseFloat(r["Total Funds Collected"] || "0");
          }

          // 5. Fetch May's time entries on this attorney's matters
          let mayCredit = 0;
          const mayCreditDetails: {
            matter_id: number;
            matter_number: string;
            total_hours: number;
            credited_hours: number;
            credit_value: number;
          }[] = [];

          if (matterIds.size > 0) {
            // Fetch May's time entries across all matters for the date range
            const mayEntries = await fetchAllPages<any>("/activities", {
              type: "TimeEntry",
              user_id: may.id,
              fields:
                "id,date,quantity,price,matter{id,display_number}",
              created_since: `${params.start_date}T00:00:00+00:00`,
            });

            // Filter to date range and this attorney's matters
            const relevantEntries = mayEntries.filter(
              (e: any) =>
                e.date >= params.start_date &&
                e.date <= params.end_date &&
                e.matter?.id &&
                matterIds.has(e.matter.id)
            );

            // Group by matter, sort by date, cap at 10 hours per matter
            const byMatter: Record<number, any[]> = {};
            for (const e of relevantEntries) {
              const mid = e.matter.id;
              if (!byMatter[mid]) byMatter[mid] = [];
              byMatter[mid].push(e);
            }

            for (const [midStr, entries] of Object.entries(byMatter)) {
              const mid = parseInt(midStr, 10);
              // Sort by date ascending so "first" hours are chronological
              entries.sort((a: any, b: any) => a.date.localeCompare(b.date));

              let hoursUsed = 0;
              let creditValue = 0;
              const totalHours = entries.reduce(
                (s: number, e: any) => s + e.quantity / 3600,
                0
              );

              for (const e of entries) {
                const hours = e.quantity / 3600;
                const rate = e.price || 0;
                const remaining = MAY_CREDIT_HOURS_CAP - hoursUsed;
                if (remaining <= 0) break;

                const credited = Math.min(hours, remaining);
                creditValue += credited * rate;
                hoursUsed += credited;
              }

              if (hoursUsed > 0) {
                const matter = matters.find((m) => m.id === mid);
                mayCreditDetails.push({
                  matter_id: mid,
                  matter_number: matter?.display_number ?? String(mid),
                  total_hours: round2(totalHours),
                  credited_hours: round2(hoursUsed),
                  credit_value: round2(creditValue),
                });
                mayCredit += creditValue;
              }
            }
          }

          const timekeeperBreakdown = Object.entries(tkCollections)
            .map(([name, collected]) => ({
              name,
              collected: round2(collected),
            }))
            .sort((a, b) => b.collected - a.collected);

          results.push({
            attorney: atty.name,
            attorney_id: atty.id,
            matter_count: matters.length,
            total_collections: round2(totalCollections),
            may_credit: {
              may_name: may.name,
              hours_cap_per_matter: MAY_CREDIT_HOURS_CAP,
              total_credit_value: round2(mayCredit),
              matters_with_credit: mayCreditDetails.length,
              details: mayCreditDetails,
            },
            attributable_total: round2(totalCollections + mayCredit),
            csv_rows_matched: attyRows.length,
            timekeeper_breakdown: timekeeperBreakdown,
          });
        }

        const firmTotal = round2(
          results.reduce((s, r) => s + r.attributable_total, 0)
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  source: "Clio Fee Allocation Report + May Huynh time credit",
                  period: { start: params.start_date, end: params.end_date },
                  combined_attributable_total: firmTotal,
                  attorneys: results,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: err.message,
                status: err.response?.status,
                clio_error: err.response?.data,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
