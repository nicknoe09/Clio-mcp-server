// ============================================================
// Clio report CSV helpers (extracted from documents.ts)
// Fetch/generate/parse Clio reports (Fee Allocation, Revenue, Client Activity,
// Realization) and map report names to the firm roster. Self-contained: depends
// only on the Clio pagination/HTTP helpers. Shared by the dashboard tools.
// ============================================================
import { fetchAllPages, downloadReport, rawGetSingle, rawPostSingle } from "./pagination";

// ========== CSV helpers (for fee allocation) ==========
export function parseCSV(csv: string): Record<string, string>[] {
  // Strip a leading UTF-8 BOM — Clio CSV exports often include one, which would
  // otherwise corrupt the first header key (e.g. "﻿Activity month") and
  // break exact-name column lookups / signature checks.
  const lines = csv.replace(/^﻿/, "").split("\n");
  if (lines.length < 2) return [];
  function parseLine(line: string): string[] {
    const fields: string[] = []; let current = ""; let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (inQuotes && line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = !inQuotes; } }
      else if (ch === "," && !inQuotes) { fields.push(current.trim()); current = ""; }
      else { current += ch; }
    }
    fields.push(current.trim()); return fields;
  }
  const headers = parseLine(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const values = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => { row[h] = values[j] ?? ""; });
    return row;
  });
}

export async function getFeeAllocationCSV(reportId?: number): Promise<{ rows: Record<string, string>[]; report: any }> {
  const reports = await fetchAllPages<any>("/reports", { fields: "id,name,state,kind,format", order: "name(asc)" });
  const feeReports = reports.filter((r: any) => r.kind === "fee_allocation" && r.state === "completed" && r.format === "csv");
  if (feeReports.length === 0) throw new Error("No completed Fee Allocation Report found in Clio.");
  let target;
  if (reportId) {
    target = feeReports.find((r: any) => r.id === reportId);
    if (!target) throw new Error(`Report ID ${reportId} not found among ${feeReports.length} fee allocation reports.`);
  } else {
    target = feeReports.reduce((a: any, b: any) => (a.id > b.id ? a : b));
  }
  const csv = await downloadReport(target.id);
  return { rows: parseCSV(csv), report: target };
}

/**
 * Guard against Clio returning a report for the WRONG period. POST /reports
 * with start_date/end_date can hand back a cached/dedup'd report from a prior
 * run (e.g. April's) when the firm's engine doesn't apply the requested range —
 * which silently writes the wrong month's numbers into the target month. After
 * a report completes, read its authoritative start_date back and abort if it
 * doesn't match what we asked for. Returns the report's period for logging.
 * If Clio doesn't expose start_date on the report, we can't verify — log and
 * proceed (no false abort).
 */
export async function assertReportPeriod(reportId: number | string, wantStart: string, label: string): Promise<{ start?: string; end?: string }> {
  let meta: any;
  try {
    const s = await rawGetSingle(`/reports/${reportId}`, { fields: "id,state,start_date,end_date,kind" });
    meta = s?.data ?? s;
  } catch {
    return {};
  }
  const got = meta?.start_date ? String(meta.start_date).slice(0, 10) : "";
  if (got && got !== wantStart) {
    throw new Error(
      `${label}: Clio returned report ${reportId} for ${got}..${meta?.end_date ? String(meta.end_date).slice(0, 10) : "?"}, ` +
      `but the target month is ${wantStart}. Aborting so the wrong month's data is NOT written. ` +
      `(Clio likely returned a cached report; retry, or pass an explicit report_id generated for the target month.)`,
    );
  }
  if (!got) console.warn(`[Dashboard] ${label}: report ${reportId} did not expose start_date — period unverified`);
  else console.log(`[Dashboard] ${label}: report ${reportId} period ${got}..${meta?.end_date ? String(meta.end_date).slice(0, 10) : "?"} OK`);
  return { start: meta?.start_date, end: meta?.end_date };
}

