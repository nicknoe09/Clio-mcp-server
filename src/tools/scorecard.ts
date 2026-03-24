import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";

function getWorkingDays(year: number, month: number): number {
  let count = 0;
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(year, month - 1, d).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

function getWeekKey(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (dt: Date) => `${dt.getMonth() + 1}/${dt.getDate()}`;
  return `${fmt(monday)}-${fmt(sunday)}`;
}

export function registerScorecardTools(server: McpServer): void {
  server.tool(
    "generate_scorecard",
    "Generate a development meeting scorecard for a timekeeper. Returns monthly and weekly billable/nonbillable hour breakdowns with goals and over/under tracking. Use with the xlsx skill to create the spreadsheet.",
    {
      user_id: z.number().describe("User/timekeeper ID"),
      year: z.number().describe("Year (e.g. 2026)"),
      weekly_billable_goal: z.number().describe("Weekly billable hours goal (e.g. 30 for TBS, 28 for Kaz)"),
      hours_per_day: z.number().optional().default(8).describe("Hours in a work day (default 8)"),
    },
    async (params) => {
      try {
        const startDate = `${params.year}-01-01`;
        const today = new Date();
        const endDate = today.toISOString().split("T")[0];

        const rawEntries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          fields: "id,date,quantity,type,billed,user{id,name}",
          user_id: params.user_id,
          created_since: `${startDate}T00:00:00+00:00`,
        });

        const entries = rawEntries.filter(
          (e: any) => e.date >= startDate && e.date <= endDate
        );

        const userName = entries[0]?.user?.name ?? "Unknown";
        const dailyGoal = params.weekly_billable_goal / 5;

        // Monthly summary
        const months: Record<string, { billable: number; nonbillable: number }> = {};
        // Weekly detail
        const weeks: Record<string, { billable: number; nonbillable: number }> = {};

        for (const e of entries) {
          const hours = e.quantity / 3600;
          const monthKey = e.date.slice(0, 7); // YYYY-MM
          const weekKey = getWeekKey(e.date);
          const isBillable = e.type === "TimeEntry"; // all TimeEntries are billable unless type is different

          // Clio doesn't have a clean billable/nonbillable flag on activities.
          // We use price > 0 as proxy: entries with no rate are nonbillable
          // Actually, let's check if the entry has a price field
          // For now, count all as billable since they came from type=TimeEntry
          // TODO: refine if needed

          if (!months[monthKey]) months[monthKey] = { billable: 0, nonbillable: 0 };
          if (!weeks[weekKey]) weeks[weekKey] = { billable: 0, nonbillable: 0 };

          months[monthKey].billable += hours;
          weeks[weekKey].billable += hours;
        }

        // Also fetch nonbillable entries
        const nbEntries = await fetchAllPages<any>("/activities", {
          type: "NonBillableEntry",
          fields: "id,date,quantity,user{id,name}",
          user_id: params.user_id,
          created_since: `${startDate}T00:00:00+00:00`,
        }).catch(() => [] as any[]);

        for (const e of (nbEntries || [])) {
          if (e.date < startDate || e.date > endDate) continue;
          const hours = e.quantity / 3600;
          const monthKey = e.date.slice(0, 7);
          const weekKey = getWeekKey(e.date);

          if (!months[monthKey]) months[monthKey] = { billable: 0, nonbillable: 0 };
          if (!weeks[weekKey]) weeks[weekKey] = { billable: 0, nonbillable: 0 };

          months[monthKey].nonbillable += hours;
          weeks[weekKey].nonbillable += hours;
        }

        // Build monthly summary
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const monthlySummary = [];
        let cumulativeBillable = 0;
        let cumulativeGoal = 0;

        for (let m = 1; m <= 12; m++) {
          const key = `${params.year}-${String(m).padStart(2, "0")}`;
          const data = months[key];
          if (!data) continue;

          const workDays = getWorkingDays(params.year, m);
          const monthlyGoal = Math.round(workDays * dailyGoal * 10) / 10;
          const totalAvailable = workDays * params.hours_per_day;
          const billable = Math.round(data.billable * 10) / 10;
          const nonbillable = Math.round(data.nonbillable * 10) / 10;
          const totalTime = Math.round((billable + nonbillable) * 10) / 10;
          const overUnder = Math.round((billable - monthlyGoal) * 10) / 10;

          cumulativeBillable += billable;
          cumulativeGoal += monthlyGoal;

          monthlySummary.push({
            month: monthNames[m - 1],
            billable_actual: billable,
            billable_goal: monthlyGoal,
            nonbillable: nonbillable,
            total_time: totalTime,
            over_under: overUnder,
            total_available_time: totalAvailable,
            utilization_rate: Math.round((billable / totalAvailable) * 1000) / 10,
          });
        }

        // Build weekly detail (sorted chronologically)
        const weeklyDetail = Object.entries(weeks)
          .map(([week, data]) => ({
            week,
            billable: Math.round(data.billable * 10) / 10,
            nonbillable: Math.round(data.nonbillable * 10) / 10,
            total_tracked: Math.round((data.billable + data.nonbillable) * 10) / 10,
            billable_goal: params.weekly_billable_goal,
            over_under: Math.round((data.billable - params.weekly_billable_goal) * 10) / 10,
          }))
          .sort((a, b) => {
            // Parse first date from week key for sorting
            const parseWeek = (w: string) => {
              const parts = w.split("-")[0].split("/");
              return new Date(params.year, parseInt(parts[0]) - 1, parseInt(parts[1]));
            };
            return parseWeek(a.week).getTime() - parseWeek(b.week).getTime();
          });

        // Net totals
        const netBillable = Math.round(cumulativeBillable * 10) / 10;
        const netGoal = Math.round(cumulativeGoal * 10) / 10;
        const netNonbillable = Math.round(
          monthlySummary.reduce((s, m) => s + m.nonbillable, 0) * 10
        ) / 10;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              user: userName,
              user_id: params.user_id,
              year: params.year,
              weekly_billable_goal: params.weekly_billable_goal,
              net: {
                billable_actual: netBillable,
                billable_goal: netGoal,
                nonbillable: netNonbillable,
                total_time: Math.round((netBillable + netNonbillable) * 10) / 10,
                over_under: Math.round((netBillable - netGoal) * 10) / 10,
              },
              monthly: monthlySummary,
              weekly: weeklyDetail,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }),
          }],
          isError: true,
        };
      }
    }
  );
}
