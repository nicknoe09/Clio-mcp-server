// ============================================================
// Billed builder (INVOICE ISSUE DATE basis) for one 26 Compare column:
//   - Billed $ (col K): time that appeared on a bill ISSUED that month ("Billed Time")
// Comes from a per-month Fee Allocation report (filter_by_payment=false, so the date
// range filters by invoice issue date), so col K stays static once the month's bills
// are out.
//
// NOTE: Billable Hours (col I) is NOT built here. Per the firm's definition it is ALL
// billable hours WORKED in the month (activity/work-date basis, billed or not) minus
// only Rachel's synthetic 1-hour contingency/flat fee-placeholder entries — built from
// the Revenue Report worked hours less buildExcludedHoursByMonth in documents.ts. The
// earlier design sourced col I from this report's issue-date "Billed Hours", which made
// it track billed-$ movements and run low on unbilled WIP; that path was removed.
//
// Billing-month rule (firm-specific): a billing run straddles month-end — bills are
// sometimes issued in the last day or two of a month rather than the 1st of the
// next. So bills issued on days 1..cutoffDay of a month roll back into the PRIOR
// month (e.g. with cutoffDay=7, May 27 → Jun 7 all count as May). Days after the
// cutoff stay in their calendar month. Pull a window that runs through the first
// cutoffDay days of the month AFTER the target so those late-issued bills are
// captured, then re-bucket by adjusted issue date.
// ============================================================
import { genFeeAllocationByMonth, matchRosterUser } from "../clio/reportCsv";
import type { RosterMember } from "../domain/roster";

export type MonthlyBilled = {
  // month (1-12) -> user_id -> billed $ (time billed on invoices issued in that billing month) → col K
  billedByMonth: Record<number, Record<number, number>>;
  // month -> firm-wide billed $ (all rows, incl. non-roster billers) for reconciliation/logging
  firmByMonth: Record<number, number>;
};

const num = (x: string | undefined) => parseFloat((x ?? "0").replace(/[$,()]/g, "")) || 0;

/**
 * Map a Fee Allocation "Issue Date" (MM/DD/YYYY) to the billing month it belongs to,
 * applying the cutoff-day roll-back. Returns a {year, month} or null if it falls
 * outside the reporting year (e.g. a Jan 1..cutoff bill that rolls back to prior-year
 * December).
 */
export function adjustedBillingMonth(issueDate: string, cutoffDay: number): { year: number; month: number } | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((issueDate || "").trim());
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const dd = parseInt(m[2], 10);
  let yyyy = parseInt(m[3], 10);
  let month = mm;
  if (dd <= cutoffDay) {
    month -= 1;             // roll back into the prior month's billing run
    if (month === 0) { month = 12; yyyy -= 1; } // ...which may be last December
  }
  return { year: yyyy, month };
}

/**
 * Per-month billed $ (issue-date basis) by working timekeeper for months 1..`month`.
 * One issue-date Fee Allocation pull covering [year-01-01 .. (month+1)/cutoffDay],
 * re-bucketed by adjusted issue date.
 */
export async function buildMonthlyBilled(
  year: number,
  month: number,
  roster: RosterMember[],
  opts: { cutoffDay?: number; months?: number[] } = {},
): Promise<MonthlyBilled> {
  const cutoffDay = opts.cutoffDay ?? 7;
  const months = (opts.months ?? Array.from({ length: month }, (_, i) => i + 1)).slice().sort((a, b) => a - b);
  const keep = new Set(months);
  const minMonth = months[0];
  const maxMonth = months[months.length - 1];
  const start = `${year}-${String(minMonth).padStart(2, "0")}-01`;
  // End the window `cutoffDay` days into the month AFTER the last requested month, so
  // bills issued early next month (that roll back into it) are included.
  const endDate = new Date(year, maxMonth, cutoffDay); // maxMonth is 1-based → Date month index = maxMonth = next month
  const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`;

  const billedByMonth: Record<number, Record<number, number>> = {};
  const firmByMonth: Record<number, number> = {};

  let rows: Record<string, string>[] = [];
  try {
    rows = await genFeeAllocationByMonth(year, month, { filterByPayment: false, startOverride: start, endOverride: end });
  } catch (e: any) {
    console.warn(`[Dashboard] issue-date fee allocation (billed) failed for ${start}..${end}: ${e?.message ?? e}`);
  }

  for (const r of rows) {
    const adj = adjustedBillingMonth(r["Issue Date"] || "", cutoffDay);
    if (!adj || adj.year !== year || !keep.has(adj.month)) continue;
    const uid = matchRosterUser(r["User"] || "", roster);
    const billed = num(r["Billed Time"]);
    if (billed) {
      firmByMonth[adj.month] = (firmByMonth[adj.month] ?? 0) + billed;
      if (uid != null) {
        const slot = (billedByMonth[adj.month] ??= {});
        slot[uid] = (slot[uid] ?? 0) + billed;
      }
    }
  }

  return { billedByMonth, firmByMonth };
}
