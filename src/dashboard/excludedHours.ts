// ============================================================
// Excluded-hours builder. The 26 Compare "Billable Hours" (col I) and the paralegal
// hour bonus count all billable hours WORKED — including real worked time on
// contingency/flat-fee matters. The ONLY thing that must be backed out is Rachel's
// synthetic fee placeholder: to get a contingency/flat fee onto an invoice she
// hand-creates a SINGLE one-hour time entry whose dollar value is the whole fee, so
// its per-hour rate does NOT match the timekeeper's standard hourly rate. Those
// placeholder hours aren't real worked time, so we subtract them from col I (their
// DOLLARS still count in billed $ / collections).
//
// IMPORTANT (corrected rule): we do NOT exclude all contingency/flat-fee time — only
// the 1.0h entries that don't correspond to the timekeeper's hourly rate. A
// timekeeper's standard rate is inferred from their own non-1h billable entries on
// these matters (the dump can't define the standard); when none exist to compare
// against, a 1.0h entry priced above FALLBACK_MAX_HOURLY_RATE is treated as a dump.
// Detection is scoped to contingency/flat-fee matters (where these placeholders live)
// to avoid catching a legitimate reduced-rate 1.0h entry on a normal hourly matter.
//
// Identifying contingency matters: Clio's `billing_method` field is UNRELIABLE — many
// real contingency matters are set to "hourly" in Clio (e.g. the Teachworth estate
// litigation). The firm marks them with a yes/no custom field named "Contingency"
// instead, so we key off that (isContingencyMatter). Flat-fee matters are still taken
// from billing_method (isExcludedBillingMethod), which is reliable for those.
// ============================================================
import { fetchAllPages } from "../clio/pagination";

// month (1-12) -> user_id -> placeholder (fee-dump) hours to back out of worked billable
export type ExcludedHoursByMonth = Record<number, Record<number, number>>;

/** A matter's billing_method counts as excluded when it is contingency or flat-fee. */
export function isExcludedBillingMethod(method: string | undefined | null): boolean {
  const m = String(method || "").toLowerCase();
  return m.includes("conting") || m.includes("flat") || m === "fixed";
}

/**
 * True when a matter's "Contingency" yes/no custom field is set. Clio returns
 * custom_field_values as an array of { value, custom_field:{ name } } (older shapes
 * expose field_name directly); we match the field by name "Contingency" (case-
 * insensitive) and read its truthy value. This is the firm's source of truth for
 * contingency status — NOT billing_method, which mislabels these matters "hourly".
 */
export function isContingencyMatter(matter: any): boolean {
  const cfvs = matter?.custom_field_values;
  if (!Array.isArray(cfvs)) return false;
  for (const cf of cfvs) {
    const name = String(cf?.custom_field?.name ?? cf?.field_name ?? cf?.name ?? "").toLowerCase().trim();
    if (name !== "contingency") continue;
    const v = cf?.value;
    if (v === true) return true;
    const s = String(v ?? "").toLowerCase().trim();
    return s === "true" || s === "yes" || s === "y" || s === "1" || s === "checked";
  }
  return false;
}

// A 1.0h entry whose rate exceeds this is treated as a fee placeholder even when the
// timekeeper's standard rate can't be inferred (no other billable entries to compare).
// Set well above any real hourly rate at the firm; a contingency/flat fee dumped onto a
// single hour sits far above it.
const FALLBACK_MAX_HOURLY_RATE = 1500;
const ONE_HOUR_TOLERANCE = 0.05;  // hours — "single hour" entry
const RATE_MATCH_TOLERANCE = 1;   // dollars — "corresponds to the hourly rate"

// One billable time entry on a contingency/flat-fee matter, reduced to the fields the
// fee-placeholder test needs. `rate` is the per-hour price; `hours` the duration.
export type ContingencyEntry = { uid: number; month: number; hours: number; rate: number };

/**
 * PURE detection of Rachel's synthetic fee placeholders among contingency/flat-fee
 * entries. A placeholder is a SINGLE one-hour entry whose rate doesn't correspond to
 * the timekeeper's standard hourly rate; everything else (multi-hour work, 1.0h work at
 * the standard rate) is real worked time and is NOT excluded. The standard rate is the
 * modal rate among that timekeeper's non-1h billable entries (so a dump can't define
 * the standard); when none exist, a 1.0h entry over FALLBACK_MAX_HOURLY_RATE is a dump.
 * Returns the placeholder HOURS to back out, by month×user.
 */
