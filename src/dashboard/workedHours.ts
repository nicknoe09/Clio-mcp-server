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

// month (1-12) -> user_id -> billable hours worked that month (activity/work date)
export type WorkedHoursByMonth = Record<number, Record<number, number>>;

/**
 * Billable hours worked by month×user for months 1..`month`, summed from /activities
 * TimeEntry rows by their work date (rounded_quantity, the billed-increment hours).
 * One pull per roster member (scoped by user_id), counting only billable entries
 * (non_billable !== true) — admin/nonbillable time is excluded by that flag.
 */
export async function buildWorkedBillableHoursByMonth(
  year: number,
  month: number,
  roster: RosterMember[],
  opts: { months?: number[] } = {},
): Promise<WorkedHoursByMonth> {
  const months = new Set(opts.months ?? Array.from({ length: month }, (_, i) => i + 1));
  const maxMonth = Math.max(...months);
  const monthEnd = `${year}-${String(maxMonth).padStart(2, "0")}-${String(new Date(year, maxMonth, 0).getDate()).padStart(2, "0")}`;

  const out: WorkedHoursByMonth = {};
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
      console.warn(`[Dashboard] worked-billable-hours pull failed for ${r.initials}: ${e?.message ?? e}`);
      continue;
    }
    for (const a of acts) {
      if (a.non_billable === true) continue; // billable worked time only (admin matters are non_billable)
      if (a.date < `${year}-01-01` || a.date > monthEnd) continue;
      const m = parseInt(String(a.date).slice(5, 7), 10);
      if (!m || !months.has(m)) continue;
      const slot = (out[m] ??= {});
      slot[r.user_id] = (slot[r.user_id] ?? 0) + (a.rounded_quantity ?? a.quantity ?? 0) / 3600;
    }
  }
  return out;
}