// Generate a Fee Allocation report for a period and return its rows.
//
// filter_by_payment=true (DEFAULT) makes the date range filter by PAYMENT date
// (money actually received in the period) rather than invoice issue date — the
// payment-received basis, which also captures payments on prior-year invoices (the
// issue-date split dropped them). This is what the COLLECTIONS columns use.
//
// filter_by_payment=false makes the date range filter by INVOICE ISSUE DATE (the
// time that appeared on a bill issued in the period). This is what the BILLED $
// column uses (see buildMonthlyBilled). Pass startOverride/endOverride to request
// an arbitrary window (e.g. Jan 1 .. early-next-month, so late-issued bills that
// belong to the prior month are captured and re-bucketed by adjusted issue date).
//
// Each row is a timekeeper's allocation on an invoice: "User" (working timekeeper →
// col N), "Responsible Attorney" (→ col S), "Originating Attorney" (→ col V), "Billed Time",
// "Billed Time Collected", "Issue Date". Mirrors getClientActivityCSV's
// POST+poll+retry and verifies the period via assertReportPeriod so a wrong-period
// report aborts instead of writing bad data.
export async function genFeeAllocationByMonth(
  year: number,
  month: number,
  opts: { filterByPayment?: boolean; startOverride?: string; endOverride?: string } = {},
): Promise<Record<string, string>[]> {
  const filterByPayment = opts.filterByPayment ?? true;
  const start = opts.startOverride ?? `${year}-${String(month).padStart(2, "0")}-01`;
  const endDay = new Date(year, month, 0).getDate();
  const end = opts.endOverride ?? `${year}-${String(month).padStart(2, "0")}-${endDay}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const attempts = 3;
  let lastErr: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let reportId: number | undefined;
    let state: string | undefined;
    try {
      const gen = await rawPostSingle("/reports", { data: { kind: "fee_allocation", format: "csv", filter_by_payment: filterByPayment, start_date: start, end_date: end } });
      const rep = gen?.data ?? gen;
      reportId = rep?.id;
      state = rep?.state;
    } catch (e: any) {
      lastErr = e;
      if (e?.response?.status === 422) throw e; // bad params — retrying won't help
      console.warn(`[Dashboard] fee allocation (payment) gen attempt ${attempt}/${attempts} for ${start}: POST failed: ${e?.message ?? e}`);
      if (attempt < attempts) await sleep(3000 * attempt);
      continue;
    }
    if (!reportId) { lastErr = new Error("fee allocation POST returned no report id"); if (attempt < attempts) await sleep(3000 * attempt); continue; }
    const deadline = Date.now() + 150000;
    while (!["completed", "failed", "empty"].includes(state ?? "") && Date.now() < deadline) {
      await sleep(4000);
      try { const s = await rawGetSingle(`/reports/${reportId}`, { fields: "id,state" }); state = (s?.data ?? s)?.state; }
      catch { /* transient — keep polling */ }
    }
    if (state === "completed") {
      await assertReportPeriod(reportId, start, `fee allocation (payment-filtered) ${start}`);
      return parseCSV(await downloadReport(reportId));
    }
    lastErr = new Error(`fee allocation report ${reportId} did not complete (state=${state ?? "unknown"})`);
    console.warn(`[Dashboard] fee allocation (payment) gen attempt ${attempt}/${attempts}: ${lastErr.message}`);
    if (attempt < attempts) await sleep(3000 * attempt);
  }
  throw new Error(`payment-filtered fee allocation for ${start}..${end} failed after ${attempts} attempt(s): ${lastErr?.message ?? lastErr}`);
}

// ========== Client Activity Report (per-month) ==========
// Auto-generates a single-month Client Activity report and downloads the CSV.
// Each row is one time entry / expense with: User (full name), Date, Quantity,
// Price, Total, Status (Billed/Unbilled), Invoice Number, Invoice Status.
// The Realization tab needs the discounted-vs-nondiscounted hours split, which
// is derivable from this report: Status=="Billed" with Quantity*Price == Total
// means "no discount applied to this line", while Status=="Billed" with
// Quantity*Price > Total means a line-level discount was applied (verified
// against April 2026 sample — 27 discount-detected lines, 0 partial discounts,
// all 27 sit on multi-line invoices alongside normally-billed lines).
export async function getClientActivityCSV(opts: {
  start_date: string;
  end_date: string;
  reportId?: number;
  pollSeconds?: number;
}): Promise<{ rows: Record<string, string>[]; report: { id: number; kind: string; via: "post" | "list" } }> {
  // If a report id was passed, skip generation and just download.
  if (opts.reportId) {
    const csv = await downloadReport(opts.reportId);
    return { rows: parseCSV(csv), report: { id: opts.reportId, kind: "client_activity", via: "list" } };
  }
  // Auto-generate with RETRIES. POST + poll, keyed on the report id (not on the
  // initial state — Clio's POST response often omits `state`, which previously
  // skipped polling entirely and surfaced "never completed (state=undefined)").
  // On a transient failure (POST error, or never reaching `completed`) we retry
  // a few times — this is the "rerun the failed portion on its own" behavior.
  // After all attempts, fall back to the latest existing Client Activity report.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const attempts = 3;
  let lastErr: any;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let reportId: number | undefined;
    let state: string | undefined;
    try {
      const gen = await rawPostSingle("/reports", { data: { kind: "client_activity", format: "csv", start_date: opts.start_date, end_date: opts.end_date } });
      const rep = gen?.data ?? gen;
      reportId = rep?.id;
      state = rep?.state;
    } catch (e: any) {
      lastErr = e;
      if (e?.response?.status === 422) break; // bad kind — retrying won't help; go to fallback
      console.warn(`[Dashboard] Client Activity gen attempt ${attempt}/${attempts}: POST failed: ${e?.message ?? e}`);
      if (attempt < attempts) await sleep(3000 * attempt);
      continue;
    }
    if (!reportId) { lastErr = new Error("Client Activity POST returned no report id"); if (attempt < attempts) await sleep(3000 * attempt); continue; }
    const deadline = Date.now() + (opts.pollSeconds ?? 150) * 1000;
    while (!["completed", "failed", "empty"].includes(state ?? "") && Date.now() < deadline) {
      await sleep(4000);
      try { const s = await rawGetSingle(`/reports/${reportId}`, { fields: "id,state" }); state = (s?.data ?? s)?.state; }
      catch { /* transient — keep polling */ }
    }
    if (state === "completed") {
      await assertReportPeriod(reportId, opts.start_date, "Client Activity report");
      return { rows: parseCSV(await downloadReport(reportId)), report: { id: reportId, kind: "client_activity", via: "post" } };
    }
    lastErr = new Error(`Client Activity report ${reportId} did not complete (state=${state ?? "unknown"})`);
    console.warn(`[Dashboard] Client Activity gen attempt ${attempt}/${attempts}: ${lastErr.message}`);
    if (attempt < attempts) await sleep(3000 * attempt);
  }
  // Fallback: latest existing completed Client Activity CSV report.
  // NOTE: /reports rejects order=id(...) with HTTP 422 (see getRevenueReportCSV),
  // so list with the proven-safe name ordering and sort newest-first in memory —
  // otherwise this fallback would itself 422 exactly when generation just failed,
  // masking the real error.
  const reports = (await fetchAllPages<any>("/reports", { fields: "id,name,state,kind,format,created_at", order: "name(asc)" }))
    .sort((a: any, b: any) => b.id - a.id);
  const candidates = reports.filter((r: any) =>
    r.state === "completed" && r.format === "csv" &&
    (String(r.kind || "").toLowerCase().includes("client_activity") ||
     String(r.name || "").toLowerCase().includes("client activity")));
  if (candidates.length) {
    const target = candidates[0];
    const csv = await downloadReport(target.id);
    return { rows: parseCSV(csv), report: { id: target.id, kind: target.kind ?? "client_activity", via: "list" } };
  }
  throw new Error(`Client Activity report failed after ${attempts} attempt(s) and no completed report exists in /reports. Last error: ${lastErr?.message ?? lastErr}`);
}

// ========== Realization Report (per-month) ==========
// Auto-generates a single-month Realization report and downloads the CSV.
// Each row is one time entry with: User, Time Entry Date, Invoice Status,
// Billed Time Amount, Amount Discounted, Adjusted Amount, **Billed Time
// Collected**, **Billed Time Outstanding**, Billed Time Credited, Billed
// Hours, Hours Discounted, Adjusted Hours. The collected/outstanding columns
// attribute payment $ back to the timekeeper who did the work — that is the
// basis Rachel's hand-entered Collection tab uses (verified against the
// 06/05/2026 April sample: PAR April Collected = $56,553, Outstanding = $8,923).
export async function getRealizationReportCSV(opts: {
  start_date: string;
  end_date: string;
  reportId?: number;
  pollSeconds?: number;
}): Promise<{ rows: Record<string, string>[]; report: { id: number; kind: string; via: "post" | "list" } }> {
  if (opts.reportId) {
    const csv = await downloadReport(opts.reportId);
    return { rows: parseCSV(csv), report: { id: opts.reportId, kind: "matter_realization", via: "list" } };
  }
  // Try several plausible kind strings — Clio's report kinds vary slightly.
  // "realization" is FIRST because it is the kind Clio actually accepts (verified
  // live 2026-07: POST /reports {kind:"realization"} completes in seconds with the
  // Billed Time Collected / Outstanding / Billed Hours columns this module needs);
  // the others are kept only as defensive fallbacks and normally 422.
  const kindCandidates = ["realization", "matter_realization", "matter_realization_rate"];
  let lastErr: any;
  for (const kind of kindCandidates) {
    const body: any = { data: { kind, format: "csv", start_date: opts.start_date, end_date: opts.end_date } };
    let reportId: number | undefined;
    let state: string | undefined;
    try {
      const gen = await rawPostSingle("/reports", body);
      const rep = gen?.data ?? gen;
      reportId = rep?.id;
      state = rep?.state;
    } catch (e: any) { lastErr = e; continue; }
    if (!reportId) { lastErr = new Error(`POST ${kind} returned no id`); continue; }
    const deadline = Date.now() + (opts.pollSeconds ?? 150) * 1000;
    // Key the poll on reportId, not state (Clio's POST may omit state); keep
    // polling through transient GET errors.
    while (!["completed", "failed", "empty"].includes(state ?? "") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      try { const s = await rawGetSingle(`/reports/${reportId}`, { fields: "id,state" }); state = (s?.data ?? s)?.state; }
      catch { /* transient — keep polling */ }
    }
    if (state === "completed") {
      await assertReportPeriod(reportId, opts.start_date, "Realization report");
      const csv = await downloadReport(reportId);
      return { rows: parseCSV(csv), report: { id: reportId, kind, via: "post" } };
    }
    lastErr = new Error(`Report ${reportId} kind=${kind} did not complete (state=${state})`);
  }
  // Fallback: pick the most recent completed realization CSV by name match.
  // /reports rejects order=id(...) (HTTP 422), so order by name and sort by id
  // in memory — see the identical note in getClientActivityCSV.
  const reports = (await fetchAllPages<any>("/reports", { fields: "id,name,state,kind,format,created_at", order: "name(asc)" }))
    .sort((a: any, b: any) => b.id - a.id);
  const candidates = reports.filter((r: any) =>
    r.state === "completed" && r.format === "csv" &&
    (String(r.kind || "").toLowerCase().includes("realization") ||
     String(r.name || "").toLowerCase().includes("realization")));
  if (!candidates.length) {
    const detail = lastErr?.response?.data ? JSON.stringify(lastErr.response.data) : String(lastErr ?? "no candidates");
    throw new Error(`Could not POST a Realization report and no completed Realization reports found in /reports. Detail: ${detail}`);
  }
  const target = candidates[0];
  const csv = await downloadReport(target.id);
  return { rows: parseCSV(csv), report: { id: target.id, kind: target.kind ?? "realization", via: "list" } };
}

// Per-timekeeper COLLECTED / UNCOLLECTED HOURS from a Realization Report CSV.
// The Collection tab is in HOURS (consistent with the Realization tab), not $.
// The report gives, per time entry: Billed Hours, Billed Time Amount ($),
// Billed Time Collected ($), Billed Time Outstanding ($). We allocate each
// entry's billed HOURS to collected vs uncollected in proportion to its
// collected/outstanding dollars (so the collection rate in hours == the rate
// in dollars, and partial payments are handled). Summed by the User who did
// the work.
export type RealizCollectionsAgg = { collectedHrs: number; uncollectedHrs: number };
export function aggregateRealizationCollections(rows: Record<string, string>[], nameToUid: Map<string, number>): Record<number, RealizCollectionsAgg> {
  const num = (x: string | undefined) => parseFloat((x ?? "0").replace(/[$,()]/g, "")) || 0;
  const out: Record<number, RealizCollectionsAgg> = {};
  for (const r of rows) {
    const name = (r["User"] ?? "").trim().toLowerCase();
    const uid = nameToUid.get(name);
    if (uid == null) continue;
    const billed$ = num(r["Billed Time Amount"]);
    const coll$ = num(r["Billed Time Collected"]);
    const out$ = num(r["Billed Time Outstanding"]);
    const hrs = num(r["Billed Hours"]);
    if (billed$ <= 0 || hrs <= 0) continue;
    const slot = (out[uid] ??= { collectedHrs: 0, uncollectedHrs: 0 });
    slot.collectedHrs += hrs * (coll$ / billed$);
    slot.uncollectedHrs += hrs * (out$ / billed$);
  }
  return out;
}

// Same collected/uncollected HOURS, but from the FEE ALLOCATION CSV (already
// pulled for collections). It carries per-User "Billed Hours", "Billed Time"
// ($), "Billed Time Collected" ($), "Billed Time Outstanding" ($) — enough to
// allocate billed hours to collected vs uncollected by the dollar split. This
// is the DEFAULT Collection source.
//
// HISTORICAL NOTE: this used to be the default because "the dedicated
// Realization report can't be generated via the API (POST 422s)". That is NO
// LONGER TRUE — as of 2026-07, POST /reports {kind:"realization"} generates and
// completes reliably (getRealizationReportCSV drives it), and its per-User
// Billed Time Collected/Outstanding/Billed Hours are the authoritative basis
// (aggregateRealizationCollections). Fee-allocation stays the default for now
// only because the two sources use different date bases (fee-allocation =
// invoice issue date; realization = time-entry date), so switching the default
// must be validated against prior data first — see the compare_collection_methods
// diagnostic. Keyed by user_id via the roster matcher.
export function aggregateFeeAllocationCollectionHrs(
  rows: Record<string, string>[],
  roster: { initials: string; name: string; user_id: number }[],
): Record<number, RealizCollectionsAgg> {
  const num = (x: string | undefined) => parseFloat((x ?? "0").replace(/[$,()]/g, "")) || 0;
  const out: Record<number, RealizCollectionsAgg> = {};
  for (const r of rows) {
    const uid = matchRosterUser(r["User"] ?? "", roster);
    if (uid == null) continue;
    const billed$ = num(r["Billed Time"]);
    const coll$ = num(r["Billed Time Collected"]);
    const out$ = num(r["Billed Time Outstanding"]);
    const hrs = num(r["Billed Hours"]);
    if (billed$ <= 0 || hrs <= 0) continue;
    const slot = (out[uid] ??= { collectedHrs: 0, uncollectedHrs: 0 });
    slot.collectedHrs += hrs * (coll$ / billed$);
    slot.uncollectedHrs += hrs * (out$ / billed$);
  }
  return out;
}

// Per-timekeeper hours buckets derived from a Client Activity CSV.
// - billedNondiscHrs: Status=Billed AND |Qty*Price - Total| < 0.005
// - billedDiscHrs:    Status=Billed AND Total < Qty*Price (line discount or full no-charge)
// - unbilledHrs:      Status=Unbilled (includes Draft invoices)
// - nonbillableHrs:   Price == 0 (admin matters)
// `nameToUid` maps the CSV's "User" (full name, e.g. "Paul Romano") to a numeric user_id.
export type ClientActivityAgg = { billedNondiscHrs: number; billedDiscHrs: number; unbilledHrs: number; nonbillableHrs: number };
export function aggregateClientActivity(rows: Record<string, string>[], nameToUid: Map<string, number>): Record<number, ClientActivityAgg> {
  const out: Record<number, ClientActivityAgg> = {};
  for (const r of rows) {
    if (r["Type"] !== "Hourly time entry") continue;
    const name = (r["User"] ?? "").trim().toLowerCase();
    const uid = nameToUid.get(name);
    if (uid == null) continue;
    const q = parseFloat(r["Quantity"] ?? "0") || 0;
    const p = parseFloat(r["Price"] ?? "0") || 0;
    const t = parseFloat(r["Total"] ?? "0") || 0;
    const slot = (out[uid] ??= { billedNondiscHrs: 0, billedDiscHrs: 0, unbilledHrs: 0, nonbillableHrs: 0 });
    if (p === 0) slot.nonbillableHrs += q;
    else if (r["Status"] === "Unbilled") slot.unbilledHrs += q;
    else if (Math.abs(q * p - t) < 0.005) slot.billedNondiscHrs += q;
    else slot.billedDiscHrs += q;
  }
  return out;
}

// ========== Revenue Report (classic, monthly) helpers ==========
// The "Revenue Report (Like Classic)" export grouped by Activity month + User
// + Responsible attorney. ONE download carries every YTD month plus the
// authoritative billed / billable / write-off / discount figures — replacing
// the old firm-wide /activities pagination that reconstructed billed$ as
// hours×rate (slow, and wrong because it ignored write-offs/discounts and used
// the current rate rather than the billed amount).
//
// Reports aren't reliably tagged by `kind` for this export, so we select by
// header signature: only the monthly-classic shape carries all of these
// columns together (the per-matter and per-timekeeper variants do not).
export const REVENUE_REPORT_SIGNATURE = ["Activity month", "User initials", "Responsible attorney", "Billed hours value"];

export async function getRevenueReportCSV(reportId?: number): Promise<{ rows: Record<string, string>[]; report: any }> {
  // NOTE: /reports does not accept order=id(...) (Clio returns HTTP 422), so list
  // with the proven-safe name ordering and sort newest-first (highest id) in memory.
  const reports = await fetchAllPages<any>("/reports", { fields: "id,name,state,kind,format", order: "name(asc)" });
  const csvReports = reports
    .filter((r: any) => r.state === "completed" && r.format === "csv")
    .sort((a: any, b: any) => b.id - a.id);
  const hasSignature = (rows: Record<string, string>[]) =>
    rows.length > 0 && REVENUE_REPORT_SIGNATURE.every((c) => c in rows[0]);

  if (reportId) {
    const target = csvReports.find((r: any) => r.id === reportId);
    if (!target) throw new Error(`Report ID ${reportId} not found among completed CSV reports.`);
    const rows = parseCSV(await downloadReport(target.id));
    if (!hasSignature(rows)) {
      throw new Error(`Report ID ${reportId} ("${target.name}") is not a monthly classic Revenue Report (missing one of: ${REVENUE_REPORT_SIGNATURE.join(", ")}).`);
    }
    return { rows, report: target };
  }

  // Prefer reports whose name hints "revenue" (newest first), then fall back to
  // scanning other CSV reports. Validate each candidate by header signature so a
  // mis-named or wrong-shape report can't be silently picked. We sniff ALL
  // revenue-named reports (so the cap can never hide the right one) and bound
  // only the fallback scan of non-revenue reports.
  const byName = csvReports.filter((r: any) => /revenue/i.test(r.name || ""));
  const rest = csvReports.filter((r: any) => !byName.includes(r));
  const candidates = [...byName, ...rest.slice(0, 25)];
  const sniffed: { id: number; name: string; cols: string }[] = [];
  for (const cand of candidates) {
    try {
      const rows = parseCSV(await downloadReport(cand.id));
      if (hasSignature(rows)) return { rows, report: cand };
      sniffed.push({ id: cand.id, name: cand.name, cols: rows[0] ? Object.keys(rows[0]).join("|") : "(empty)" });
    } catch (e: any) {
      sniffed.push({ id: cand.id, name: cand.name, cols: `(download error: ${e?.message ?? e})` });
    }
  }
  // Self-diagnosing error: list what was actually in Clio + why revenue-named
  // candidates were rejected, so the failure can be triaged from the message alone.
  const listing = csvReports.slice(0, 20).map((r: any) => `#${r.id} ${r.name}`).join("; ") || "(none)";
  const revDetail = sniffed
    .filter((s) => /revenue/i.test(s.name))
    .slice(0, 5)
    .map((s) => `#${s.id} "${s.name}" cols=[${s.cols}]`)
    .join(" || ");
  throw new Error(
    `No completed monthly classic Revenue Report found in Clio (need a CSV containing: ${REVENUE_REPORT_SIGNATURE.join(", ")}). ` +
    `Scanned ${csvReports.length} completed CSV report(s). ` +
    (revDetail
      ? `Revenue-named candidates checked but rejected: ${revDetail}. `
      : `No completed CSV report has "revenue" in its name. `) +
    `Completed CSV reports seen: ${listing}. ` +
    `Fix: generate/schedule the "Revenue Report (Like Classic)" grouped by Activity month + User as CSV in Clio, or pass revenue_report_id explicitly.`
  );
}

