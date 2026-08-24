import { z } from "zod/v4";
import { SCORECARD_ROSTER, MONTH_NAMES_SHORT } from "../domain/roster";
import { round2, round1 } from "../utils/num";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";
import {
  classifyYtdTimeEntries, addToTotals, emptyTotals, type HoursTotals,
} from "../dashboard/classifiedHours";
import {
  ATTENDEE_FIELDS,
  fetchCalendarIdToUserId,
  resolveAttendeeUserIds,
} from "../clio/calendarIdentity";

// --- Firm roster: initials → Clio user ID ---
const ROSTER = SCORECARD_ROSTER;

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


export function registerScorecardTools(server: McpServer): void {


  // ============================================================
  // TOOL 2: generate_weekly_goals (individual goal sheets for TBS, Kaz, etc.)
  // ============================================================
  server.tool(
    "generate_weekly_goals",
    "Generate an individual weekly goals sheet for a timekeeper. Returns monthly and weekly billable/nonbillable hour breakdowns with goals and over/under tracking. " +
    "BILLABLE CLASSIFICATION NOW CONSULTS THE MATTER'S CLIENT AND THE ENTRY'S RATE, not just the Clio non-billable flag. An entry is nonbillable when its native non_billable flag is set, OR — when exclude_internal is true (the DEFAULT) — when either (a) the matter's client is the firm itself, Romano & Sumner, LLC (the structural signal: catches 02888-Admin, 00050-Potential Clients and any future internal matter automatically), or (b) the entry is billable-flagged but carries rate 0 AND amount 0 (the rate-based safety net for internal time booked under another client). " +
    "Reclassified hours MOVE to nonbillable rather than disappearing, so total tracked time is identical on both bases. Synthetic fee-placeholder entries are still dropped from both buckets. " +
    "Every level (weekly, monthly, net) reports billable_actual — the ADJUSTED figure, which over_under and utilization_rate are computed from — alongside billable_actual_raw (the legacy flag-only value) and internal_reclassified (the difference, broken out by rule). " +
    "The firm dashboard (26 Compare col I and the Utilization tab it feeds) uses this same adjusted basis, so utilization still reconciles to it; billable_actual_raw ties to the pre-adjustment col I. Pass exclude_internal=false for legacy behavior, where billable_actual == billable_actual_raw.",
    {
      user_id: z.coerce.number().describe("User/timekeeper ID"),
      year: z.coerce.number().describe("Year (e.g. 2026)"),
      weekly_billable_goal: z.coerce.number().describe("Weekly billable hours goal (30 for partners/paras, 32 for associates). Monthly goal is derived as weekly × 47 ÷ 12 to match the dashboard."),
      hours_per_day: z.coerce.number().optional().default(8).describe("Hours in a work day (default 8)"),
      exclude_internal: z.boolean().optional().default(true).describe("Reclassify firm-internal time as nonbillable when computing billable_actual: matters whose client is the firm itself, plus billable-flagged entries with rate 0 AND amount 0. Default true. Set false for the legacy flag-only basis, where billable_actual == billable_actual_raw."),
    },
    async (params) => {
      try {
        const today = new Date();
        const endDate = today.toISOString().split("T")[0];

        // Same dashboard filtration as the Excel weekly sheets and 26 Compare
        // (see dashboard/classifiedHours.ts): the non_billable flag plus the
        // firm-internal reclassification, fee placeholders dropped. Each bucket
        // carries BOTH bases so billable_actual_raw needs no second pass.
        const entries = await classifyYtdTimeEntries({
          year: params.year, endDate, userIds: [params.user_id],
          excludeInternal: params.exclude_internal,
        });
        const userName = entries[0]?.userName ?? "Unknown";

        const months: Record<string, HoursTotals> = {};
        const weeks: Record<string, HoursTotals> = {};

        for (const e of entries) {
          if (e.cls === "excluded") continue; // fee placeholders aren't real worked time
          const monthKey = e.date.slice(0, 7);
          const weekKey = getWeekKey(e.date);
          addToTotals(months[monthKey] ??= emptyTotals(), e);
          addToTotals(weeks[weekKey] ??= emptyTotals(), e);
        }

        const monthNames = MONTH_NAMES_SHORT;
        const monthlySummary = [];
        let cumBillable = 0, cumBillableRaw = 0, cumGoal = 0;
        let cumInternal = 0, cumFirmSelf = 0, cumZeroValue = 0, cumFirmSelfRated = 0;

        // Monthly billable goal is derived from the weekly goal so it matches the dashboard:
        // 47 working weeks/yr ÷ 12 months. 30/wk → 1410/yr → 117.5/mo (partners & paras),
        // 32/wk → 1504/yr → 125.33/mo (associates).
        const WORKING_WEEKS_PER_YEAR = 47;
        const ANNUAL_AVAILABLE_HOURS = 1880;
        const flatMonthlyGoal = round1(params.weekly_billable_goal * WORKING_WEEKS_PER_YEAR / 12);
        const flatMonthlyAvailable = Math.round(ANNUAL_AVAILABLE_HOURS / 12); // 157

        for (let m = 1; m <= 12; m++) {
          const key = `${params.year}-${String(m).padStart(2, "0")}`;
          const data = months[key];
          if (!data) continue;
          const billable = round1(data.billable);
          const billableRaw = round1(data.billableRaw);
          const nonbillable = round1(data.nonbillable);
          cumBillable += billable;
          cumBillableRaw += billableRaw;
          cumInternal += data.internalHours;
          cumFirmSelf += data.firmSelfClientHours;
          cumZeroValue += data.zeroValueHours;
          cumFirmSelfRated += data.firmSelfClientRatedHours;
          cumGoal += flatMonthlyGoal;
          monthlySummary.push({
            month: monthNames[m - 1],
            // ADJUSTED — over_under and utilization_rate derive from this.
            billable_actual: billable,
            // Legacy flag-only figure, unchanged; ties to pre-adjustment col I.
            billable_actual_raw: billableRaw,
            internal_reclassified: round1(data.internalHours),
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
            billable_raw: round1(data.billableRaw),
            internal_reclassified: round1(data.internalHours),
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
              exclude_internal: params.exclude_internal,
              basis: params.exclude_internal
                ? "billable_actual EXCLUDES firm-internal time (firm-self-client matters + billable-flagged entries with rate 0 and amount 0), which is reclassified as nonbillable; billable_actual_raw is the legacy flag-only figure"
                : "legacy flag-only basis — billable_actual == billable_actual_raw",
              net: {
                billable_actual: round1(cumBillable),
                billable_actual_raw: round1(cumBillableRaw),
                internal_reclassified: round1(cumInternal),
                internal_firm_self_client: round1(cumFirmSelf),
                internal_zero_rate_and_amount: round1(cumZeroValue),
                // Firm-self-client hours that carried a RATE. Internal time is
                // normally $0, so a material figure here means rule (a) caught
                // real client work filed under the firm's own client (e.g.
                // 02671-Anike, 01537-Mediation Services) — review before relying
                // on the adjusted figure. See dashboard/classifiedHours.ts.
                internal_firm_self_client_rated: round1(cumFirmSelfRated),
                billable_goal: round1(cumGoal),
                nonbillable: round1(monthlySummary.reduce((s, m) => s + m.nonbillable, 0)),
                total_time: round1(cumBillable + monthlySummary.reduce((s, m) => s + m.nonbillable, 0)),
                over_under: round1(cumBillable - cumGoal),
                over_under_raw: round1(cumBillableRaw - cumGoal),
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


/**
 * ARCHIVED 2026-08-24 — generate_firm_scorecard is no longer registered on the
 * MCP surface. The firm scorecard is archival.
 *
 * Note it never migrated to the shared classifier: both its weekly and monthly
 * sections still split billable vs nonbillable with the pre-2026-07-09
 * `price > 0` heuristic (an entry counts as billable iff its rate is above
 * zero), which is a THIRD basis reconciling to neither 26 Compare col I nor the
 * weekly goal sheets. e163235 deferred that migration and it was never picked
 * up. That is also why this tool was not given the exclude_internal treatment:
 * under `price > 0`, $0 firm-internal time already landed in nonbillable, so it
 * never carried the bug the adjustment fixes — it carried the mirror-image one
 * (#186: rated time flagged non-billable leaking into billable).
 *
 * The source is retained verbatim (unwired) for reference. To re-expose it,
 * call this from registerScorecardTools — but migrate it onto
 * classifiedHours.ts first, or it will report a basis nothing else uses.
 */
export function registerArchivedFirmScorecardTool(server: McpServer): void {
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
        // `attendees` is PLURAL. This asked for a singular `attendee{id,name}`,
        // which is not a field in Clio's schema, so Clio rejected the whole
        // request — and the bare `catch` below swallowed it, leaving
        // potential_calls at 0 for every timekeeper, every week, silently.
        // Failures are now recorded in `warnings` so a zero means zero
        // instead of meaning "this never worked".
        const warnings: string[] = [];
        let weekCalendarEntries: any[] = [];
        try {
          weekCalendarEntries = await fetchAllPages<any>("/calendar_entries", {
            fields: `id,summary,start_at,${ATTENDEE_FIELDS}`,
            from: week.start,
            to: week.end,
          });
        } catch (e: any) {
          warnings.push(`Weekly potential_calls unavailable — /calendar_entries fetch failed: ${e?.message ?? e}`);
        }

        // Attendee ids are CALENDAR ids, but this scorecard is keyed by Clio
        // USER id, so the two have to be mapped before counting. Comparing
        // them directly (as this code used to) matches nothing.
        let calendarIdToUserId = new Map<number, number>();
        try {
          calendarIdToUserId = await fetchCalendarIdToUserId();
        } catch (e: any) {
          warnings.push(`potential_calls may undercount — /calendars lookup failed, so attendee calendars could not be resolved to users: ${e?.message ?? e}`);
        }

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
          // Credit every roster attendee on the event, not just one — an
          // entry's attendees are a list, and a call can involve two people.
          for (const userId of resolveAttendeeUserIds(cal, calendarIdToUserId)) {
            if (weeklyData[userId]) weeklyData[userId].potential_calls++;
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
              fields: `id,summary,start_at,${ATTENDEE_FIELDS}`,
              from: month.start,
              to: month.end,
            });
          } catch (e: any) {
            warnings.push(`Monthly potential_calls unavailable — /calendar_entries fetch failed: ${e?.message ?? e}`);
          }

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
            for (const userId of resolveAttendeeUserIds(cal, calendarIdToUserId)) {
              if (monthlyData[userId]) monthlyData[userId].potential_calls++;
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
        // Surface partial-data failures instead of reporting a confident 0.
        if (warnings.length > 0) result.warnings = warnings;

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
}
