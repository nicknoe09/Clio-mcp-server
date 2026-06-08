// ============================================================
// Revenue builder (extracted from download_dashboard_update).
// Produces per-month billed/billable/write-off/discount figures by working
// timekeeper (col-group) and a responsible-attorney rollup. Two sources:
//   (A) a month×user "(like Classic)" CSV — Box (revenueCsvBoxFileId) or Clio
//       /reports (revenueReportId); covers all YTD months in one file; or
//   (B) DEFAULT: classic per-timekeeper revenue (Rachel's manual method) —
//       one report per roster member + a firm-wide report, target month only.
// ============================================================
import {
  parseCSV, getRevenueReportCSV, REVENUE_REPORT_SIGNATURE,
  matchRosterUser, matchRosterResponsible, assertReportPeriod,
} from "../clio/reportCsv";
import { rawPostSingle, rawGetSingle, downloadReport } from "../clio/pagination";
import { downloadFromBox } from "../utils/box";
import type { RosterMember } from "../domain/roster";

export type RevenueUserData = {
  billableHrs: number; billedDollars: number; writeOffs: number; lineDiscounts: number; nonbillableHrs: number;
};
export type RespRollup = { respHrs: number; respBilled: number };
export type RevenueByMonth = {
  indivByMonth: Record<number, Record<number, RevenueUserData>>;
  respByMonth: Record<number, Record<number, RespRollup>>;
  revMonths: number[];   // months we have revenue for (all YTD for month×user; target-only for classic)
  revLabel: string;      // human-readable provenance, for logging
  useBeta: boolean;      // true when a month×user source (Box/Clio) was used (vs classic per-timekeeper)
};

const num = (v: string | undefined) => { const n = parseFloat(v ?? ""); return isNaN(n) ? 0 : n; };
const newRevenueUser = (): RevenueUserData => ({ billableHrs: 0, billedDollars: 0, writeOffs: 0, lineDiscounts: 0, nonbillableHrs: 0 });

export async function buildRevenueByMonth(
  opts: { year: number; month: number; revenueCsvBoxFileId?: string; revenueReportId?: number },
  roster: RosterMember[],
): Promise<RevenueByMonth> {
  const { year, month } = opts;
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;

  const indivByMonth: Record<number, Record<number, RevenueUserData>> = {};
  const respByMonth: Record<number, Record<number, RespRollup>> = {};

  const useBox = !!opts.revenueCsvBoxFileId;
  const useBeta = useBox || opts.revenueReportId != null;
  let revLabel = "";

  if (useBeta) {
    const { rows: revRows } = useBox
      ? { rows: parseCSV((await downloadFromBox(opts.revenueCsvBoxFileId!)).toString("utf8")) }
      : await getRevenueReportCSV(opts.revenueReportId);
    if (!revRows.length || !REVENUE_REPORT_SIGNATURE.every((c) => c in revRows[0])) {
      throw new Error(`Revenue CSV is missing required columns (${REVENUE_REPORT_SIGNATURE.join(", ")}). ${useBox ? `The Box file ${opts.revenueCsvBoxFileId} isn't a month×user Revenue Report (got: ${revRows[0] ? Object.keys(revRows[0]).join(", ") : "empty"}).` : ""}`);
    }
    for (const row of revRows) {
      const m = parseInt(row["Activity month"] || "0", 10);
      if (!m || m < 1 || m > month) continue;
      const billableHrs = num(row["Billable hours"]);
      const billedDollars = num(row["Billed hours value"]);
      const uid = matchRosterUser(row["User"] || "", roster);
      if (uid != null) {
        const d = ((indivByMonth[m] ??= {})[uid] ??= newRevenueUser());
        d.billableHrs += billableHrs;
        d.billedDollars += billedDollars;
        d.writeOffs += num(row["Credited hours value"]);
        d.lineDiscounts += Math.abs(num(row["Discounted hours amount"]));
        d.nonbillableHrs += num(row["Non-billable hours"]);
      }
      const rid = matchRosterResponsible(row["Responsible attorney"] || "", roster);
      if (rid != null) {
        const rd = ((respByMonth[m] ??= {})[rid] ??= { respHrs: 0, respBilled: 0 });
        rd.respHrs += billableHrs;
        rd.respBilled += billedDollars;
      }
    }
    revLabel = `month×user (${useBox ? "Box CSV" : "/reports #" + opts.revenueReportId}) rows=${revRows.length}`;
  } else {
    // Generate a classic revenue report (optional user scope) for the target
    // month, poll to completion (the endpoint is flaky), then download + parse.
    const genRevenueRows = async (userId?: number): Promise<Record<string, string>[]> => {
      const data: any = { kind: "revenue", format: "csv", start_date: monthStart, end_date: monthEnd };
      if (userId) data.user = { id: userId };
      const gen = await rawPostSingle("/reports", { data });
      const rep = gen?.data ?? gen;
      const rid = rep?.id;
      let state = rep?.state;
      const deadline = Date.now() + 150000;
      while (rid && !["completed", "failed", "empty"].includes(state) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4000));
        try { const s = await rawGetSingle(`/reports/${rid}`, { fields: "id,state" }); state = (s?.data ?? s)?.state; }
        catch { /* transient — keep polling */ }
      }
      if (state !== "completed") throw new Error(`revenue report ${rid} did not complete (state=${state})`);
      // Guard: confirm Clio honored the requested month (avoid a cached/wrong-period report).
      await assertReportPeriod(rid, monthStart, `revenue report (${userId ? "user " + userId : "firm-wide"})`);
      return parseCSV(await downloadReport(rid));
    };
    const m = month;
    // Firm-wide → responsible-attorney rollup (skip the trailing TOTAL row, which has no Matter Number)
    const firmRows = await genRevenueRows();
    for (const row of firmRows) {
      if (!row["Matter Number"]) continue;
      const rid = matchRosterResponsible(row["Responsible Attorney"] || "", roster);
      if (rid == null) continue;
      const rd = ((respByMonth[m] ??= {})[rid] ??= { respHrs: 0, respBilled: 0 });
      rd.respHrs += num(row["Billed Hours"]) + num(row["Unbilled Hours"]);
      rd.respBilled += num(row["Billed Time"]);
    }
    // Per-timekeeper → individual (one revenue report scoped to each user)
    let okUsers = 0;
    for (const ro of roster) {
      let rows: Record<string, string>[];
      try { rows = await genRevenueRows(ro.user_id); }
      catch (e: any) { console.warn(`[Dashboard] classic revenue failed for ${ro.initials}: ${e?.message ?? e}`); continue; }
      const d = ((indivByMonth[m] ??= {})[ro.user_id] ??= newRevenueUser());
      for (const row of rows) {
        if (!row["Matter Number"]) continue;
        d.billedDollars += num(row["Billed Time"]);
        d.billableHrs += num(row["Billed Hours"]) + num(row["Unbilled Hours"]);
        d.writeOffs += num(row["Credit Notes"]);
        d.lineDiscounts += num(row["Discounted Time"]);
      }
      okUsers++;
    }
    revLabel = `classic per-timekeeper (${okUsers}/${roster.length} users) + firm-wide, month ${m}`;
  }

  const revMonths = useBeta ? Array.from({ length: month }, (_, i) => i + 1) : [month];
  return { indivByMonth, respByMonth, revMonths, revLabel, useBeta };
}