export function classifyFeePlaceholders(entries: ContingencyEntry[]): ExcludedHoursByMonth {
  const isOneHour = (h: number) => Math.abs(h - 1) < ONE_HOUR_TOLERANCE;

  // Per-user standard rate = modal rate among non-1h, positive-rate entries.
  const rateCounts: Record<number, Map<number, number>> = {};
  for (const e of entries) {
    if (isOneHour(e.hours) || e.rate <= 0) continue;
    const m = (rateCounts[e.uid] ??= new Map<number, number>());
    const bucket = Math.round(e.rate);
    m.set(bucket, (m.get(bucket) ?? 0) + 1);
  }
  const standardRate: Record<number, number> = {};
  for (const uid of Object.keys(rateCounts).map(Number)) {
    let best = 0, bestCount = -1;
    for (const [rate, count] of rateCounts[uid]) if (count > bestCount) { bestCount = count; best = rate; }
    standardRate[uid] = best;
  }

  const out: ExcludedHoursByMonth = {};
  for (const e of entries) {
    if (!isOneHour(e.hours)) continue;
    const std = standardRate[e.uid];
    const isDump = std ? Math.abs(e.rate - std) > RATE_MATCH_TOLERANCE : e.rate > FALLBACK_MAX_HOURLY_RATE;
    if (!isDump) continue;
    const slot = (out[e.month] ??= {});
    slot[e.uid] = (slot[e.uid] ?? 0) + e.hours;
  }
  return out;
}

/**
 * Fee-placeholder hours by month×user, for months 1..`month`. Resolve the
 * contingency/flat-fee matter set (contingency via the "Contingency" custom field,
 * flat via billing_method), pull their billable TimeEntries, infer each timekeeper's
 * standard rate, then sum ONLY the 1.0h entries whose rate doesn't match it (Rachel's
 * synthetic fee dumps).
 */
export async function buildExcludedHoursByMonth(
  year: number,
  month: number,
  opts: { months?: number[] } = {},
): Promise<ExcludedHoursByMonth> {
  const months = new Set(opts.months ?? Array.from({ length: month }, (_, i) => i + 1));
  const maxMonth = Math.max(...months);
  const monthEnd = `${year}-${String(maxMonth).padStart(2, "0")}-${String(new Date(year, maxMonth, 0).getDate()).padStart(2, "0")}`;
  const allMatters = await fetchAllPages<any>("/matters", {
    fields: "id,display_number,billing_method,custom_field_values{id,field_name,value,custom_field{id,name}}",
  });

  // Contingency from the "Contingency" custom field (reliable); flat-fee from
  // billing_method (reliable for flat). billing_method's "contingency" is NOT trusted.
  let byCustomField = 0, byBillingMethod = 0;
  const excluded = new Set<number>();
  for (const mt of allMatters) {
    const isContingency = isContingencyMatter(mt);
    const isFlat = isExcludedBillingMethod(mt.billing_method) && !String(mt.billing_method || "").toLowerCase().includes("conting");
    if (isContingency) byCustomField++;
    if (isFlat) byBillingMethod++;
    if (isContingency || isFlat) excluded.add(mt.id);
  }
  console.log(`[Dashboard] contingency/flat matters=${excluded.size} (contingency via custom field=${byCustomField}, flat via billing_method=${byBillingMethod})`);

  const hoursOf = (a: any) => (a.rounded_quantity ?? a.quantity ?? 0) / 3600;
  const rateOf = (a: any) => Number(a.price) || 0;

  // Collect billable entries on contingency/flat matters within the window, then let
  // the pure classifier decide which 1.0h entries are fee placeholders.
  const entries: ContingencyEntry[] = [];
  for (const mid of excluded) {
    const acts = await fetchAllPages<any>("/activities", {
      type: "TimeEntry",
      fields: "id,date,quantity,rounded_quantity,price,total,non_billable,user{id}",
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
      entries.push({ uid, month: m, hours: hoursOf(a), rate: rateOf(a) });
    }
  }

  const out = classifyFeePlaceholders(entries);
  const dumps = Object.values(out).reduce((s, byUser) => s + Object.keys(byUser).length, 0);
  console.log(`[Dashboard] contingency/flat fee-placeholder (1h off-rate) entries excluded from col I: ${dumps} user-months`);
  return out;
}
