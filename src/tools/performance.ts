import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";

const TIME_FIELDS =
  "id,date,quantity,price,total,note,billed,matter{id,display_number,description},user{id,name}";

/**
 * Count working days (Mon-Fri) between two dates inclusive.
 */
function getWorkingDays(start: string, end: string): number {
  const startDate = new Date(start);
  const endDate = new Date(end);
  let count = 0;
  const current = new Date(startDate);
  while (current <= endDate) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

/**
 * Get ISO week number for a date.
 */
function getWeekKey(dateStr: string): string {
  const d = new Date(dateStr);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d.getTime() - jan1.getTime()) / (1000 * 60 * 60 * 24));
  const week = Math.ceil((days + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function registerPerformanceTools(server: McpServer): void {
  // get_user_productivity
  server.tool(
    "get_user_productivity",
    "Timekeeper productivity report: total hours, billed/unbilled split, top matters by hours per timekeeper",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      user_id: z
        .number()
        .optional()
        .describe("Filter to a specific user (all users if omitted)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          type: "TimeEntry",
          fields: TIME_FIELDS,
          created_since: `${params.start_date}T00:00:00+00:00`,
        };
        if (params.user_id) queryParams.user_id = params.user_id;

        let entries = await fetchAllPages<any>("/activities", queryParams);
        entries = entries.filter((e: any) => e.date >= params.start_date && e.date <= params.end_date);

        const byUser: Record<
          number,
          {
            name: string;
            total_hours: number;
            billed_hours: number;
            unbilled_hours: number;
            total_value: number;
            matterHours: Record<number, { matter: any; hours: number }>;
          }
        > = {};

        for (const e of entries) {
          const uid = e.user?.id ?? 0;
          if (!byUser[uid]) {
            byUser[uid] = {
              name: e.user?.name ?? "Unknown",
              total_hours: 0,
              billed_hours: 0,
              unbilled_hours: 0,
              total_value: 0,
              matterHours: {},
            };
          }
          const hours = e.quantity / 3600;
          const value = hours * (e.price || 0);
          byUser[uid].total_hours += hours;
          byUser[uid].total_value += value;
          if (e.billed) byUser[uid].billed_hours += hours;
          else byUser[uid].unbilled_hours += hours;

          const mid = e.matter?.id ?? 0;
          if (!byUser[uid].matterHours[mid]) {
            byUser[uid].matterHours[mid] = { matter: e.matter, hours: 0 };
          }
          byUser[uid].matterHours[mid].hours += hours;
        }

        const results = Object.entries(byUser)
          .map(([uid, u]) => {
            const topMatters = Object.values(u.matterHours)
              .sort((a, b) => b.hours - a.hours)
              .slice(0, 5)
              .map((m) => ({
                matter: m.matter,
                hours: Math.round(m.hours * 100) / 100,
              }));

            return {
              user_id: parseInt(uid, 10),
              name: u.name,
              total_hours: Math.round(u.total_hours * 100) / 100,
              billed_hours: Math.round(u.billed_hours * 100) / 100,
              unbilled_hours: Math.round(u.unbilled_hours * 100) / 100,
              total_value: Math.round(u.total_value * 100) / 100,
              top_5_matters: topMatters,
            };
          })
          .sort((a, b) => b.total_hours - a.total_hours);

        const firmTotals = {
          total_hours:
            Math.round(results.reduce((s, r) => s + r.total_hours, 0) * 100) / 100,
          billed_hours:
            Math.round(results.reduce((s, r) => s + r.billed_hours, 0) * 100) / 100,
          unbilled_hours:
            Math.round(results.reduce((s, r) => s + r.unbilled_hours, 0) * 100) / 100,
          total_value:
            Math.round(results.reduce((s, r) => s + r.total_value, 0) * 100) / 100,
          timekeeper_count: results.length,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  period: {
                    start: params.start_date,
                    end: params.end_date,
                  },
                  firm_totals: firmTotals,
                  timekeepers: results,
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

  // get_utilization_report
  server.tool(
    "get_utilization_report",
    "Billable hours utilization per timekeeper. Flags timekeepers below 80% utilization. Includes weekly trend if period > 4 weeks.",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      target_hours_per_day: z
        .number()
        .optional()
        .default(6.0)
        .describe("Target billable hours per working day (default 6.0)"),
    },
    async (params) => {
      try {
        let entries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          fields: TIME_FIELDS,
          created_since: `${params.start_date}T00:00:00+00:00`,
        });
        entries = entries.filter((e: any) => e.date >= params.start_date && e.date <= params.end_date);

        const workingDays = getWorkingDays(params.start_date, params.end_date);
        const targetHours = workingDays * params.target_hours_per_day;

        // Check if period > 4 weeks for trend
        const startMs = new Date(params.start_date).getTime();
        const endMs = new Date(params.end_date).getTime();
        const periodWeeks = (endMs - startMs) / (1000 * 60 * 60 * 24 * 7);
        const showTrend = periodWeeks > 4;

        const byUser: Record<
          number,
          {
            name: string;
            billable_hours: number;
            weekly: Record<string, number>;
          }
        > = {};

        for (const e of entries) {
          const uid = e.user?.id ?? 0;
          if (!byUser[uid]) {
            byUser[uid] = {
              name: e.user?.name ?? "Unknown",
              billable_hours: 0,
              weekly: {},
            };
          }
          const hours = e.quantity / 3600;
          byUser[uid].billable_hours += hours;

          if (showTrend) {
            const wk = getWeekKey(e.date);
            byUser[uid].weekly[wk] = (byUser[uid].weekly[wk] || 0) + hours;
          }
        }

        const results = Object.entries(byUser)
          .map(([uid, u]) => {
            const avgPerDay =
              workingDays > 0 ? u.billable_hours / workingDays : 0;
            const utilPct =
              targetHours > 0
                ? (u.billable_hours / targetHours) * 100
                : 0;
            const variance = u.billable_hours - targetHours;

            const result: any = {
              user_id: parseInt(uid, 10),
              name: u.name,
              total_billable_hours:
                Math.round(u.billable_hours * 100) / 100,
              working_days: workingDays,
              avg_hours_per_day: Math.round(avgPerDay * 100) / 100,
              target_hours_per_day: params.target_hours_per_day,
              utilization_pct: Math.round(utilPct * 10) / 10,
              variance_from_target: Math.round(variance * 100) / 100,
              flag: utilPct < 80 ? "BELOW_TARGET" : null,
            };

            if (showTrend) {
              result.weekly_breakdown = Object.entries(u.weekly)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([week, hrs]) => ({
                  week,
                  hours: Math.round(hrs * 100) / 100,
                }));
            }

            return result;
          })
          .sort((a, b) => b.utilization_pct - a.utilization_pct);

        const firmAvgUtil =
          results.length > 0
            ? Math.round(
                (results.reduce((s, r) => s + r.utilization_pct, 0) /
                  results.length) *
                  10
              ) / 10
            : 0;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  period: {
                    start: params.start_date,
                    end: params.end_date,
                    working_days: workingDays,
                    target_hours_per_day: params.target_hours_per_day,
                    total_target_hours: targetHours,
                  },
                  summary: {
                    firm_avg_utilization_pct: firmAvgUtil,
                    highest_performer: results[0]?.name ?? "N/A",
                    lowest_performer:
                      results[results.length - 1]?.name ?? "N/A",
                    timekeepers_below_target: results.filter(
                      (r) => r.flag === "BELOW_TARGET"
                    ).length,
                  },
                  timekeepers: results,
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

  // get_realization_rate
  server.tool(
    "get_realization_rate",
    "Realization rate: billed value / worked value, by timekeeper and/or matter. Shows where time is being written off.",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      group_by: z
        .enum(["timekeeper", "matter", "both"])
        .optional()
        .default("both")
        .describe("Group results by timekeeper, matter, or both"),
    },
    async (params) => {
      try {
        const [rawTimeEntries, bills] = await Promise.all([
          fetchAllPages<any>("/activities", {
            type: "TimeEntry",
            fields: TIME_FIELDS,
            created_since: `${params.start_date}T00:00:00+00:00`,
          }),
          fetchAllPages<any>("/bills", {
            fields:
              "id,number,issued_at,total,state,matters",
            issued_after: params.start_date,
            issued_before: params.end_date,
          }),
        ]);
        const timeEntries = rawTimeEntries.filter((e: any) => e.date >= params.start_date && e.date <= params.end_date);

        // Firm-wide worked value
        const totalWorkedValue = timeEntries.reduce(
          (s: number, e: any) => s + (e.quantity / 3600) * (e.price || 0),
          0
        );
        const totalBilledValue = bills.reduce(
          (s: number, b: any) => s + (b.total || 0),
          0
        );
        const firmRealization =
          totalWorkedValue > 0 ? totalBilledValue / totalWorkedValue : 0;

        const result: any = {
          period: { start: params.start_date, end: params.end_date },
          firm_summary: {
            total_worked_value:
              Math.round(totalWorkedValue * 100) / 100,
            total_billed_value:
              Math.round(totalBilledValue * 100) / 100,
            realization_rate_pct:
              Math.round(firmRealization * 1000) / 10,
            total_write_downs:
              Math.round((totalWorkedValue - totalBilledValue) * 100) / 100,
          },
        };

        // By timekeeper
        if (
          params.group_by === "timekeeper" ||
          params.group_by === "both"
        ) {
          const byUser: Record<
            number,
            { name: string; worked_hours: number; worked_value: number }
          > = {};

          for (const e of timeEntries) {
            const uid = e.user?.id ?? 0;
            if (!byUser[uid]) {
              byUser[uid] = {
                name: e.user?.name ?? "Unknown",
                worked_hours: 0,
                worked_value: 0,
              };
            }
            const hours = e.quantity / 3600;
            byUser[uid].worked_hours += hours;
            byUser[uid].worked_value += hours * (e.price || 0);
          }

          // Note: Clio bills are per-matter, not per-user. Billed value by timekeeper
          // would require line-item attribution. We approximate from time entries marked as billed.
          const billedByUser: Record<
            number,
            { billed_hours: number; billed_value: number }
          > = {};
          for (const e of timeEntries) {
            if (!e.billed) continue;
            const uid = e.user?.id ?? 0;
            if (!billedByUser[uid]) {
              billedByUser[uid] = { billed_hours: 0, billed_value: 0 };
            }
            const hours = e.quantity / 3600;
            billedByUser[uid].billed_hours += hours;
            billedByUser[uid].billed_value += hours * (e.price || 0);
          }

          result.by_timekeeper = Object.entries(byUser)
            .map(([uid, u]) => {
              const billed = billedByUser[parseInt(uid, 10)] ?? {
                billed_hours: 0,
                billed_value: 0,
              };
              const rate =
                u.worked_value > 0
                  ? billed.billed_value / u.worked_value
                  : 0;
              let flag: string | null = null;
              if (rate < 0.7) flag = "RED";
              else if (rate < 0.85) flag = "YELLOW";

              return {
                user_id: parseInt(uid, 10),
                name: u.name,
                worked_hours: Math.round(u.worked_hours * 100) / 100,
                worked_value: Math.round(u.worked_value * 100) / 100,
                billed_value:
                  Math.round(billed.billed_value * 100) / 100,
                realization_rate_pct: Math.round(rate * 1000) / 10,
                write_down_amount:
                  Math.round(
                    (u.worked_value - billed.billed_value) * 100
                  ) / 100,
                flag,
              };
            })
            .sort((a, b) => b.worked_value - a.worked_value);
        }

        // By matter
        if (params.group_by === "matter" || params.group_by === "both") {
          const byMatter: Record<
            number,
            {
              matter: any;
              worked_hours: number;
              worked_value: number;
            }
          > = {};

          for (const e of timeEntries) {
            const mid = e.matter?.id ?? 0;
            if (!byMatter[mid]) {
              byMatter[mid] = {
                matter: e.matter,
                worked_hours: 0,
                worked_value: 0,
              };
            }
            const hours = e.quantity / 3600;
            byMatter[mid].worked_hours += hours;
            byMatter[mid].worked_value += hours * (e.price || 0);
          }

          const billedByMatter: Record<number, number> = {};
          for (const b of bills) {
            const mid = b.matters?.[0]?.id ?? 0;
            billedByMatter[mid] = (billedByMatter[mid] || 0) + (b.total || 0);
          }

          result.by_matter = Object.entries(byMatter)
            .map(([mid, m]) => {
              const billed = billedByMatter[parseInt(mid, 10)] ?? 0;
              const rate =
                m.worked_value > 0 ? billed / m.worked_value : 0;
              let flag: string | null = null;
              if (rate < 0.7) flag = "RED";
              else if (rate < 0.85) flag = "YELLOW";

              return {
                matter_id: parseInt(mid, 10),
                matter: m.matter,
                worked_hours: Math.round(m.worked_hours * 100) / 100,
                worked_value: Math.round(m.worked_value * 100) / 100,
                billed_value: Math.round(billed * 100) / 100,
                realization_rate_pct: Math.round(rate * 1000) / 10,
                write_down_amount:
                  Math.round((m.worked_value - billed) * 100) / 100,
                flag,
              };
            })
            .sort((a, b) => b.worked_value - a.worked_value);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
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

  // get_timekeeper_realization
  server.tool(
    "get_timekeeper_realization",
    "Deep per-attorney breakdown: worked, billed, collected, effective hourly rate. Associate management report. Supports monthly or yearly breakdowns. Requires user_id for per-timekeeper detail.",
    {
      user_id: z.coerce.number().describe("User/timekeeper ID (required)"),
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      breakdown: z
        .enum(["none", "monthly", "yearly"])
        .optional()
        .default("none")
        .describe("Break results into monthly or yearly periods"),
    },
    async (params) => {
      try {
        // Only fetch this user's time entries — no bills needed
        const rawEntries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          fields: TIME_FIELDS,
          user_id: params.user_id,
          created_since: `${params.start_date}T00:00:00+00:00`,
        });
        const entries = rawEntries.filter(
          (e: any) => e.date >= params.start_date && e.date <= params.end_date
        );

        // Compute realization from time entries alone (billed flag = was it invoiced)
        function computeStats(items: any[]) {
          let worked_hours = 0, worked_value = 0, billed_hours = 0, billed_value = 0;
          let standard_rate = 0;

          for (const e of items) {
            const hours = e.quantity / 3600;
            const value = hours * (e.price || 0);
            worked_hours += hours;
            worked_value += value;
            if (e.price && e.price > standard_rate) standard_rate = e.price;
            if (e.billed) {
              billed_hours += hours;
              billed_value += value;
            }
          }

          const realizationPct = worked_value > 0 ? (billed_value / worked_value) * 100 : 0;

          return {
            standard_rate,
            worked_hours: Math.round(worked_hours * 100) / 100,
            worked_value: Math.round(worked_value * 100) / 100,
            billed_hours: Math.round(billed_hours * 100) / 100,
            billed_value: Math.round(billed_value * 100) / 100,
            unbilled_hours: Math.round((worked_hours - billed_hours) * 100) / 100,
            unbilled_value: Math.round((worked_value - billed_value) * 100) / 100,
            realization_pct: Math.round(realizationPct * 10) / 10,
          };
        }

        function periodKey(dateStr: string): string {
          if (params.breakdown === "monthly") return dateStr.slice(0, 7);
          if (params.breakdown === "yearly") return dateStr.slice(0, 4);
          return "total";
        }

        if (params.breakdown === "none") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                period: { start: params.start_date, end: params.end_date },
                ...computeStats(entries),
              }, null, 2),
            }],
          };
        }

        // Group by period
        const buckets: Record<string, any[]> = {};
        for (const e of entries) {
          const key = periodKey(e.date);
          if (!buckets[key]) buckets[key] = [];
          buckets[key].push(e);
        }

        const periods = Object.keys(buckets).sort().map((key) => ({
          period: key,
          ...computeStats(buckets[key]),
        }));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              date_range: { start: params.start_date, end: params.end_date },
              breakdown: params.breakdown,
              overall: computeStats(entries),
              periods,
            }, null, 2),
          }],
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

  // get_fee_allocation
  server.tool(
    "get_fee_allocation",
    "Fee allocation by timekeeper: uses Clio allocations (actual payment dates) to attribute collected amounts to timekeepers based on their billed dollar contribution to each matter.",
    {
      start_date: z.string().describe("Start date for collections period (YYYY-MM-DD)"),
      end_date: z.string().describe("End date for collections period (YYYY-MM-DD)"),
      user_id: z.coerce.number().optional().describe("Filter to a specific timekeeper"),
    },
    async (params) => {
      try {
        // Get allocations (actual payments) in the date range, include description for dedup
        const allAllocations = await fetchAllPages<any>("/allocations", {
          fields: "id,amount,date,description,bill{id,number},matter{id,display_number}",
          created_since: `${params.start_date}T00:00:00+00:00`,
        });
        const rawAllocations = allAllocations.filter((a: any) =>
          a.date && a.date >= params.start_date && a.date <= params.end_date && a.amount > 0
        );

        // Dedup: Clio sometimes creates both "Payment for bill #X" and "Payment for invoice #X"
        // for the same payment. If same (bill_id, amount) has both patterns, keep only the "bill" one.
        const billPatternKeys = new Set(
          rawAllocations
            .filter((a: any) => (a.description || "").startsWith("Payment for bill"))
            .map((a: any) => `${a.bill?.id}_${a.amount}`)
        );
        const allocations = rawAllocations.filter((a: any) => {
          const desc = a.description || "";
          if (desc.startsWith("Payment for invoice")) {
            const key = `${a.bill?.id}_${a.amount}`;
            if (billPatternKeys.has(key)) return false; // duplicate — bill version exists
          }
          return true;
        });

        // Collect unique matter IDs that had payments
        const matterIds = new Set(allocations.map((a: any) => a.matter?.id).filter(Boolean));

        // Fetch most recent billed entries, capped at 4000 for speed
        // order=id(desc) ensures we get recent entries matching recent payments
        const entryParams: Record<string, any> = {
          type: "TimeEntry",
          billed: true,
          fields: "id,quantity,price,matter{id},user{id,name}",
          order: "id(desc)",
        };
        if (params.user_id) entryParams.user_id = params.user_id;

        const entries = await fetchAllPages<any>("/activities", entryParams, 4000);

        const matterUserValue: Record<number, Record<number, { name: string; value: number }>> = {};
        const matterTotal: Record<number, number> = {};

        for (const e of entries) {
          const mid = e.matter?.id ?? 0;
          if (!matterIds.has(mid)) continue;
          const uid = e.user?.id ?? 0;
          const value = (e.quantity / 3600) * (e.price || 0);
          if (!matterUserValue[mid]) matterUserValue[mid] = {};
          if (!matterUserValue[mid][uid]) {
            matterUserValue[mid][uid] = { name: e.user?.name ?? "Unknown", value: 0 };
          }
          matterUserValue[mid][uid].value += value;
          matterTotal[mid] = (matterTotal[mid] || 0) + value;
        }

        // Allocate each payment proportionally to timekeepers
        const userResults: Record<number, {
          name: string;
          total_allocated: number;
          payments: { date: string; bill_number: string; matter: string; payment_amount: number; allocated: number }[];
        }> = {};

        for (const alloc of allocations) {
          const mid = alloc.matter?.id ?? 0;
          const matterDesc = alloc.matter?.display_number ?? "Unknown";
          const billNumber = alloc.bill?.number ?? "N/A";
          const amount = alloc.amount;

          const matterTotalValue = matterTotal[mid] || 0;
          const userValues = matterUserValue[mid] || {};

          for (const [uidStr, u] of Object.entries(userValues)) {
            const uid = parseInt(uidStr, 10);
            const proportion = matterTotalValue > 0 ? u.value / matterTotalValue : 0;
            const allocated = amount * proportion;

            if (!userResults[uid]) {
              userResults[uid] = { name: u.name, total_allocated: 0, payments: [] };
            }
            userResults[uid].total_allocated += allocated;
            userResults[uid].payments.push({
              date: alloc.date,
              bill_number: billNumber,
              matter: matterDesc,
              payment_amount: Math.round(amount * 100) / 100,
              allocated: Math.round(allocated * 100) / 100,
            });
          }
        }

        let results = Object.entries(userResults).map(([uid, u]) => ({
          user_id: parseInt(uid, 10),
          name: u.name,
          total_allocated: Math.round(u.total_allocated * 100) / 100,
          payment_count: u.payments.length,
          payments: u.payments,
        }));

        if (params.user_id) {
          results = results.filter((r) => r.user_id === params.user_id);
        }

        results.sort((a, b) => b.total_allocated - a.total_allocated);
        const firmTotal = Math.round(results.reduce((s, r) => s + r.total_allocated, 0) * 100) / 100;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              period: { start: params.start_date, end: params.end_date },
              total_collected: firmTotal,
              timekeeper_count: results.length,
              allocations: results,
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

  // get_responsible_collections
  server.tool(
    "get_responsible_collections",
    "Collections by responsible attorney. Matches Clio's Fee Allocation Report filtered by responsible attorney. The FULL payment amount is attributed to the matter's responsible attorney — no pro-rating by timekeeper.",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      breakdown: z
        .enum(["none", "monthly"])
        .optional()
        .default("none")
        .describe("Break results into monthly periods"),
    },
    async (params) => {
      try {
        const ATTORNEY_NAMES: Record<number, string> = {
          348755029: "Nicholas Noe",
          344134017: "Kenny Sumner",
          344117381: "Paul Romano",
          359865560: "Courteney Daniel",
          360049685: "Gus Vlahadamis",
          359138569: "Christopher Winiecki",
          359576660: "May Huynh",
        };

        // Fetch allocations with matter's responsible_attorney
        const allAllocations = await fetchAllPages<any>("/allocations", {
          fields: "id,amount,date,description,bill{id,number},matter{id,display_number,responsible_attorney}",
          created_since: `${params.start_date}T00:00:00+00:00`,
        });
        const rawAllocations = allAllocations.filter((a: any) =>
          a.date && a.date >= params.start_date && a.date <= params.end_date && a.amount > 0
        );

        // Dedup bill/invoice duplicates
        const billPatternKeys = new Set(
          rawAllocations
            .filter((a: any) => (a.description || "").startsWith("Payment for bill"))
            .map((a: any) => `${a.bill?.id}_${a.amount}`)
        );
        const allocations = rawAllocations.filter((a: any) => {
          const desc = a.description || "";
          if (desc.startsWith("Payment for invoice")) {
            const key = `${a.bill?.id}_${a.amount}`;
            if (billPatternKeys.has(key)) return false;
          }
          return true;
        });

        // Attribute full payment to the matter's responsible attorney
        function getPeriodKey(dateStr: string): string {
          return params.breakdown === "monthly" ? dateStr.slice(0, 7) : "total";
        }

        const rollup: Record<number, Record<string, number>> = {};

        for (const alloc of allocations) {
          const responsibleId = alloc.matter?.responsible_attorney?.id;
          if (!responsibleId) continue;

          const period = getPeriodKey(alloc.date);
          if (!rollup[responsibleId]) rollup[responsibleId] = {};
          rollup[responsibleId][period] = (rollup[responsibleId][period] || 0) + alloc.amount;
        }

        const results = Object.entries(rollup).map(([ridStr, periods]) => {
          const rid = parseInt(ridStr, 10);
          const totalCollections = Object.values(periods).reduce((s, v) => s + v, 0);

          const result: any = {
            responsible_attorney_id: rid,
            name: ATTORNEY_NAMES[rid] || `User ${rid}`,
            total_responsible_collections: Math.round(totalCollections * 100) / 100,
          };

          if (params.breakdown === "monthly") {
            result.monthly = Object.entries(periods)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([period, amount]) => ({
                period,
                collections: Math.round(amount * 100) / 100,
              }));
          }

          return result;
        }).sort((a, b) => b.total_responsible_collections - a.total_responsible_collections);

        const firmTotal = Math.round(results.reduce((s, r) => s + r.total_responsible_collections, 0) * 100) / 100;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              period: { start: params.start_date, end: params.end_date },
              firm_total_collections: firmTotal,
              responsible_attorneys: results,
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
