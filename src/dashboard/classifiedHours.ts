// ============================================================
// Entry-level hours classifier — the SINGLE filtration shared by the monthly
// dashboard model and the on-tempo weekly goals sheets, so both report the same
// utilization numerator (billable ÷ 1880/12) and reconcile at month close.
//
// Billable vs nonbillable is decided ENTIRELY by Clio's native entry-level
// `non_billable` flag — never by matter name/number, matter type, practice
// area, or price/rate:
//   nonbillable — non_billable === true. Price is irrelevant: internal work
//                 booked at a dollar rate (e.g. a $525/hr RomSum admin entry)
//                 but flagged non-billable in Clio is nonbillable. (The old
//                 admin-matter/rate rules counted such entries billable.)
//   excluded    — one of Rachel's synthetic 1-hour fee-placeholder entries
//                 (off-standard-rate 1.0h BILLABLE-flagged entry on a fee-based
//                 matter, per the two-step rule in excludedHours.ts). Not real
//                 worked time: dropped from BOTH billable and nonbillable.
//                 This exclusion is the only consumer of the entry's rate and
//                 matter fields, and it only ever moves billable-flagged
//                 entries to "excluded" — it never flips billable/nonbillable.
//   billable    — everything else (non_billable === false), including
//                 zero-priced entries and contingency/flat-matter worked time.
// ============================================================
import { fetchAllPages, rawGetSingle } from "../clio/pagination";
import {
  standardRateByUser, isFeePlaceholderRate, matterQualifiesForStrip,
} from "./excludedHours";

export type EntryClass = "billable" | "nonbillable" | "excluded";

export type ClassifiedTimeEntry = {
  id: number;
  uid: number;
  userName: string;
  date: string;   // YYYY-MM-DD work date
  hours: number;  // rounded_quantity (billed-increment) hours
  cls: EntryClass;
};

// Raw shape the pure classifier consumes (one row per /activities TimeEntry).
// `rate` and `matterId` feed ONLY the fee-placeholder exclusion — never the
// billable-vs-nonbillable decision.
export type RawTimeEntry = {
  id: number;
  uid: number;
  userName: string;
  date: string;
  hours: number;
  rate: number;
  matterId?: number;
  nonBillableFlag: boolean;
};

/**
 * THE billable-vs-nonbillable decision, in one place: an entry is nonbillable
 * exactly when Clio's entry-level non_billable flag is true. Strict === true so
 * a missing/omitted field never silently flips an entry to nonbillable.
 */
export function isNonBillableEntry(nonBillableFlag: unknown): boolean {
  return nonBillableFlag === true;
}

/**
 * Pure classification, strictly from the entry's own non_billable flag:
 * flagged → nonbillable; identified placeholder → excluded; everything else →
 * billable. The flag wins over the placeholder set (placeholders are by
 * construction billable-flagged, so the overlap is theoretical — but a flagged
 * entry must never leave the nonbillable sum).
 */
export function classifyRawEntries(
  raw: RawTimeEntry[],
  excludedEntryIds: Set<number>,
): ClassifiedTimeEntry[] {
  return raw.map((e) => ({
    id: e.id, uid: e.uid, userName: e.userName, date: e.date, hours: e.hours,
    cls: isNonBillableEntry(e.nonBillableFlag) ? "nonbillable"
      : excludedEntryIds.has(e.id) ? "excluded"
      : "billable",
  }));
}

/**
 * Identify fee-placeholder ENTRY IDs among the raw entries — the entry-level
 * twin of buildExcludedHoursByMonth (same population: entries whose
 * non_billable flag isn't set; same rate test against the timekeeper's modal
 * standard rate; same matter gate; same fail-safe toward inclusion when a
 * matter lookup fails).
 */
export async function findPlaceholderEntryIds(raw: RawTimeEntry[]): Promise<Set<number>> {
  const pop = raw.filter((e) => !isNonBillableEntry(e.nonBillableFlag) && e.matterId !== undefined);
  const rateEntries = pop.map((e) => ({
    uid: e.uid, month: parseInt(e.date.slice(5, 7), 10) || 0, hours: e.hours, rate: e.rate,
  }));
  const std = standardRateByUser(rateEntries);
  const candidates = pop.filter((e) => isFeePlaceholderRate(e.hours, e.rate, std[e.uid]));
  const excluded = new Set<number>();
  const candidateMatterIds = [...new Set(candidates.map((c) => c.matterId as number))];
  for (const mid of candidateMatterIds) {
    try {
      const res = await rawGetSingle(`/matters/${mid}`, {
        fields: "id,practice_area{name},custom_field_values{field_name,value}",
      });
      const matter = (res as any)?.data ?? res;
      if (!matterQualifiesForStrip(matter)) continue;
      for (const c of candidates) if (c.matterId === mid) excluded.add(c.id);
    } catch (e: any) {
      console.warn(`[Goals] candidate matter ${mid} lookup failed (${e?.response?.status ?? e?.message ?? e}); NOT stripping its 1h entries (fail safe to inclusion)`);
    }
  }
  return excluded;
}

/**
 * Pull + classify a year's time entries for the given users (work dates
 * `year`-01-01 .. `endDate` inclusive). One /activities pull per user plus one
 * matter lookup per placeholder-candidate matter — the same query budget as
 * the dashboard's monthly builders.
 */
export async function classifyYtdTimeEntries(opts: {
  year: number;
  endDate: string;
  userIds: number[];
}): Promise<ClassifiedTimeEntry[]> {
  const startDate = `${opts.year}-01-01`;

  const raw: RawTimeEntry[] = [];
  for (const userId of opts.userIds) {
    let acts: any[] = [];
    try {
      acts = await fetchAllPages<any>("/activities", {
        type: "TimeEntry",
        fields: "id,date,quantity,rounded_quantity,price,non_billable,matter{id},user{id,name}",
        user_id: userId,
        created_since: `${startDate}T00:00:00+00:00`,
      });
    } catch (e: any) {
      console.warn(`[Goals] activity pull failed for user ${userId}: ${e?.message ?? e}`);
      continue;
    }
    for (const a of acts) {
      if (!a?.date || a.date < startDate || a.date > opts.endDate) continue;
      raw.push({
        id: a.id,
        uid: a.user?.id ?? userId,
        userName: a.user?.name ?? "Unknown",
        date: a.date,
        hours: (a.rounded_quantity ?? a.quantity ?? 0) / 3600,
        rate: Number(a.price) || 0,
        matterId: a.matter?.id,
        nonBillableFlag: a.non_billable === true,
      });
    }
  }

  const excludedIds = await findPlaceholderEntryIds(raw);
  return classifyRawEntries(raw, excludedIds);
}
