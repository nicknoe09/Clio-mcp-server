// ============================================================
// Worked billable-hours builder for 26 Compare "Billable Hours" (col I).
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
// Real worked time on contingency/flat-fee matters IS included here (the reference
// includes it — e.g. PAR's 48.4h on the Teachworth contingency matter are in his
// 250.0). Only Rachel's synthetic 1-hour fee-placeholder entries are backed out, and
// that happens separately via buildExcludedHoursByMonth (see excludedHours.ts).
// ============================================================
import { fetchAllPages } from "../clio/pagination";
import type { RosterMember } from "../domain/roster";

// month (1-12) -> user_id -> hours worked that month (activity/work date)
export type WorkedHoursByMonth = Record<number, Record<number, number>>;

// Two parallel views from a single /activities pull:
//   total    = ALL worked time entries (billable + nonbillable), by work date — the
//              figure a manual Activities search / get_user_productivity shows.
//   billable = entries where the entry-level non_billable flag !== true (the LEGACY,
//              flag-based view). Kept only as a reconciliation signal: col I is now
//              DERIVED as total − admin-category nonbillable (see documents.ts), which
//              is robust to admin time that was logged without the non_billable flag.
export type WorkedHoursSplit = { total: WorkedHoursByMonth; billable: WorkedHoursByMonth };

/**
 * Worked hours by month×user for months 1..`month`, summed from /activities TimeEntry
 * rows by their work date (rounded_quantity, the billed-increment hours). One pull per
 * roster member (scoped by user_id). Returns BOTH the total (all entries) and the
 * legacy flag-based billable split in a single pass, so the dashboard can derive
 * billable from total AND cross-check against the flag without a second round-trip.
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
      if (a.non_billable !== true) {
        (billable[m] ??= {})[r.user_id] = (billable[m][r.user_id] ?? 0) + hrs;
      }
    }
  }
  return { total, billable };
}

/**
 * The firm's hours partition for the 26 Compare dashboard: Billable (col I) is DERIVED
 * as Total worked (col J) − Nonbillable admin categories (col H), clamped at 0. Deriving
 * it (rather than running a second flag-based query) guarantees col I + col H == col J ==
 * the work-date total a manual Activities search shows, and makes col I immune to admin
 * time logged without the non_billable flag (which otherwise gets counted as both
 * billable and nonbillable). `clamped` flags the impossible case (nonbillable > total).
 */
export function deriveHoursPartition(
  totalWorked: number,
  nonbillable: number,
): { billable: number; total: number; clamped: boolean } {
  return {
    billable: Math.max(0, totalWorked - nonbillable),
    total: totalWorked,
    clamped: nonbillable > totalWorked,
  };
}

/**
 * Legacy flag-based billable-hours view (entries where non_billable !== true).
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
