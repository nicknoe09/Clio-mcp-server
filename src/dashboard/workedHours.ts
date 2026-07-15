// ============================================================
// Worked-hours builder for 26 Compare "Billable Hours" (col I) / "TNB" (col H).
//
// Col I = ALL billable hours WORKED in the month, by activity/work date, billed or
// not — a TIME-ENTRY query (the firm's definition), NOT the Revenue Report's
// "Billed Hours + Unbilled Hours". The Revenue Report's Billed Hours is invoice/
// issue-date based, so it counts prior-month work billed this month and, added to
// current WIP, OVERCOUNTS hours actually worked in the month. Verified against the
// firm's reference dashboard for March 2026:
//   NRN: time-entry worked 210.6 ≈ reference 212.0   (Revenue Report said 262.6)
//   PAR: time-entry worked 250.4 ≈ reference 250.0   (Revenue Report said 291.2)
//
// Billable vs nonbillable is split STRICTLY by Clio's entry-level non_billable
// flag (isNonBillableEntry — the same single decision the weekly goal sheets
// use), never by matter name/type, practice area, or rate. Real worked time on
// contingency/flat-fee matters IS included in billable (the reference includes
// it — e.g. PAR's 48.4h on the Teachworth contingency matter are in his 250.0).
// Only Rachel's synthetic 1-hour fee-placeholder entries are backed out, and
// that happens separately via buildExcludedHoursByMonth (see excludedHours.ts).
// ============================================================
import { fetchAllPages } from "../clio/pagination";
import { isNonBillableEntry } from "./classifiedHours";
import type { RosterMember } from "../domain/roster";

// month (1-12) -> user_id -> hours worked that month (activity/work date)
export type WorkedHoursByMonth = Record<number, Record<number, number>>;

// Three parallel views from a single /activities pull, partitioned per entry by
// the non_billable flag (so billable + nonbillable == total by construction):
//   total       = ALL worked time entries, by work date — the figure a manual
//                 Activities search / get_user_productivity shows (col J basis).
//   billable    = entries where non_billable === false (col I basis, before the
//                 fee-placeholder exclusion is backed out).
//   nonbillable = entries where non_billable === true (col H).
export type WorkedHoursSplit = {
  total: WorkedHoursByMonth;
  billable: WorkedHoursByMonth;
  nonbillable: WorkedHoursByMonth;
};

/**
 * Worked hours by month×user for months 1..`month`, summed from /activities TimeEntry
 * rows by their work date (rounded_quantity, the billed-increment hours). One pull per
 * roster member (scoped by user_id). Returns the total plus the flag-based
 * billable/nonbillable partition in a single pass.
 */
export async function buildWorkedHoursSplitByMonth(
  year: number,
  month: number,
  roster: RosterMember[],
  opts: { months?: number[] } = {},
): Promise<WorkedHoursSplit> {
  const months = new Set(opts.months ?? Array.from({ length: month }, (_, i) => i + 1));
  const maxMonth = Math.max(...months);
  const monthEnd = `${year}-${String(maxMonth).padStart(2, "0")}-${String(new Date(year, maxMonth, 0).getDate()).padStart(2, "0")}`;

  const total: WorkedHoursByMonth = {};
  const billable: WorkedHoursByMonth = {};
  const nonbillable: WorkedHoursByMonth = {};
  for (const r of roster) {
    let acts: any[] = [];
    try {
      acts = await fetchAllPages<any>("/activities", {
        type: "TimeEntry",
        fields: "id,date,quantity,rounded_quantity,non_billable,user{id}",
        user_id: r.user_id,
        created_since: `${year}-01-01T00:00:00+00:00`,
      });
    } catch (e: any) {
      console.warn(`[Dashboard] worked-hours pull failed for ${r.initials}: ${e?.message ?? e}`);
      continue;
    }
    for (const a of acts) {
      if (a.date < `${year}-01-01` || a.date > monthEnd) continue;
      const m = parseInt(String(a.date).slice(5, 7), 10);
      if (!m || !months.has(m)) continue;
      const hrs = (a.rounded_quantity ?? a.quantity ?? 0) / 3600;
      (total[m] ??= {})[r.user_id] = (total[m][r.user_id] ?? 0) + hrs;
      const bucket = isNonBillableEntry(a.non_billable) ? nonbillable : billable;
      (bucket[m] ??= {})[r.user_id] = (bucket[m][r.user_id] ?? 0) + hrs;
    }
  }
  return { total, billable, nonbillable };
}

/**
 * Flag-based billable-hours view (entries where non_billable !== true).
 * Retained for backward compatibility; delegates to buildWorkedHoursSplitByMonth.
 */
export async function buildWorkedBillableHoursByMonth(
  year: number,
  month: number,
  roster: RosterMember[],
  opts: { months?: number[] } = {},
): Promise<WorkedHoursByMonth> {
  return (await buildWorkedHoursSplitByMonth(year, month, roster, opts)).billable;
}