// Match the revenue report's "User" field ("Last, First") to a roster user_id.
// Returns null for non-roster timekeepers (staff/paralegals) so they're skipped
// for the per-attorney columns but still roll up under their responsible attorney.
export function matchRosterUser(userField: string, roster: { initials: string; name: string; user_id: number }[]): number | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").trim();
  const parts = userField.split(",").map((p) => norm(p));
  let last = "", first = "";
  if (parts.length >= 2) { last = parts[0]; first = parts[1]; }
  else { const t = norm(userField).split(/\s+/); first = t[0] || ""; last = t[t.length - 1] || ""; }
  for (const r of roster) {
    const rn = norm(r.name).split(/\s+/);
    const rFirst = rn[0] || "", rLast = rn[rn.length - 1] || "";
    if (rLast === last && (first === "" || rFirst.startsWith(first) || first.startsWith(rFirst))) return r.user_id;
  }
  return null;
}

// Match the revenue report's "Responsible attorney" field ("First Last") to a roster user_id.
export function matchRosterResponsible(respField: string, roster: { initials: string; name: string; user_id: number }[]): number | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").trim();
  const target = norm(respField);
  if (!target) return null;
  for (const r of roster) if (norm(r.name) === target) return r.user_id;
  const tl = target.split(/\s+/).pop();
  for (const r of roster) if (norm(r.name).split(/\s+/).pop() === tl) return r.user_id;
  return null;
}
