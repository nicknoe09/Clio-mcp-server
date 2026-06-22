// ============================================================
// Excluded-hours builder. Contingency and flat-fee matter time must NOT count as
// "hours worked" in the 26 Compare hour tracker (col I) or toward the paralegal
// hour bonus — Rachel bills contingency by hand-creating a static "one hour" entry
// per biller, and flat-fee time isn't hourly work. Their DOLLARS still count (billed
// $ / collections), so we only back the HOURS out of col I.
//
// This returns billable hours logged on contingency/flat-fee matters, by month×user,
// so the caller can subtract them from the Revenue Report's billable-hours figure.
// We count only BILLABLE entries (non_billable == false) because those are the ones
// that are in col I to begin with — subtracting non-billable time would over-net.
// ============================================================
import { fetchAllPages } from "../clio/pagination";

// month (1-12) -> user_id -> hours on contingency/flat-fee matters
export type ExcludedHoursByMonth = Record<number, Record<number, number>>;

/** A matter's billing_method counts as excluded when it is contingency or flat-fee. */
export function isExcludedBillingMethod(method: string | undefined | null): boolean {
  const m = String(method || "").toLowerCase();
  return m.includes("conting") || m.includes("flat") || m === "fixed";
}

/**
 * Billable hours on contingency/flat-fee matters by month×user, for months 1..`month`.
 * Mirrors buildNonbillableByMonth: resolve the excluded matter set from billing_method,
 * then sum TimeEntry hours dated within each month.
 */
export async function buildExcludedHoursByMonth(
  year: number,
  month: number,
  opts: { months?: number[] } = {},
): Promise<ExcludedHoursByMonth> {
  const months = new Set(opts.months ?? Array.from({ length: month }, (_, i) => i + 1));
  const maxMonth = Math.max(...months);
  const monthEnd = `${year}-${String(maxMonth).padStart(2, "0")}-${String(new Date(year, maxMonth, 0).getDate()).padStart(2, "0")}`;
  const allMatters = await fetchAllPages<any>("/matters", { fields: "id,display_number,billing_method" });

  const seenMethods: Record<string, number> = {};
  const excluded = new Set<number>();
  for (const mt of allMatters) {
    const method = mt.billing_method;
    seenMethods[String(method || "(none)")] = (seenMethods[String(method || "(none)")] ?? 0) + 1;
    if (isExcludedBillingMethod(method)) excluded.add(mt.id);
  }
  console.log(`[Dashboard] billing_method distribution: ${JSON.stringify(seenMethods)}; excluded (contingency/flat) matters=${excluded.size}`);

  const out: ExcludedHoursByMonth = {};
  for (const mid of excluded) {
    const acts = await fetchAllPages<any>("/activities", {
      type: "TimeEntry",
      fields: "id,date,quantity,rounded_quantity,non_billable,user{id}",
      matter_id: mid,
      created_since: `${year}-01-01T00:00:00+00:00`,
    });
    for (const a of acts) {
      if (a.non_billable === true) continue; // only entries that are in col I to begin with
      if (a.date < `${year}-01-01` || a.date > monthEnd) continue;
      const m = parseInt(String(a.date).slice(5, 7), 10);
      if (!m || !months.has(m)) continue;
      const uid = a.user?.id;
      if (!uid) continue;
      const slot = (out[m] ??= {});
      slot[uid] = (slot[uid] ?? 0) + (a.rounded_quantity ?? a.quantity ?? 0) / 3600;
    }
  }
  return out;
}
