// ============================================================
// Entry-level hours classifier — the SINGLE filtration shared by the monthly
// dashboard model and the on-tempo weekly goals sheets, so both report the same
// utilization numerator (billable ÷ 1880/12) and reconcile at month close.
//
// Classification per time entry, matching 26 Compare's semantics exactly:
//   nonbillable — the entry is booked to one of the tracked admin matters
//                 (Biz Dev/Website, Potential Clients, CLE, Other Admin), the
//                 same matters buildNonbillableByMonth sums into col H. Price
//                 and the entry-level non_billable flag are irrelevant — a rated
//                 CLE entry is still nonbillable.
//   excluded    — one of Rachel's synthetic 1-hour fee-placeholder entries
//                 (off-standard-rate 1.0h entry on a fee-based matter, per the
//                 two-step matter-gated rule in excludedHours.ts). Not real
//                 worked time: dropped from BOTH billable and nonbillable.
//   billable    — everything else, INCLUDING real worked time on contingency /
//                 flat-fee matters and zero-priced entries on client matters
//                 (col I is derived as total − admin nonbillable, so a client-
//                 matter entry counts regardless of its price or flag).
//
// This deliberately replaces the weekly sheets' old price>0 heuristic, which
// over-counted (placeholders, rated admin time) and under-counted (zero-priced
// client work) relative to the dashboard.
// ============================================================
import { fetchAllPages, rawGetSingle } from "../clio/pagination";
import { CATEGORY_PREFIXES } from "./nonbillable";
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

/** IDs of the tracked admin matters (one /matters pull, matched by the same
 *  display-number prefixes buildNonbillableByMonth uses). */
export async function getAdminMatterIds(): Promise<Set<number>> {
  const allMatters = await fetchAllPages<any>("/matters", { fields: "id,display_number" });
  const prefixes = CATEGORY_PREFIXES.flatMap((c) => c.prefixes);
  const ids = new Set<number>();
  for (const mt of allMatters) {
    const dn = String(mt.display_number || "");
    if (prefixes.some((p) => dn.startsWith(p))) ids.add(mt.id);
  }
  return ids;
}

/**
 * Pure classification: admin matter → nonbillable; identified placeholder →
 * excluded; everything else → billable. Admin membership wins over the
 * placeholder set (an admin matter is never fee-based, so the overlap is
 * theoretical — but nonbillable is the safer bucket if it ever happens).
 */
export function classifyRawEntries(
  raw: RawTimeEntry[],
  adminMatterIds: Set<number>,
  excludedEntryIds: Set<number>,
): ClassifiedTimeEntry[] {
  return raw.map((e) => ({
    id: e.id, uid: e.uid, userName: e.userName, date: e.date, hours: e.hours,
    cls: e.matterId !== undefined && adminMatterIds.has(e.matterId) ? "nonbillable"
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
  const pop = raw.filter((e) => !e.nonBillableFlag && e.matterId !== undefined);
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
 * `year`-01-01 .. `endDate` inclusive). One /activities pull per user, one
 * /matters pull for admin-matter membership, and one matter lookup per
 * placeholder-candidate matter — the same query budget as the dashboard's
 * monthly builders.
 */
export async function classifyYtdTimeEntries(opts: {
  year: number;
  endDate: string;
  userIds: number[];
}): Promise<ClassifiedTimeEntry[]> {
  const startDate = `${opts.year}-01-01`;
  const adminIds = await getAdminMatterIds();

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
  return classifyRawEntries(raw, adminIds, excludedIds);
}
