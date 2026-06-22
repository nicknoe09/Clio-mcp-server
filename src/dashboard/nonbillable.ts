// ============================================================
// Nonbillable-category hours builder (extracted from download_dashboard_update).
// Pure data assembly via targeted Clio /activities queries — no workbook mutation.
// ============================================================
import { fetchAllPages } from "../clio/pagination";

export type NonbillableCats = { bizDev: number; potentialClients: number; cle: number; otherAdmin: number };
// month (1-12) -> user_id -> category hours
export type NonbillableByMonth = Record<number, Record<number, NonbillableCats>>;

type CatKey = keyof NonbillableCats;
// Each category maps to one OR MORE matter display-number prefixes. Website work
// (matter 00316 "Romano & Sumner Website") rolls into Biz Dev per Rachel's split.
export const CATEGORY_PREFIXES: { key: CatKey; prefixes: string[] }[] = [
  { key: "bizDev", prefixes: ["00706", "00316"] }, // ROMSUM Business Development + firm Website
  { key: "potentialClients", prefixes: ["00050"] }, // Potential Clients
  { key: "cle", prefixes: ["00707"] },              // Continuing Legal Education
  { key: "otherAdmin", prefixes: ["02888"] },       // Other Admin (matter 02888-Admin; 00158 never existed → pulled 0)
];

/**
 * Nonbillable hours by month×user, split into the four tracked admin categories,
 * pulled from a targeted /activities query on the admin matters (Rachel's method).
 * Total nonbillable = the sum of the four. Counts entries dated
 * [year-01-01 .. end-of-month], months 1..month.
 */
export async function buildNonbillableByMonth(year: number, month: number): Promise<NonbillableByMonth> {
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
  const allMatters = await fetchAllPages<any>("/matters", { fields: "id,display_number" });
  const matterCat: Record<number, CatKey> = {};
  for (const cm of CATEGORY_PREFIXES) {
    for (const mt of allMatters) {
      const dn = String(mt.display_number || "");
      if (cm.prefixes.some((p) => dn.startsWith(p))) matterCat[mt.id] = cm.key;
    }
  }

  const catByMonth: NonbillableByMonth = {};
  for (const mid of Object.keys(matterCat).map(Number)) {
    const acts = await fetchAllPages<any>("/activities", {
      type: "TimeEntry",
      fields: "id,date,quantity,rounded_quantity,user{id}",
      matter_id: mid,
      created_since: `${year}-01-01T00:00:00+00:00`,
    });
    const cat = matterCat[mid];
    for (const a of acts) {
      if (a.date < `${year}-01-01` || a.date > monthEnd) continue;
      const m = parseInt(String(a.date).slice(5, 7), 10);
      if (!m || m > month) continue;
      const uid = a.user?.id;
      if (!uid) continue;
      const slot = ((catByMonth[m] ??= {})[uid] ??= { bizDev: 0, potentialClients: 0, cle: 0, otherAdmin: 0 });
      slot[cat] += (a.rounded_quantity ?? a.quantity) / 3600;
    }
  }
  return catByMonth;
}
