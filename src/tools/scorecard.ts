import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";

// --- Firm roster: initials → Clio user ID ---
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

// --- Helpers ---
function getWeekRange(dateStr: string): { start: string; end: string; label: string } {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (dt: Date) => dt.toISOString().split("T")[0];
  const label = `${monday.toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${sunday.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  return { start: fmt(monday), end: fmt(sunday), label };
}

function getMonthRange(dateStr: string): { start: string; end: string; label: string } {
  const d = new Date(dateStr + "T12:00:00");
  const year = d.getFullYear();
  const month = d.getMonth();
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0);
  const fmt = (dt: Date) => dt.toISOString().split("T")[0];
  const label = start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return { start: fmt(start), end: fmt(end), label };
}

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
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (dt: Date) => `${dt.getMonth() + 1}/${dt.getDate()}`;
  return `${fmt(monday)}-${fmt(sunday)}`;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }

export function registerScorecardTools(server: McpServer): void {

  // ============================================================
  // TOOL 1: generate_firm_scorecard (firm-wide, for development meetings)
  // ============================================================
  server.tool(
    "generate_firm_scorecard",
    "Generate the firm-wide scorecard for a development meeting. Returns weekly and monthly billable/nonbillable data for all timekeepers, plus potential calls, collections, and case counts.",
    {
      week_of: z.string().optional().describe("Date within the target week (YYYY-MM-DD). Defaults to today."),
      include_monthly: z.boolean().optional().default(true).describe("Include monthly summary section (default true)"),
    },
    async (params) => {
      try {
        const targetDate = params.week_of ?? new Date().toISOString().split("T")[0];
        const week = getWeekRange(targetDate);
        const month = getMonthRange(targetDate);

        // --- Fetch all time entries for the week (all users at once) ---
        const weekTimeEntries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          fields: "id,date,quantity,rounded_quantity,price,billed,user{id,name}",
          created_since: `${week.start}T00:00:00+00:00`,
        }).then(entries => entries.filter((e: any) => e.date >= week.start && e.date <= week.end));

        // --- Fetch calendar entries for potential calls (week) ---
        let weekCalendarEntries: any[] = [];
        try {
          weekCalendarEntries = await fetchAllPages<any>("/calendar_entries", {
            fields: "id,summary,start_at,attendee{id,name}",
            from: week.start,
            to: week.end,
          });
        } catch { /* calendar endpoint may not be available */ }

        // --- Build weekly data per user ---
        const weeklyData: Record<number, { billable: number; nonbillable: number; potential_calls: number }> = {};
        for (const r of ROSTER) {
          weeklyData[r.user_id] = { billable: 0, nonbillable: 0, potential_calls: 0 };
        }

        for (const e of weekTimeEntries) {
          const uid = e.user?.id;
          if (!uid || !weeklyData[uid]) continue;
          const hours = (e.rounded_quantity || e.quantity) / 3600;
          if ((e.price || 0) > 0) {
            weeklyData[uid].billable += hours;
          } else {
            weeklyData[uid].nonbillable += hours;
          }
        }

        // Count calendar entries with "Potential" in title per user
        for (const cal of weekCalendarEntries) {
          const title = (cal.summary || "").toLowerCase();
          if (!title.includes("potential")) continue;
          const attendeeId = cal.attendee?.id;
          if (attendeeId && weeklyData[attendeeId]) {
            weeklyData[attendeeId].potential_calls++;
          }
        }

        // --- Monthly data (if requested) ---
        let monthlySection: any = null;
        if (params.include_monthly) {
          // Fetch month time entries
          const monthTimeEntries = await fetchAllPages<any>("/activities", {
            type: "TimeEntry",
            fields: "id,date,quantity,rounded_quantity,price,billed,user{id,name},matter{id,display_number}",
            created_since: `${month.start}T00:00:00+00:00`,
          }).then(entries => entries.filter((e: any) => e.date >= month.start && e.date <= month.end));

          // Fetch calendar entries for month
          let monthCalendarEntries: any[] = [];
          try {
            monthCalendarEntries = await fetchAllPages<any>("/calendar_entries", {
              fields: "id,summary,start_at,attendee{id,name}",
              from: month.start,
              to: month.end,
            });
          } catch { /* */ }

          // Fetch paid bills for collections
          let paidBills: any[] = [];
          try {
            paidBills = await fetchAllPages<any>("/bills", {
              fields: "id,issued_at,total,balance,state,matters",
              state: "paid",
              created_since: `${month.start}T00:00:00+00:00`,
            });
            paidBills = paidBills.filter((b: any) => b.issued_at >= month.start && b.issued_at <= month.end);
          } catch { /* */ }

          // Fetch draft bills
          let draftBills: any[] = [];
          try {
            draftBills = await fetchAllPages<any>("/bills", {
              fields: "id,issued_at,total,state,matters",
              state: "draft",
              created_since: `${month.start}T00:00:00+00:00`,
            });
          } catch { /* */ }

          // Fetch open matters for case counts per responsible attorney
          let openMatters: any[] = [];
          try {
            openMatters = await fetchAllPages<any>("/matters", {
              fields: "id,status,open_date,responsible_attorney{id}",
              status: "open",
            });
          } catch { /* */ }

          // Build monthly data per user
          const monthlyData: Record<number, {
            billable_dollars: number; billed_hours: number; draft_hours: number;
            not_billed_hours: number; nonbillable_hours: number;
            collections: number; potential_calls: number;
            cases_opened: number; cases_closed: number; total_open_cases: number;
          }> = {};

          for (const r of ROSTER) {
            monthlyData[r.user_id] = {
              billable_dollars: 0, billed_hours: 0, draft_hours: 0,
              not_billed_hours: 0, nonbillable_hours: 0,
              collections: 0, potential_calls: 0,
              cases_opened: 0, cases_closed: 0, total_open_cases: 0,
            };
          }

          // Time entries → billable $, billed/not-billed hours, nonbillable
          for (const e of monthTimeEntries) {
            const uid = e.user?.id;
            if (!uid || !monthlyData[uid]) continue;
            const hours = (e.rounded_quantity || e.quantity) / 3600;
            const value = hours * (e.price || 0);

            if ((e.price || 0) > 0) {
              monthlyData[uid].billable_dollars += value;
              if (e.billed) {
                monthlyData[uid].billed_hours += hours;
              } else {
                monthlyData[uid].not_billed_hours += hours;
              }
            } else {
              monthlyData[uid].nonbillable_hours += hours;
            }
          }

          // Collections from paid bills (attribute to first matter's responsible attorney)
          for (const b of paidBills) {
            const collected = (b.total || 0) - (b.balance || 0);
            // Bills don't directly link to users; we'll add to firm total
            // TODO: attribute to responsible attorney if matter data includes it
          }

          // Calendar → potential calls (month)
          for (const cal of monthCalendarEntries) {
            const title = (cal.summary || "").toLowerCase();
            if (!title.includes("potential")) continue;
            const attendeeId = cal.attendee?.id;
            if (attendeeId && monthlyData[attendeeId]) {
              monthlyData[attendeeId].potential_calls++;
            }
          }

          // Open matters per responsible attorney
          for (const m of openMatters) {
            const raId = m.responsible_attorney?.id;
            if (raId && monthlyData[raId]) {
              monthlyData[raId].total_open_cases++;
            }
            // Cases opened this month
            if (m.open_date && m.open_date >= month.start && m.open_date <= month.end) {
              if (raId && monthlyData[raId]) {
                monthlyData[raId].cases_opened++;
              }
            }
          }

          monthlySection = {
            period: month.label,
            date_range: { start: month.start, end: month.end },
            users: ROSTER.map(r => {
              const d = monthlyData[r.user_id];
              const totalHours = round1(d.billed_hours + d.draft_hours + d.not_billed_hours + d.nonbillable_hours);
              return {
                initials: r.initials,
                name: r.name,
                billable_dollars: round2(d.billable_dollars),
                billable_billed: round1(d.billed_hours),
                billable_draft: round1(d.draft_hours),
                billable_not_billed: round1(d.not_billed_hours),
                nonbillable: round1(d.nonbillable_hours),
                total: totalHours,
                collections: round2(d.collections),
                potential_calls: d.potential_calls,
                cases_opened: d.cases_opened,
                cases_closed: d.cases_closed,
                total_open_cases: d.total_open_cases,
              };
            }),
          };
        }

        // --- Build response ---
        const weeklySection = {
          period: week.label,
          date_range: { start: week.start, end: week.end },
          users: ROSTER.map(r => {
            const d = weeklyData[r.user_id];
            return {
              initials: r.initials,
              name: r.name,
              billable: round1(d.billable),
              nonbillable: round1(d.nonbillable),
              total: round1(d.billable + d.nonbillable),
              potential_calls: d.potential_calls,
            };
          }),
        };

        const result: any = { weekly: weeklySection };
        if (monthlySection) result.monthly = monthlySection;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
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

  // ============================================================
  // TOOL 2: generate_weekly_goals (individual goal sheets for TBS, Kaz, etc.)
  // ============================================================
  server.tool(
    "generate_weekly_goals",
    "Generate an individual weekly goals sheet for a timekeeper. Returns monthly and weekly billable/nonbillable hour breakdowns with goals and over/under tracking.",
    {
      user_id: z.coerce.number().describe("User/timekeeper ID"),
      year: z.coerce.number().describe("Year (e.g. 2026)"),
      weekly_billable_goal: z.coerce.number().describe("Weekly billable hours goal (e.g. 30 for TBS, 28 for Kaz)"),
      hours_per_day: z.coerce.number().optional().default(8).describe("Hours in a work day (default 8)"),
    },
    async (params) => {
      try {
        const startDate = `${params.year}-01-01`;
        const today = new Date();
        const endDate = today.toISOString().split("T")[0];

        const rawEntries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          fields: "id,date,quantity,rounded_quantity,price,billed,user{id,name}",
          user_id: params.user_id,
          created_since: `${startDate}T00:00:00+00:00`,
        });
        const entries = rawEntries.filter((e: any) => e.date >= startDate && e.date <= endDate);
        const userName = entries[0]?.user?.name ?? "Unknown";

        const months: Record<string, { billable: number; nonbillable: number }> = {};
        const weeks: Record<string, { billable: number; nonbillable: number }> = {};

        for (const e of entries) {
          const hours = (e.rounded_quantity || e.quantity) / 3600;
          const monthKey = e.date.slice(0, 7);
          const weekKey = getWeekKey(e.date);
          if (!months[monthKey]) months[monthKey] = { billable: 0, nonbillable: 0 };
          if (!weeks[weekKey]) weeks[weekKey] = { billable: 0, nonbillable: 0 };

          if ((e.price || 0) > 0) {
            months[monthKey].billable += hours;
            weeks[weekKey].billable += hours;
          } else {
            months[monthKey].nonbillable += hours;
            weeks[weekKey].nonbillable += hours;
          }
        }

        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const monthlySummary = [];
        let cumBillable = 0, cumGoal = 0;

        // Flat monthly goal: 1880 available hrs/yr × 80% utilization = 1504 ÷ 12 = 125/mo
        const ANNUAL_AVAILABLE_HOURS = 1880;
        const UTILIZATION_RATE = 0.80;
        const flatMonthlyGoal = Math.round(ANNUAL_AVAILABLE_HOURS * UTILIZATION_RATE / 12); // 125
        const flatMonthlyAvailable = Math.round(ANNUAL_AVAILABLE_HOURS / 12); // 157

        for (let m = 1; m <= 12; m++) {
          const key = `${params.year}-${String(m).padStart(2, "0")}`;
          const data = months[key];
          if (!data) continue;
          const billable = round1(data.billable);
          const nonbillable = round1(data.nonbillable);
          cumBillable += billable;
          cumGoal += flatMonthlyGoal;
          monthlySummary.push({
            month: monthNames[m - 1],
            billable_actual: billable,
            billable_goal: flatMonthlyGoal,
            nonbillable,
            total_time: round1(billable + nonbillable),
            over_under: round1(billable - flatMonthlyGoal),
            total_available_time: flatMonthlyAvailable,
            utilization_rate: round1((billable / flatMonthlyAvailable) * 100),
          });
        }

        const weeklyDetail = Object.entries(weeks)
          .map(([week, data]) => ({
            week,
            billable: round1(data.billable),
            nonbillable: round1(data.nonbillable),
            total_tracked: round1(data.billable + data.nonbillable),
            billable_goal: params.weekly_billable_goal,
            over_under: round1(data.billable - params.weekly_billable_goal),
          }))
          .sort((a, b) => {
            const parseWeek = (w: string) => {
              const parts = w.split("-")[0].split("/");
              return new Date(params.year, parseInt(parts[0]) - 1, parseInt(parts[1]));
            };
            return parseWeek(a.week).getTime() - parseWeek(b.week).getTime();
          });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              user: userName,
              user_id: params.user_id,
              year: params.year,
              weekly_billable_goal: params.weekly_billable_goal,
              net: {
                billable_actual: round1(cumBillable),
                billable_goal: round1(cumGoal),
                nonbillable: round1(monthlySummary.reduce((s, m) => s + m.nonbillable, 0)),
                total_time: round1(cumBillable + monthlySummary.reduce((s, m) => s + m.nonbillable, 0)),
                over_under: round1(cumBillable - cumGoal),
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
