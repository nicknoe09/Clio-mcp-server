// ============================================================
// Dashboard collections builder (extracted from download_dashboard_update).
// Pure data assembly — no workbook mutation — so it's unit-testable and lives in
// the CI-typechecked lib layer.
// ============================================================
import { genFeeAllocationByMonth, matchRosterUser, matchRosterResponsible } from "../clio/reportCsv";
import type { RosterMember } from "../domain/roster";

export type MonthlyCollections = {
  // month (1-12) -> user_id -> collected $ (individual, by working timekeeper → col N)
  indivByMonth: Record<number, Record<number, number>>;
  // month (1-12) -> responsible-attorney user_id -> collected $ (→ col S)
  respByMonth: Record<number, Record<number, number>>;
  // firm-wide YTD total collected (reconciliation signal)
  firmYtd: number;
};

const collNum = (x: string | undefined) => parseFloat((x ?? "0").replace(/[$,()]/g, "")) || 0;

/**
 * Build per-month collections on the PAYMENT-RECEIVED basis: one payment-filtered
 * Fee Allocation report per month (Jan..month) = money actually received that
 * month, allocated by working timekeeper (col N individual) and Responsible
 * Attorney (col S). Captures payments on prior-year invoices and reconciles to
 * Clio's Revenue Report; each report's period is guarded inside
 * genFeeAllocationByMonth (assertReportPeriod), so a wrong-period report aborts.
 */
export async function buildMonthlyCollections(
  year: number,
  month: number,
  roster: RosterMember[],
): Promise<MonthlyCollections> {
  const indivByMonth: Record<number, Record<number, number>> = {};
  const respByMonth: Record<number, Record<number, number>> = {};
  let firmYtd = 0;
  for (let m = 1; m <= month; m++) {
    let feeRows: Record<string, string>[] = [];
    try { feeRows = await genFeeAllocationByMonth(year, m); }
    catch (e: any) { console.warn(`[Dashboard] payment-filtered fee allocation failed for ${year}-${String(m).padStart(2, "0")}: ${e?.message ?? e}`); }
    for (const r of feeRows) {
      const collected = collNum(r["Total Funds Collected"]);
      if (!collected) continue;
      firmYtd += collected;
      const uid = matchRosterUser(r["User"] || "", roster);
      if (uid != null) { const slot = (indivByMonth[m] ??= {}); slot[uid] = (slot[uid] ?? 0) + collected; }
      const rid = matchRosterResponsible(r["Responsible Attorney"] || "", roster);
      if (rid != null) { const slot = (respByMonth[m] ??= {}); slot[rid] = (slot[rid] ?? 0) + collected; }
    }
  }
  return { indivByMonth, respByMonth, firmYtd };
}
