import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import ExcelJS from "exceljs";
import { fetchAllPages } from "../clio/pagination";
import { uploadToBox, createBoxFile, findBoxFileId, downloadFromBox } from "../utils/box";

// Box folder that holds the firm's managed workbooks (same as the dashboard).
const AR_SCORECARD_FOLDER = "348313592902";
const AR_SCORECARD_FILENAME = "AR Scorecard.xlsx";

const BILL_FIELDS =
  "id,number,issued_at,due_at,balance,total,kind,state,matters";

// trust_line_items has limited fields — use defaults + matter association
const TRUST_FIELDS = "id,date,total,matter{id,display_number,client}";

// Scorecard fetch needs matter sub-objects (client/responsible_attorney) plus
// `kind` (revenue_kind = true AR for services; trust_kind = trust/retainer
// funding request — NOT a receivable), `paid`/`paid_at` (whether/when a trust
// request was funded) and `state`.
const SCORECARD_BILL_FIELDS =
  "id,number,issued_at,due_at,balance,total,paid,paid_at,kind,state," +
  "matters{id,display_number,description,client,responsible_attorney}";

// Matter fields used to join AR/bill rows to a practice area for the
// Gated/Non-Gated split. status=all is fetched so closed-matter invoices still
// classify; practice_area{name} is the proven form (see audit.ts).
const SCORECARD_MATTER_FIELDS = "id,practice_area{name}";

// ====================================================================
// AR track classification (Gated vs. Non-Gated)
// --------------------------------------------------------------------
// A large share of firm AR is court-gated appointment work whose aging
// reflects court/estate payment timelines, not collection failure. Splitting
// AR by the matter's practice_area keeps those two tracks from corrupting each
// other's headline aging numbers. This mapping is the one partner-level policy
// choice in the split — it is intentionally kept in ONE place so get_ar_aging
// (or any future tool) can share it.
// ====================================================================
export const GATED_PRACTICE_AREAS = new Set<string>([
  "Appointment",
  "Guardianship",
  "Guardianship Litigation",
  "Mental Comm",
  "Representative",
]);
// Probate is paced by estate liquidity, but per firm policy it is client-pay
// (Non-Gated) in the general case, so it defaults to the non_gated track. It is
// still its own flag (semi_gated) so probate_treatment="separate" can break it
// out for review, or ="gated" if that ever changes.
export const SEMI_GATED_PRACTICE_AREAS = new Set<string>(["Probate"]);
// Everything else with a known practice area = Non-Gated (client-pay).

export type TrackKey = "gated" | "semi_gated" | "non_gated" | "unclassified";

// Classify a matter's practice_area name into a base track. A null/blank name
// is "unclassified" — never silently bucketed as either track, so null-practice
// -area matters stay visible for backfill.
export function classifyTrack(practiceAreaName: string | null | undefined): TrackKey {
  const name = (practiceAreaName ?? "").trim();
  if (!name) return "unclassified";
  if (GATED_PRACTICE_AREAS.has(name)) return "gated";
  if (SEMI_GATED_PRACTICE_AREAS.has(name)) return "semi_gated";
  return "non_gated";
}

export type ProbateTreatment = "gated" | "non_gated" | "separate";

// Apply the configurable probate_treatment to a base track. When Probate is not
// reported separately it is folded into the chosen track and semi_gated is
// dropped from the output.
export function effectiveTrack(base: TrackKey, treatment: ProbateTreatment): TrackKey {
  if (base === "semi_gated" && treatment !== "separate") {
    return treatment === "gated" ? "gated" : "non_gated";
  }
  return base;
}

interface Invoice {
  bill_id: number;
  bill_number: string;
  matter_id: number;
  matter_number: string;
  client_name: string;
  client_email: string | null;
  issued_at: string;
  due_at: string;
  balance: number;
  days_outstanding: number;
  responsible_attorney: string | null;
}

interface Bucket {
  total: number;
  count: number;
  unique_clients: number;
  invoices: Invoice[];
}

export function registerARTools(server: McpServer): void {
  // get_ar_aging
  server.tool(
    "get_ar_aging",
    "Full accounts receivable aging report. Counts ONLY revenue_kind fee bills; trust/retainer funding requests (trust_kind) are advance-deposit requests, not receivables, and are excluded. Groups outstanding invoices into buckets: Current (0-30), 31-60, 61-90, 91-120, 120+. Includes client emails for direct action.",
    {
      responsible_attorney_id: z
        .number()
        .optional()
        .describe("Filter to one attorney's matters"),
      as_of_date: z
        .string()
        .optional()
        .describe("As-of date for aging calc (YYYY-MM-DD, default today)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: BILL_FIELDS,
          state: "awaiting_payment",
        };
        if (params.responsible_attorney_id) {
          queryParams.responsible_attorney_id = params.responsible_attorney_id;
        }

        const bills = await fetchAllPages<any>("/bills", queryParams);
        const asOf = params.as_of_date ? new Date(params.as_of_date) : new Date();

        const buckets: Record<string, Invoice[]> = {
          current: [],
          days_31_60: [],
          days_61_90: [],
          days_91_120: [],
          over_120: [],
        };

        for (const b of bills) {
          // AR = revenue_kind fee bills only. A trust_kind bill is a trust/retainer
          // funding request, not a receivable; any other (unexpected) kind is
          // excluded and surfaced rather than silently aged into AR.
          if (b.kind === "trust_kind") continue;
          if (b.kind !== "revenue_kind") {
            console.warn(`[get_ar_aging] excluding bill ${b.number ?? b.id} from AR — unexpected kind=${JSON.stringify(b.kind)}`);
            continue;
          }
          const dueDate = b.due_at ? new Date(b.due_at) : new Date(b.issued_at);
          const daysOut = Math.floor(
            (asOf.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
          );

          const m = b.matters?.[0];

          const invoice: Invoice = {
            bill_id: b.id,
            bill_number: b.number,
            matter_id: m?.id,
            matter_number: m?.display_number,
            client_name: m?.client?.name ?? "Unknown",
            client_email: null,
            issued_at: b.issued_at,
            due_at: b.due_at,
            balance: b.balance,
            days_outstanding: Math.max(daysOut, 0),
            responsible_attorney: m?.responsible_attorney?.name ?? null,
          };

          if (daysOut <= 30) buckets.current.push(invoice);
          else if (daysOut <= 60) buckets.days_31_60.push(invoice);
          else if (daysOut <= 90) buckets.days_61_90.push(invoice);
          else if (daysOut <= 120) buckets.days_91_120.push(invoice);
          else buckets.over_120.push(invoice);
        }

        // Sort each bucket by balance desc
        for (const key of Object.keys(buckets)) {
          buckets[key].sort((a, b) => b.balance - a.balance);
        }

        const makeBucket = (invoices: Invoice[]): Bucket => ({
          total: Math.round(invoices.reduce((s, i) => s + i.balance, 0) * 100) / 100,
          count: invoices.length,
          unique_clients: new Set(invoices.map((i) => i.client_name)).size,
          invoices,
        });

        const allInvoices = Object.values(buckets).flat();
        const totalAR =
          Math.round(allInvoices.reduce((s, i) => s + i.balance, 0) * 100) / 100;
        const weightedDays = allInvoices.reduce(
          (s, i) => s + i.days_outstanding * i.balance,
          0
        );
        const avgDays =
          totalAR > 0 ? Math.round(weightedDays / totalAR) : 0;
        const largest =
          allInvoices.length > 0
            ? Math.max(...allInvoices.map((i) => i.balance))
            : 0;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  as_of_date: asOf.toISOString().split("T")[0],
                  summary: {
                    total_ar: totalAR,
                    avg_days_outstanding: avgDays,
                    largest_balance: largest,
                    total_invoices: allInvoices.length,
                  },
                  buckets: {
                    current: makeBucket(buckets.current),
                    days_31_60: makeBucket(buckets.days_31_60),
                    days_61_90: makeBucket(buckets.days_61_90),
                    days_91_120: makeBucket(buckets.days_91_120),
                    over_120: makeBucket(buckets.over_120),
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: err.message,
                status: err.response?.status,
                clio_error: err.response?.data,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // get_wip_report
  server.tool(
    "get_wip_report",
    "Work-in-progress report: all unbilled time and expenses, how long they have been sitting. Identifies revenue at risk of aging off.",
    {
      responsible_attorney_id: z
        .number()
        .optional()
        .describe("Filter by responsible attorney ID"),
      min_wip_value: z
        .number()
        .optional()
        .describe("Filter matters below this WIP threshold"),
    },
    async (params) => {
      try {
        const defaultStart = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
        const timeParams: Record<string, any> = {
          type: "TimeEntry",
          billed: false,
          fields:
            "id,date,quantity,rounded_quantity,price,matter{id,display_number,description,client,responsible_attorney}",
          created_since: `${defaultStart}T00:00:00+00:00`,
        };
        const expenseParams: Record<string, any> = {
          type: "ExpenseEntry",
          billed: false,
          fields:
            "id,date,price,matter{id,display_number,description,client,responsible_attorney}",
          created_since: `${defaultStart}T00:00:00+00:00`,
        };

        const [timeEntries, expenses] = await Promise.all([
          fetchAllPages<any>("/activities", timeParams),
          fetchAllPages<any>("/activities", expenseParams),
        ]);

        const byMatter: Record<
          number,
          {
            matter: any;
            unbilled_hours: number;
            unbilled_time_value: number;
            unbilled_expenses: number;
            oldest_entry: string;
          }
        > = {};

        for (const e of timeEntries) {
          const mid = e.matter?.id;
          if (!mid) continue;
          if (
            params.responsible_attorney_id &&
            e.matter?.responsible_attorney?.id !== params.responsible_attorney_id
          )
            continue;

          if (!byMatter[mid]) {
            byMatter[mid] = {
              matter: e.matter,
              unbilled_hours: 0,
              unbilled_time_value: 0,
              unbilled_expenses: 0,
              oldest_entry: e.date,
            };
          }
          // Use rounded_quantity (billed increment) not raw quantity, so WIP
          // matches what the client will actually see invoiced.
          const hours = (e.rounded_quantity ?? e.quantity) / 3600;
          byMatter[mid].unbilled_hours += hours;
          byMatter[mid].unbilled_time_value += hours * (e.price || 0);
          if (e.date < byMatter[mid].oldest_entry) {
            byMatter[mid].oldest_entry = e.date;
          }
        }

        for (const e of expenses) {
          const mid = e.matter?.id;
          if (!mid) continue;
          if (
            params.responsible_attorney_id &&
            e.matter?.responsible_attorney?.id !== params.responsible_attorney_id
          )
            continue;

          if (!byMatter[mid]) {
            byMatter[mid] = {
              matter: e.matter,
              unbilled_hours: 0,
              unbilled_time_value: 0,
              unbilled_expenses: 0,
              oldest_entry: e.date,
            };
          }
          byMatter[mid].unbilled_expenses += e.price || 0;
          if (e.date < byMatter[mid].oldest_entry) {
            byMatter[mid].oldest_entry = e.date;
          }
        }

        const today = new Date();
        let redFlagCount = 0;

        let matterResults = Object.entries(byMatter).map(([, m]) => {
          const combinedWip = m.unbilled_time_value + m.unbilled_expenses;
          const daysSinceOldest = Math.floor(
            (today.getTime() - new Date(m.oldest_entry).getTime()) /
              (1000 * 60 * 60 * 24)
          );

          let flag: string | null = null;
          if (daysSinceOldest > 60) {
            flag = "RED";
            redFlagCount++;
          } else if (daysSinceOldest > 30) {
            flag = "YELLOW";
          }

          return {
            matter_id: m.matter.id,
            matter_number: m.matter.display_number,
            matter_description: m.matter.description,
            client: m.matter.client,
            responsible_attorney: m.matter.responsible_attorney,
            oldest_entry_date: m.oldest_entry,
            days_since_oldest_entry: daysSinceOldest,
            unbilled_hours: Math.round(m.unbilled_hours * 100) / 100,
            unbilled_time_value: Math.round(m.unbilled_time_value * 100) / 100,
            unbilled_expenses: Math.round(m.unbilled_expenses * 100) / 100,
            combined_wip_value: Math.round(combinedWip * 100) / 100,
            flag,
          };
        });

        if (params.min_wip_value) {
          matterResults = matterResults.filter(
            (m) => m.combined_wip_value >= params.min_wip_value!
          );
        }

        matterResults.sort((a, b) => b.combined_wip_value - a.combined_wip_value);

        const totalWip =
          Math.round(
            matterResults.reduce((s, m) => s + m.combined_wip_value, 0) * 100
          ) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  summary: {
                    total_firm_wip: totalWip,
                    matters_with_wip: matterResults.length,
                    red_flag_matters: redFlagCount,
                  },
                  matters: matterResults,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: err.message,
                status: err.response?.status,
                clio_error: err.response?.data,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // get_trust_balances
  server.tool(
    "get_trust_balances",
    "Trust/IOLTA account balances and recent activity per matter. Flags low balances (<$500) and dormant accounts (90+ days no activity).",
    {
      matter_id: z
        .number()
        .optional()
        .describe("Filter to a specific matter (all matters if omitted)"),
      min_balance: z
        .number()
        .optional()
        .describe("Only show matters with trust balance above this amount"),
    },
    async (params) => {
      try {
        // Get trust bank accounts
        const bankAccounts = await fetchAllPages<any>("/bank_accounts", {
          fields: "id,name,type,balance",
        });

        const trustAccounts = bankAccounts.filter(
          (a: any) => a.type === "trust" || a.type === "Trust"
        );

        // Get trust ledger entries
        const ledgerParams: Record<string, any> = {
          fields: TRUST_FIELDS,
        };
        if (params.matter_id) ledgerParams.matter_id = params.matter_id;

        const ledgerEntries = await fetchAllPages<any>(
          "/trust_line_items",
          ledgerParams
        );

        // Group by matter
        const byMatter: Record<
          number,
          {
            matter: any;
            balance: number;
            entries: any[];
            last_deposit: string | null;
            last_disbursement: string | null;
          }
        > = {};

        for (const entry of ledgerEntries) {
          const mid = entry.matter?.id;
          if (!mid) continue;
          const amount = entry.total || 0;

          if (!byMatter[mid]) {
            byMatter[mid] = {
              matter: entry.matter,
              balance: 0,
              entries: [],
              last_deposit: null,
              last_disbursement: null,
            };
          }

          byMatter[mid].balance += amount;

          byMatter[mid].entries.push({
            id: entry.id,
            date: entry.date,
            amount,
          });

          if (amount > 0 && !byMatter[mid].last_deposit) {
            byMatter[mid].last_deposit = entry.date;
          }
          if (amount < 0 && !byMatter[mid].last_disbursement) {
            byMatter[mid].last_disbursement = entry.date;
          }
        }

        const today = new Date();
        let lowBalanceCount = 0;
        let dormantCount = 0;

        let matterResults = Object.entries(byMatter).map(([, m]) => {
          const lastActivity = m.entries.length > 0 ? m.entries[0].date : null;
          const daysSinceActivity = lastActivity
            ? Math.floor(
                (today.getTime() - new Date(lastActivity).getTime()) /
                  (1000 * 60 * 60 * 24)
              )
            : null;

          const flags: string[] = [];
          if (m.balance < 500) {
            flags.push("LOW_BALANCE");
            lowBalanceCount++;
          }
          if (daysSinceActivity !== null && daysSinceActivity > 90) {
            flags.push("DORMANT");
            dormantCount++;
          }

          return {
            matter_id: m.matter.id,
            matter_number: m.matter.display_number,
            client: m.matter.client,
            current_balance: m.balance,
            last_deposit_date: m.last_deposit,
            last_disbursement_date: m.last_disbursement,
            recent_entries: m.entries.slice(0, 10),
            flags,
          };
        });

        if (params.min_balance !== undefined) {
          matterResults = matterResults.filter(
            (m) => m.current_balance >= params.min_balance!
          );
        }

        const totalTrustHeld =
          Math.round(
            matterResults.reduce((s, m) => s + m.current_balance, 0) * 100
          ) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  summary: {
                    total_trust_held: totalTrustHeld,
                    active_trust_matters: matterResults.length,
                    low_balance_flags: lowBalanceCount,
                    dormant_flags: dormantCount,
                    trust_accounts: trustAccounts.map((a: any) => ({
                      id: a.id,
                      name: a.name,
                      balance: a.balance,
                    })),
                  },
                  matters: matterResults,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: err.message,
                status: err.response?.status,
                clio_error: err.response?.data,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ============================================================
  // get_ar_scorecard
  // ============================================================
  server.tool(
    "get_ar_scorecard",
    "EOS-scorecard AR metrics from live Clio. AR counts ONLY revenue_kind bills (fees for services rendered) in state=awaiting_payment; trust/retainer funding requests (trust_kind) are advance-deposit requests, not receivables, and are excluded from every AR/aging figure and reported separately. Returns compact weekly measurables — total AR, % and $ over 90 and over 120 days, over 60 days, # invoices 90+, # delinquent clients, oldest invoice age, avg days outstanding — plus a per-responsible-attorney breakdown (incl. 120+), the top 10 open balances, and a trust_requests summary (requested/funded/unfunded $, unfunded count, fund rate). ALSO splits AR into Gated vs. Non-Gated tracks by each matter's practice_area (firm_by_track): Gated = court-appointment work whose aging reflects court/estate timelines (Appointment, Guardianship, Guardianship Litigation, Mental Comm, Representative); Non-Gated = client-pay (the headline collections metric), which by firm policy includes Probate; Probate handling is configurable via probate_treatment (default 'non_gated'; 'separate' breaks it out as Semi-Gated, 'gated' folds it into Gated); Unclassified = matters with no practice_area (surfaced explicitly, never hidden). A reconciliation_ok flag confirms the tracks sum to firm.total_ar to the cent. Aging buckets: Current, 1-30, 31-60, 61-90, 91-120, 120+. ALSO maintains a standalone 'AR Scorecard.xlsx' in Box that auto-updates: an 'AR by Track' summary tab shows the tracks side by side (Gated, Non-Gated, Unclassified — the Semi-Gated/Probate column is not shown; Probate is folded per probate_treatment), a 'Weekly Scorecard' tab appends one row per run (week-over-week trend, incl. per-track and trust-request tracking columns), 'By Attorney', 'Top 10 Accounts' and 'Trust Requests' refresh to the current snapshot, two Gated-only tabs ('Gated by Attorney' and 'Gated by Matter', the latter grouping gated matters under each responsible attorney) break out the Gated track, and one DETAIL tab per responsible attorney lists their full matter×bill AR. Read-only against Clio; the only write is the AR Scorecard workbook (set update_workbook=false to skip it).",
    {
      as_of_date: z.string().optional().describe("As-of date for aging (YYYY-MM-DD, default today)"),
      update_workbook: z.boolean().optional().default(true).describe("Also update the AR Scorecard workbook in Box (default true). Set false for metrics-only."),
      probate_treatment: z.enum(["gated", "non_gated", "separate"]).optional().default("non_gated").describe("How to treat Probate AR. 'non_gated' (default): Probate is client-pay, folded into non_gated. 'gated': fold into gated. 'separate': break Probate out under semi_gated for review."),
    },
    async (params) => {
      try {
        const asOf = params.as_of_date ? new Date(params.as_of_date + "T00:00:00") : new Date();
        const asOfStr = asOf.toISOString().split("T")[0];

        // Pull open (awaiting_payment) bills for AR, plus paid bills so that funded
        // trust/retainer requests can be reported alongside the unfunded ones. The
        // matter sub-object form (client/responsible_attorney as full objects) is the
        // proven get_wip_report pattern; the deeper matters{…client{name}} form 400s.
        // The paid-bills fetch is only needed to mark trust requests funded; if it
        // fails, fall back to awaiting_payment only rather than failing the whole AR
        // scorecard (mirrors the resilient paid-bill fetch used elsewhere).
        const probateTreatment: ProbateTreatment = params.probate_treatment ?? "non_gated";

        const [awaitingBills, paidBills, allMatters] = await Promise.all([
          fetchAllPages<any>("/bills", { fields: SCORECARD_BILL_FIELDS, state: "awaiting_payment" }),
          fetchAllPages<any>("/bills", { fields: SCORECARD_BILL_FIELDS, state: "paid" }).catch((e: any) => {
            console.warn(`[get_ar_scorecard] paid-bills fetch failed (${e?.message ?? e}); funded trust requests will be incomplete`);
            return [] as any[];
          }),
          // Join key for the Gated/Non-Gated split. We need ALL matters (open
          // AND closed — closed matters still hold AR), so the `status` param is
          // OMITTED: Clio's /matters only accepts open|closed|pending and 400s on
          // status=all (which previously emptied this join and sent 100% of AR to
          // "unclassified"). Omitting status returns every status, matching the
          // get_matters tool's own "all" handling. If this fails, AR rows fall
          // back to "unclassified" rather than failing the whole scorecard.
          fetchAllPages<any>("/matters", { fields: SCORECARD_MATTER_FIELDS }).catch((e: any) => {
            console.warn(`[get_ar_scorecard] matters fetch failed (${e?.message ?? e}); AR will be reported as unclassified`);
            return [] as any[];
          }),
        ]);

        // matter_id → practice_area name (null when the matter has none). Clio
        // returns matter ids as numbers and bills carry the same numeric
        // matters[].id, so the Map<number> keys line up without coercion.
        const practiceAreaByMatter = new Map<number, string | null>();
        for (const m of allMatters) {
          if (m?.id != null) practiceAreaByMatter.set(m.id, m.practice_area?.name ?? null);
        }
        // Join-health diagnostic: empties here are the difference between a real
        // Gated/Non-Gated split and everything collapsing to "unclassified".
        const mattersWithPa = [...practiceAreaByMatter.values()].filter((v) => v != null).length;
        console.warn(`[get_ar_scorecard] matter→practice_area join: ${practiceAreaByMatter.size} matters, ${mattersWithPa} with a practice_area`);
        if (practiceAreaByMatter.size === 0) {
          console.warn(`[get_ar_scorecard] WARNING: empty matters join — all AR will classify as "unclassified"`);
        }

        const round2 = (n: number) => Math.round(n * 100) / 100;
        const bucketLabel = (d: number) =>
          d <= 0 ? "Current" : d <= 30 ? "1-30" : d <= 60 ? "31-60" : d <= 90 ? "61-90" : d <= 120 ? "91-120" : "120+";
        const daysOutstanding = (b: any) => {
          const due = b.due_at ? new Date(b.due_at) : (b.issued_at ? new Date(b.issued_at) : asOf);
          return Math.max(0, Math.floor((asOf.getTime() - due.getTime()) / 86400000));
        };
        // display_number already includes the matter name (e.g.
        // "02653-Lopez, Juan B. - Estate of"); only append description if it
        // adds something not already present.
        const matterLabel = (m: any) => {
          const dn = String(m?.display_number ?? "").trim();
          const desc = String(m?.description ?? "").trim();
          if (dn && desc && !dn.includes(desc)) return `${dn} — ${desc}`;
          return dn || desc || "—";
        };

        type Row = { balance: number; days: number; client: string; matter: string; attorney: string; bill: string; issued: string; due: string; bucket: string; track: TrackKey };
        const rows: Row[] = [];

        // --- AR rows: revenue_kind ONLY (whitelist). A trust_kind bill is a
        // trust/retainer funding request, not a receivable, and is captured below.
        // Any other (unexpected) kind is excluded from AR and surfaced via a warning
        // rather than silently summed into receivables. ---
        for (const b of awaitingBills) {
          if (b.kind === "trust_kind") continue; // captured below as a trust request
          if (b.kind !== "revenue_kind") {
            console.warn(`[get_ar_scorecard] excluding bill ${b.number ?? b.id} from AR — unexpected kind=${JSON.stringify(b.kind)}`);
            continue;
          }
          const bal = typeof b.balance === "number" ? b.balance : parseFloat(b.balance) || 0;
          if (bal <= 0) continue;
          const m = b.matters?.[0];
          const days = daysOutstanding(b);
          // Classify by the matter's practice area. Prefer the matters join
          // (covers closed matters); fall back to any practice_area embedded on
          // the bill's matter sub-object. probate_treatment may fold semi_gated.
          const paName =
            (m?.id != null && practiceAreaByMatter.has(m.id)
              ? practiceAreaByMatter.get(m.id)
              : m?.practice_area?.name) ?? null;
          rows.push({
            balance: bal,
            days,
            client: m?.client?.name ?? "Unknown",
            matter: matterLabel(m),
            attorney: m?.responsible_attorney?.name ?? "(Unassigned)",
            bill: String(b.number ?? b.id ?? ""),
            issued: b.issued_at ? String(b.issued_at).slice(0, 10) : "",
            due: b.due_at ? String(b.due_at).slice(0, 10) : "",
            bucket: bucketLabel(days),
            track: effectiveTrack(classifyTrack(paName), probateTreatment),
          });
        }

        // --- Trust requests: every trust_kind bill across awaiting_payment + paid.
        // These never touch any AR metric, the delinquent-client count, or the
        // oldest-invoice calc. Funded if balance is cleared (or state == paid). ---
        const trustRows: TrustRequestRow[] = [];
        for (const b of [...awaitingBills, ...paidBills]) {
          if (b.kind !== "trust_kind") continue;
          const m = b.matters?.[0];
          const requested = typeof b.total === "number" ? b.total : parseFloat(b.total) || 0;
          const balRaw = typeof b.balance === "number" ? b.balance : parseFloat(b.balance) || 0;
          const balance = Math.max(0, balRaw);
          const isFunded = balRaw <= 0 || b.state === "paid";
          trustRows.push({
            attorney: m?.responsible_attorney?.name ?? "(Unassigned)",
            client: m?.client?.name ?? b.client?.name ?? "Unknown",
            matter: matterLabel(m),
            bill: String(b.number ?? b.id ?? ""),
            issued: b.issued_at ? String(b.issued_at).slice(0, 10) : "",
            due: b.due_at ? String(b.due_at).slice(0, 10) : "",
            days: daysOutstanding(b),
            requested: round2(requested),
            balance: round2(balance),
            funded: round2(Math.max(0, requested - balance)),
            status: isFunded ? "Funded" : "Unfunded",
            dateFunded: isFunded && b.paid_at ? String(b.paid_at).slice(0, 10) : "",
          });
        }
        // Unfunded first, then by Days Outstanding descending.
        trustRows.sort((a, b) => {
          const rank = (s: string) => (s === "Unfunded" ? 0 : 1);
          return rank(a.status) - rank(b.status) || b.days - a.days;
        });

        const sum = (f: (r: Row) => boolean) => round2(rows.filter(f).reduce((s, r) => s + r.balance, 0));
        const totalAR = round2(rows.reduce((s, r) => s + r.balance, 0));
        const ar90 = sum((r) => r.days >= 91);
        const ar120 = sum((r) => r.days >= 121);
        const ar60 = sum((r) => r.days >= 61);
        const inv90 = rows.filter((r) => r.days >= 91).length;
        const clients = new Set(rows.map((r) => r.client)).size;
        const oldest = rows.reduce((mx, r) => Math.max(mx, r.days), 0);
        const avgDays = totalAR > 0 ? Math.round(rows.reduce((s, r) => s + r.days * r.balance, 0) / totalAR) : 0;
        const pct = (n: number) => (totalAR > 0 ? Math.round((n / totalAR) * 1000) / 10 : 0); // one-decimal %

        const firm = {
          as_of: asOfStr,
          total_ar: totalAR,
          current: sum((r) => r.days <= 0),
          days_1_30: sum((r) => r.days >= 1 && r.days <= 30),
          days_31_60: sum((r) => r.days >= 31 && r.days <= 60),
          days_61_90: sum((r) => r.days >= 61 && r.days <= 90),
          days_91_120: sum((r) => r.days >= 91 && r.days <= 120),
          ar_90plus: ar90,
          ar_90plus_pct: pct(ar90),
          ar_120plus: ar120,
          ar_120plus_pct: pct(ar120),
          ar_60plus: ar60,
          ar_60plus_pct: pct(ar60),
          invoices_90plus: inv90,
          delinquent_clients: clients,
          oldest_invoice_days: oldest,
          avg_days_outstanding: avgDays,
        };

        // ---- Gated vs. Non-Gated split (firm_by_track) ----
        // Every aging field is computed independently per track (pct against the
        // track's own total, never derived from the firm total).
        const trackRows: Record<TrackKey, Row[]> = { gated: [], semi_gated: [], non_gated: [], unclassified: [] };
        for (const r of rows) trackRows[r.track].push(r);

        const computeTrackMetrics = (tr: Row[]): TrackMetrics => {
          const ts = (f: (r: Row) => boolean) => round2(tr.filter(f).reduce((s, r) => s + r.balance, 0));
          const total = round2(tr.reduce((s, r) => s + r.balance, 0));
          const t90 = ts((r) => r.days >= 91);
          const t120 = ts((r) => r.days >= 121);
          const tpct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
          return {
            total_ar: total,
            current: ts((r) => r.days <= 0),
            days_1_30: ts((r) => r.days >= 1 && r.days <= 30),
            days_31_60: ts((r) => r.days >= 31 && r.days <= 60),
            days_61_90: ts((r) => r.days >= 61 && r.days <= 90),
            days_91_120: ts((r) => r.days >= 91 && r.days <= 120),
            ar_90plus: t90,
            ar_90plus_pct: tpct(t90),
            ar_120plus: t120,
            ar_120plus_pct: tpct(t120),
            invoices_90plus: tr.filter((r) => r.days >= 91).length,
            delinquent_clients: new Set(tr.map((r) => r.client)).size,
            oldest_invoice_days: tr.reduce((mx, r) => Math.max(mx, r.days), 0),
            avg_days_outstanding: total > 0 ? Math.round(tr.reduce((s, r) => s + r.days * r.balance, 0) / total) : 0,
            invoices: tr.length,
          };
        };

        // All four tracks are always computed (the workbook's per-track trend
        // columns track each one); semi_gated is only surfaced in the JSON when
        // probate_treatment is "separate".
        const trackMetrics: Record<TrackKey, TrackMetrics> = {
          gated: computeTrackMetrics(trackRows.gated),
          semi_gated: computeTrackMetrics(trackRows.semi_gated),
          non_gated: computeTrackMetrics(trackRows.non_gated),
          unclassified: computeTrackMetrics(trackRows.unclassified),
        };

        const firm_by_track: Record<string, TrackMetrics> = { gated: trackMetrics.gated };
        if (probateTreatment === "separate") firm_by_track.semi_gated = trackMetrics.semi_gated;
        firm_by_track.non_gated = trackMetrics.non_gated;
        firm_by_track.unclassified = trackMetrics.unclassified;

        // Reconciliation guardrail: the reported track totals must sum to
        // firm.total_ar to the cent. semi_gated rows always exist as their own
        // partition (folded into gated/non_gated when not separate), so the sum
        // of the four computed tracks is exact regardless of probate_treatment.
        const trackTotalSum = round2(
          trackMetrics.gated.total_ar +
            trackMetrics.semi_gated.total_ar +
            trackMetrics.non_gated.total_ar +
            trackMetrics.unclassified.total_ar
        );
        const reconciliation_delta = round2(trackTotalSum - firm.total_ar);
        const reconciliation_ok = Math.abs(reconciliation_delta) <= 0.01;
        if (!reconciliation_ok) {
          console.warn(`[get_ar_scorecard] RECONCILIATION FAILED: tracks sum ${trackTotalSum} != firm.total_ar ${firm.total_ar} (delta ${reconciliation_delta})`);
        }
        const reconciliation = {
          reconciliation_ok,
          track_total_sum: trackTotalSum,
          firm_total_ar: firm.total_ar,
          delta: reconciliation_delta,
          unclassified_total_ar: trackMetrics.unclassified.total_ar,
          unclassified_invoices: trackMetrics.unclassified.invoices,
        };

        // Per responsible attorney (with the 90+/120+ split)
        const byAttMap = new Map<string, { total: number; ar90: number; ar120: number; count: number }>();
        for (const r of rows) {
          const a = byAttMap.get(r.attorney) ?? { total: 0, ar90: 0, ar120: 0, count: 0 };
          a.total += r.balance;
          if (r.days >= 91) a.ar90 += r.balance;
          if (r.days >= 121) a.ar120 += r.balance;
          a.count += 1;
          byAttMap.set(r.attorney, a);
        }
        const byAttorney = [...byAttMap.entries()]
          .map(([attorney, v]) => ({
            attorney,
            total_ar: round2(v.total),
            ar_90plus: round2(v.ar90),
            ar_90plus_pct: v.total > 0 ? Math.round((v.ar90 / v.total) * 1000) / 10 : 0,
            ar_120plus: round2(v.ar120),
            ar_120plus_pct: v.total > 0 ? Math.round((v.ar120 / v.total) * 1000) / 10 : 0,
            invoices: v.count,
          }))
          .sort((a, b) => b.total_ar - a.total_ar);

        const top10 = [...rows]
          .sort((a, b) => b.balance - a.balance)
          .slice(0, 10)
          .map((r) => ({ client: r.client, matter: r.matter, attorney: r.attorney, balance: round2(r.balance), days_past_due: r.days, track: r.track }));

        // Full per-attorney bill detail (matter × bill) for the workbook tabs.
        const detail = byAttorney.map((a) => ({
          attorney: a.attorney,
          bills: rows
            .filter((r) => r.attorney === a.attorney)
            .sort((x, y) => y.balance - x.balance)
            .map((r) => ({ client: r.client, matter: r.matter, bill: r.bill, issued: r.issued, due: r.due, days_past_due: r.days, bucket: r.bucket, balance: round2(r.balance) })),
        }));

        // ---- Gated-only breakdowns (dedicated workbook tabs) ----
        // The Gated track is court-appointment work; partners want to see it on
        // its own, split by responsible attorney and (under each attorney) by
        // matter. trackRows.gated already reflects probate_treatment (Probate is
        // folded into Gated only when probate_treatment="gated").
        const gatedRows = trackRows.gated;
        const gatedAttMap = new Map<string, { total: number; ar90: number; ar120: number; count: number }>();
        for (const r of gatedRows) {
          const a = gatedAttMap.get(r.attorney) ?? { total: 0, ar90: 0, ar120: 0, count: 0 };
          a.total += r.balance;
          if (r.days >= 91) a.ar90 += r.balance;
          if (r.days >= 121) a.ar120 += r.balance;
          a.count += 1;
          gatedAttMap.set(r.attorney, a);
        }
        const gatedByAttorney = [...gatedAttMap.entries()]
          .map(([attorney, v]) => ({
            attorney,
            total_ar: round2(v.total),
            ar_90plus: round2(v.ar90),
            ar_90plus_pct: v.total > 0 ? Math.round((v.ar90 / v.total) * 1000) / 10 : 0,
            ar_120plus: round2(v.ar120),
            ar_120plus_pct: v.total > 0 ? Math.round((v.ar120 / v.total) * 1000) / 10 : 0,
            invoices: v.count,
          }))
          .sort((a, b) => b.total_ar - a.total_ar);

        // Per attorney → matter (matter-level summary rows under each attorney).
        const gatedByMatter = gatedByAttorney.map((a) => {
          const attRows = gatedRows.filter((r) => r.attorney === a.attorney);
          const matterMap = new Map<string, { client: string; total: number; ar90: number; ar120: number; count: number }>();
          for (const r of attRows) {
            const mm = matterMap.get(r.matter) ?? { client: r.client, total: 0, ar90: 0, ar120: 0, count: 0 };
            mm.total += r.balance;
            if (r.days >= 91) mm.ar90 += r.balance;
            if (r.days >= 121) mm.ar120 += r.balance;
            mm.count += 1;
            matterMap.set(r.matter, mm);
          }
          const matters = [...matterMap.entries()]
            .map(([matter, v]) => ({ matter, client: v.client, total_ar: round2(v.total), ar_90plus: round2(v.ar90), ar_120plus: round2(v.ar120), invoices: v.count }))
            .sort((x, y) => y.total_ar - x.total_ar);
          return { attorney: a.attorney, total_ar: a.total_ar, ar_90plus: a.ar_90plus, ar_120plus: a.ar_120plus, invoices: a.invoices, matters };
        });

        // ---- Trust request summary (parallel to `firm`; never mixed into AR) ----
        const trustRequested = round2(trustRows.reduce((s, r) => s + r.requested, 0));
        const trustUnfunded = round2(trustRows.reduce((s, r) => s + r.balance, 0));
        const trustFunded = round2(trustRequested - trustUnfunded);
        const trust: TrustSummary = {
          requested_total: trustRequested,
          funded_total: trustFunded,
          unfunded_total: trustUnfunded,
          unfunded_count: trustRows.filter((r) => r.status === "Unfunded").length,
          fund_rate_pct: trustRequested > 0 ? Math.round((trustFunded / trustRequested) * 1000) / 10 : 0,
        };

        // ---- Maintain the AR Scorecard workbook in Box ----
        let workbook_result: any = { skipped: true };
        if (params.update_workbook !== false) {
          try {
            workbook_result = await updateARScorecardWorkbook(firm, byAttorney, top10, detail, trust, trustRows, trackMetrics, probateTreatment, reconciliation, gatedByAttorney, gatedByMatter);
          } catch (e: any) {
            workbook_result = { error: e?.message ?? String(e) };
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ firm, firm_by_track, reconciliation_ok, reconciliation, probate_treatment: probateTreatment, trust_requests: trust, by_attorney: byAttorney, top_10_accounts: top10, workbook: workbook_result }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }) }],
          isError: true,
        };
      }
    }
  );
}

// ====================================================================
// AR Scorecard workbook — standalone, auto-updating Box file.
// Weekly Scorecard tab appends one row per as-of date (trend); By Attorney,
// Top 10 and Trust Requests tabs are refreshed to the current snapshot each run.
// Built fresh with ExcelJS (a brand-new file we fully control, so formatting is
// clean). AR tabs reflect revenue_kind bills only; Trust Requests holds the
// trust_kind funding requests that must never be counted as AR.
// ====================================================================
type FirmMetrics = {
  as_of: string; total_ar: number; current: number; days_1_30: number; days_31_60: number;
  days_61_90: number; days_91_120: number; ar_90plus: number; ar_90plus_pct: number;
  ar_120plus: number; ar_120plus_pct: number; ar_60plus: number;
  ar_60plus_pct: number; invoices_90plus: number; delinquent_clients: number;
  oldest_invoice_days: number; avg_days_outstanding: number;
};

// Per-track AR metrics (Gated / Semi-Gated / Non-Gated / Unclassified). Same
// aging schema as `firm` minus the 60+ fields, plus a plain invoice count so the
// unclassified bucket's size is always explicit.
type TrackMetrics = {
  total_ar: number; current: number; days_1_30: number; days_31_60: number;
  days_61_90: number; days_91_120: number; ar_90plus: number; ar_90plus_pct: number;
  ar_120plus: number; ar_120plus_pct: number; invoices_90plus: number;
  delinquent_clients: number; oldest_invoice_days: number; avg_days_outstanding: number;
  invoices: number;
};

type TrustSummary = {
  requested_total: number; funded_total: number; unfunded_total: number;
  unfunded_count: number; fund_rate_pct: number;
};
type TrustRequestRow = {
  attorney: string; client: string; matter: string; bill: string;
  issued: string; due: string; days: number;
  requested: number; balance: number; funded: number;
  status: "Funded" | "Unfunded"; dateFunded: string;
};

// Weekly trend row = firm AR metrics + trust-request tracking columns + the
// Gated/Non-Gated per-track tracking columns (appended to the right so the
// trend line follows both tracks over time). Trust and per-track figures are
// tracked alongside AR so they're visible week-over-week without ever being
// conflated with the firm headline.
type WeeklyRecord = FirmMetrics & {
  trust_outstanding: number; trust_unfunded_count: number;
  non_gated_total_ar: number; non_gated_ar90: number; non_gated_ar90_pct: number;
  gated_total_ar: number; gated_ar90: number; gated_ar90_pct: number;
  unclassified_total_ar: number;
};

const WEEKLY_COLS: Array<{ key: keyof WeeklyRecord; header: string; fmt?: string; width: number }> = [
  { key: "as_of", header: "As Of", width: 12 },
  { key: "total_ar", header: "Total AR", fmt: '"$"#,##0', width: 14 },
  { key: "ar_120plus", header: "120+ $", fmt: '"$"#,##0', width: 13 },
  { key: "ar_120plus_pct", header: "120+ %", fmt: '0.0"%"', width: 9 },
  { key: "ar_90plus", header: "90+ $", fmt: '"$"#,##0', width: 13 },
  { key: "ar_90plus_pct", header: "90+ %", fmt: '0.0"%"', width: 9 },
  { key: "ar_60plus", header: "60+ $", fmt: '"$"#,##0', width: 13 },
  { key: "ar_60plus_pct", header: "60+ %", fmt: '0.0"%"', width: 9 },
  { key: "current", header: "Current $", fmt: '"$"#,##0', width: 13 },
  { key: "invoices_90plus", header: "# Inv 90+", width: 10 },
  { key: "delinquent_clients", header: "# Clients", width: 10 },
  { key: "oldest_invoice_days", header: "Oldest (days)", width: 13 },
  { key: "avg_days_outstanding", header: "Avg Days O/S", width: 13 },
  { key: "trust_outstanding", header: "Trust Requests Outstanding ($)", fmt: '"$"#,##0', width: 28 },
  { key: "trust_unfunded_count", header: "Trust Requests Unfunded (#)", width: 26 },
  // --- Gated/Non-Gated per-track trend columns (appended to the right) ---
  { key: "non_gated_total_ar", header: "Non-Gated Total AR", fmt: '"$"#,##0', width: 18 },
  { key: "non_gated_ar90", header: "Non-Gated 90+ $", fmt: '"$"#,##0', width: 16 },
  { key: "non_gated_ar90_pct", header: "Non-Gated 90+ %", fmt: '0.0"%"', width: 16 },
  { key: "gated_total_ar", header: "Gated Total AR", fmt: '"$"#,##0', width: 16 },
  { key: "gated_ar90", header: "Gated 90+ $", fmt: '"$"#,##0', width: 14 },
  { key: "gated_ar90_pct", header: "Gated 90+ %", fmt: '0.0"%"', width: 14 },
  { key: "unclassified_total_ar", header: "Unclassified Total AR", fmt: '"$"#,##0', width: 20 },
];

type AttyDetail = { attorney: string; bills: Array<{ client: string; matter: string; bill: string; issued: string; due: string; days_past_due: number; bucket: string; balance: number }> };
// Gated-only breakdowns for the dedicated Gated tabs.
type GatedAttySummary = { attorney: string; total_ar: number; ar_90plus: number; ar_90plus_pct: number; ar_120plus: number; ar_120plus_pct: number; invoices: number };
type GatedMatterRow = { matter: string; client: string; total_ar: number; ar_90plus: number; ar_120plus: number; invoices: number };
type GatedByMatterGroup = { attorney: string; total_ar: number; ar_90plus: number; ar_120plus: number; invoices: number; matters: GatedMatterRow[] };
async function updateARScorecardWorkbook(
  firm: FirmMetrics,
  byAttorney: Array<{ attorney: string; total_ar: number; ar_90plus: number; ar_90plus_pct: number; ar_120plus: number; ar_120plus_pct: number; invoices: number }>,
  top10: Array<{ client: string; matter: string; attorney: string; balance: number; days_past_due: number; track: TrackKey }>,
  detail: AttyDetail[],
  trust: TrustSummary,
  trustRows: TrustRequestRow[],
  tracks: Record<TrackKey, TrackMetrics>,
  probateTreatment: ProbateTreatment,
  reconciliation: { reconciliation_ok: boolean; track_total_sum: number; firm_total_ar: number; delta: number; unclassified_total_ar: number; unclassified_invoices: number },
  gatedByAttorney: GatedAttySummary[],
  gatedByMatter: GatedByMatterGroup[],
): Promise<any> {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // 1. Read prior weekly history (if the file already exists).
  const existingId = await findBoxFileId(AR_SCORECARD_FOLDER, AR_SCORECARD_FILENAME);
  const history: Record<string, any>[] = [];
  if (existingId) {
    try {
      const buf = await downloadFromBox(existingId);
      const prev = new ExcelJS.Workbook();
      await prev.xlsx.load(buf as any);
      const ws = prev.getWorksheet("Weekly Scorecard");
      if (ws) {
        // Map prior columns by HEADER text (row 2), not position — so reordering
        // or adding columns can't mismap an existing week's values.
        const headerToCol: Record<string, number> = {};
        ws.getRow(2).eachCell((cell, col) => { const h = String(cell.value ?? "").trim(); if (h) headerToCol[h] = col; });
        const asOfCol = headerToCol["As Of"] ?? 1;
        ws.eachRow((row, n) => {
          if (n <= 2) return; // title + header
          const asOf = row.getCell(asOfCol).value;
          if (asOf == null || String(asOf).trim() === "") return;
          const rec: Record<string, any> = {};
          WEEKLY_COLS.forEach((c) => {
            const col = headerToCol[c.header];
            rec[c.key] = col ? row.getCell(col).value : (c.key === "as_of" ? "" : 0);
          });
          rec.as_of = String(asOf instanceof Date ? asOf.toISOString().split("T")[0] : asOf);
          history.push(rec);
        });
      }
    } catch { /* prior file unreadable — start fresh history */ }
  }
  // 2. Append/replace this run's row (dedupe by as_of). The weekly row carries
  // firm AR metrics plus the two trust-request tracking columns.
  const merged = history.filter((h) => h.as_of !== firm.as_of);
  const currentRecord: WeeklyRecord = {
    ...firm,
    trust_outstanding: trust.unfunded_total,
    trust_unfunded_count: trust.unfunded_count,
    non_gated_total_ar: tracks.non_gated.total_ar,
    non_gated_ar90: tracks.non_gated.ar_90plus,
    non_gated_ar90_pct: tracks.non_gated.ar_90plus_pct,
    gated_total_ar: tracks.gated.total_ar,
    gated_ar90: tracks.gated.ar_90plus,
    gated_ar90_pct: tracks.gated.ar_90plus_pct,
    unclassified_total_ar: tracks.unclassified.total_ar,
  };
  merged.push(currentRecord as any);
  merged.sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)));

  // 3. Build the workbook fresh.
  const wb = new ExcelJS.Workbook();
  wb.creator = "Clio MCP — AR Scorecard";
  const bold = { bold: true } as const;

  // ---- AR by Track (primary snapshot) ----
  // Added FIRST so the Gated/Non-Gated split is the first thing visible. Shows
  // the three (+ unclassified) tracks side by side with the full aging
  // breakdown, plus a reconciliation line proving the tracks sum to firm total.
  const moneyFmt2 = '"$"#,##0.00';
  const pctFmt = '0.0"%"';
  const trackSheet = wb.addWorksheet("AR by Track", { views: [{ state: "frozen" as const, ySplit: 3, xSplit: 1 }] });
  // The Semi-Gated (Probate) column is intentionally not shown. Probate AR is
  // folded into Gated/Non-Gated per probate_treatment (default Non-Gated); the
  // semi_gated partition is still computed internally for reconciliation and the
  // firm-total invoice count, just never rendered as its own column.
  const trackCols: Array<{ header: string; key: TrackKey | "firm" }> = [
    { header: "Gated", key: "gated" },
    { header: "Non-Gated (headline)", key: "non_gated" },
    { header: "Unclassified", key: "unclassified" },
    { header: "Firm Total", key: "firm" },
  ];
  trackSheet.mergeCells(1, 1, 1, trackCols.length + 1);
  trackSheet.getCell(1, 1).value = `AR by Track — as of ${firm.as_of}`;
  trackSheet.getCell(1, 1).font = { bold: true, size: 13 };
  trackSheet.mergeCells(2, 1, 2, trackCols.length + 1);
  trackSheet.getCell(2, 1).value =
    `Probate treatment: ${probateTreatment}.  Reconciliation: tracks sum ${reconciliation.track_total_sum.toFixed(2)} ` +
    `vs firm total ${reconciliation.firm_total_ar.toFixed(2)} (delta ${reconciliation.delta.toFixed(2)}) — ${reconciliation.reconciliation_ok ? "OK" : "MISMATCH"}.`;
  trackSheet.getCell(2, 1).font = { italic: true, color: reconciliation.reconciliation_ok ? { argb: "FF006100" } : { argb: "FF9C0006" } } as any;
  // Header row (row 3): metric label + one column per track.
  trackSheet.getColumn(1).width = 24;
  trackSheet.getCell(3, 1).value = "Metric"; trackSheet.getCell(3, 1).font = bold;
  trackCols.forEach((c, i) => { const cell = trackSheet.getCell(3, i + 2); cell.value = c.header; cell.font = bold; trackSheet.getColumn(i + 2).width = Math.max(16, c.header.length + 2); });

  const allInvoices = tracks.gated.invoices + tracks.semi_gated.invoices + tracks.non_gated.invoices + tracks.unclassified.invoices;
  const trackMetricRows: Array<{ label: string; key: keyof TrackMetrics; fmt?: string; firm: number }> = [
    { label: "Total AR", key: "total_ar", fmt: moneyFmt2, firm: firm.total_ar },
    { label: "Current", key: "current", fmt: moneyFmt2, firm: firm.current },
    { label: "1–30 days", key: "days_1_30", fmt: moneyFmt2, firm: firm.days_1_30 },
    { label: "31–60 days", key: "days_31_60", fmt: moneyFmt2, firm: firm.days_31_60 },
    { label: "61–90 days", key: "days_61_90", fmt: moneyFmt2, firm: firm.days_61_90 },
    { label: "91–120 days", key: "days_91_120", fmt: moneyFmt2, firm: firm.days_91_120 },
    { label: "90+ $", key: "ar_90plus", fmt: moneyFmt2, firm: firm.ar_90plus },
    { label: "90+ %", key: "ar_90plus_pct", fmt: pctFmt, firm: firm.ar_90plus_pct },
    { label: "120+ $", key: "ar_120plus", fmt: moneyFmt2, firm: firm.ar_120plus },
    { label: "120+ %", key: "ar_120plus_pct", fmt: pctFmt, firm: firm.ar_120plus_pct },
    { label: "# Invoices 90+", key: "invoices_90plus", firm: firm.invoices_90plus },
    { label: "# Delinquent Clients", key: "delinquent_clients", firm: firm.delinquent_clients },
    { label: "Oldest Invoice (days)", key: "oldest_invoice_days", firm: firm.oldest_invoice_days },
    { label: "Avg Days Outstanding", key: "avg_days_outstanding", firm: firm.avg_days_outstanding },
    { label: "# Invoices (total)", key: "invoices", firm: allInvoices },
  ];
  trackMetricRows.forEach((m, ri) => {
    const row = 4 + ri;
    const lbl = trackSheet.getCell(row, 1); lbl.value = m.label; lbl.font = bold;
    trackCols.forEach((c, ci) => {
      const cell = trackSheet.getCell(row, ci + 2);
      cell.value = c.key === "firm" ? m.firm : (tracks[c.key as TrackKey][m.key] as number);
      if (m.fmt) cell.numFmt = m.fmt;
      if (c.key === "firm") cell.font = bold;
    });
  });

  const weekly = wb.addWorksheet("Weekly Scorecard", { views: [{ state: "frozen" as const, ySplit: 2, xSplit: 1 }] });
  weekly.mergeCells(1, 1, 1, WEEKLY_COLS.length);
  weekly.getCell(1, 1).value = "AR Scorecard — Weekly (EOS)";
  weekly.getCell(1, 1).font = { bold: true, size: 13 };
  WEEKLY_COLS.forEach((c, i) => {
    const cell = weekly.getCell(2, i + 1);
    cell.value = c.header; cell.font = bold;
    weekly.getColumn(i + 1).width = c.width;
    if (c.fmt) weekly.getColumn(i + 1).numFmt = c.fmt;
  });
  merged.forEach((rec, ri) => {
    WEEKLY_COLS.forEach((c, i) => {
      const v = rec[c.key];
      weekly.getCell(3 + ri, i + 1).value = c.key === "as_of" ? String(v) : (typeof v === "number" ? v : Number(v) || 0);
    });
  });

  const att = wb.addWorksheet("By Attorney");
  att.getCell(1, 1).value = `By Responsible Attorney — as of ${firm.as_of}`;
  att.getCell(1, 1).font = { bold: true, size: 13 };
  const attHeaders = ["Attorney", "Total AR", "120+ $", "120+ %", "90+ $", "90+ %", "# Invoices"];
  const attFmt = ["", '"$"#,##0', '"$"#,##0', '0.0"%"', '"$"#,##0', '0.0"%"', ""];
  const attWidth = [26, 14, 13, 9, 13, 9, 11];
  attHeaders.forEach((h, i) => { const c = att.getCell(2, i + 1); c.value = h; c.font = bold; att.getColumn(i + 1).width = attWidth[i]; if (attFmt[i]) att.getColumn(i + 1).numFmt = attFmt[i]; });
  byAttorney.forEach((a, ri) => {
    att.getCell(3 + ri, 1).value = a.attorney;
    att.getCell(3 + ri, 2).value = a.total_ar;
    att.getCell(3 + ri, 3).value = a.ar_120plus;
    att.getCell(3 + ri, 4).value = a.ar_120plus_pct;
    att.getCell(3 + ri, 5).value = a.ar_90plus;
    att.getCell(3 + ri, 6).value = a.ar_90plus_pct;
    att.getCell(3 + ri, 7).value = a.invoices;
  });
  const totRow = 3 + byAttorney.length;
  att.getCell(totRow, 1).value = "Firm Total"; att.getCell(totRow, 1).font = bold;
  att.getCell(totRow, 2).value = firm.total_ar; att.getCell(totRow, 2).font = bold;
  att.getCell(totRow, 3).value = firm.ar_120plus; att.getCell(totRow, 3).font = bold;
  att.getCell(totRow, 4).value = firm.ar_120plus_pct; att.getCell(totRow, 4).font = bold;
  att.getCell(totRow, 5).value = firm.ar_90plus; att.getCell(totRow, 5).font = bold;
  att.getCell(totRow, 6).value = firm.ar_90plus_pct; att.getCell(totRow, 6).font = bold;

  // ---- Gated AR: by responsible attorney (summary) ----
  // Same shape as "By Attorney" but restricted to the Gated track, so partners
  // can see court-appointment AR per attorney without the client-pay noise.
  const gAtt = wb.addWorksheet("Gated by Attorney");
  gAtt.getCell(1, 1).value = `Gated AR by Responsible Attorney — as of ${firm.as_of}`;
  gAtt.getCell(1, 1).font = { bold: true, size: 13 };
  const gAttHeaders = ["Attorney", "Total AR", "120+ $", "120+ %", "90+ $", "90+ %", "# Invoices"];
  const gAttFmt = ["", '"$"#,##0', '"$"#,##0', '0.0"%"', '"$"#,##0', '0.0"%"', ""];
  const gAttWidth = [26, 14, 13, 9, 13, 9, 11];
  gAttHeaders.forEach((h, i) => { const c = gAtt.getCell(2, i + 1); c.value = h; c.font = bold; gAtt.getColumn(i + 1).width = gAttWidth[i]; if (gAttFmt[i]) gAtt.getColumn(i + 1).numFmt = gAttFmt[i]; });
  gatedByAttorney.forEach((a, ri) => {
    gAtt.getCell(3 + ri, 1).value = a.attorney;
    gAtt.getCell(3 + ri, 2).value = a.total_ar;
    gAtt.getCell(3 + ri, 3).value = a.ar_120plus;
    gAtt.getCell(3 + ri, 4).value = a.ar_120plus_pct;
    gAtt.getCell(3 + ri, 5).value = a.ar_90plus;
    gAtt.getCell(3 + ri, 6).value = a.ar_90plus_pct;
    gAtt.getCell(3 + ri, 7).value = a.invoices;
  });
  const gTotRow = 3 + gatedByAttorney.length;
  gAtt.getCell(gTotRow, 1).value = "Gated Total"; gAtt.getCell(gTotRow, 1).font = bold;
  gAtt.getCell(gTotRow, 2).value = tracks.gated.total_ar; gAtt.getCell(gTotRow, 2).font = bold;
  gAtt.getCell(gTotRow, 3).value = tracks.gated.ar_120plus; gAtt.getCell(gTotRow, 3).font = bold;
  gAtt.getCell(gTotRow, 4).value = tracks.gated.ar_120plus_pct; gAtt.getCell(gTotRow, 4).font = bold;
  gAtt.getCell(gTotRow, 5).value = tracks.gated.ar_90plus; gAtt.getCell(gTotRow, 5).font = bold;
  gAtt.getCell(gTotRow, 6).value = tracks.gated.ar_90plus_pct; gAtt.getCell(gTotRow, 6).font = bold;
  gAtt.getCell(gTotRow, 7).value = tracks.gated.invoices; gAtt.getCell(gTotRow, 7).font = bold;

  // ---- Gated AR: by responsible attorney → matter ----
  // Gated matters grouped under each responsible attorney (an attorney group
  // header, one summary row per matter, then an attorney subtotal). Matters and
  // attorneys are both ordered by gated AR exposure (largest first).
  const gMat = wb.addWorksheet("Gated by Matter", { views: [{ state: "frozen" as const, ySplit: 2 }] });
  const gMatHeaders = ["Client", "Matter", "# Invoices", "90+ $", "120+ $", "Total AR"];
  const gMatFmt = ["", "", "", '"$"#,##0.00', '"$"#,##0.00', '"$"#,##0.00'];
  const gMatWidth = [26, 44, 11, 14, 14, 14];
  gMat.mergeCells(1, 1, 1, gMatHeaders.length);
  gMat.getCell(1, 1).value = `Gated AR by Responsible Attorney → Matter — as of ${firm.as_of}`;
  gMat.getCell(1, 1).font = { bold: true, size: 13 };
  gMatHeaders.forEach((h, i) => { const c = gMat.getCell(2, i + 1); c.value = h; c.font = bold; gMat.getColumn(i + 1).width = gMatWidth[i]; if (gMatFmt[i]) gMat.getColumn(i + 1).numFmt = gMatFmt[i]; });
  let gmr = 3;
  for (const g of gatedByMatter) {
    if (!g.matters.length) continue;
    gMat.mergeCells(gmr, 1, gmr, gMatHeaders.length);
    const hc = gMat.getCell(gmr, 1);
    hc.value = `${g.attorney} — ${g.matters.length} matter(s) — $${g.total_ar.toFixed(2)}`;
    hc.font = bold;
    hc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } } as any;
    gmr++;
    for (const m of g.matters) {
      gMat.getCell(gmr, 1).value = m.client;
      gMat.getCell(gmr, 2).value = m.matter;
      gMat.getCell(gmr, 3).value = m.invoices;
      gMat.getCell(gmr, 4).value = m.ar_90plus;
      gMat.getCell(gmr, 5).value = m.ar_120plus;
      gMat.getCell(gmr, 6).value = m.total_ar;
      gmr++;
    }
    gMat.getCell(gmr, 2).value = `  Subtotal — ${g.attorney}`; gMat.getCell(gmr, 2).font = bold;
    gMat.getCell(gmr, 3).value = g.invoices; gMat.getCell(gmr, 3).font = bold;
    gMat.getCell(gmr, 4).value = g.ar_90plus; gMat.getCell(gmr, 4).font = bold;
    gMat.getCell(gmr, 5).value = g.ar_120plus; gMat.getCell(gmr, 5).font = bold;
    gMat.getCell(gmr, 6).value = g.total_ar; gMat.getCell(gmr, 6).font = bold;
    gmr++;
  }
  gMat.getCell(gmr, 1).value = "Gated Total"; gMat.getCell(gmr, 1).font = bold;
  gMat.getCell(gmr, 3).value = tracks.gated.invoices; gMat.getCell(gmr, 3).font = bold;
  gMat.getCell(gmr, 4).value = tracks.gated.ar_90plus; gMat.getCell(gmr, 4).font = bold;
  gMat.getCell(gmr, 5).value = tracks.gated.ar_120plus; gMat.getCell(gmr, 5).font = bold;
  gMat.getCell(gmr, 6).value = tracks.gated.total_ar; gMat.getCell(gmr, 6).font = bold;

  const top = wb.addWorksheet("Top 10 Accounts");
  top.getCell(1, 1).value = `Top 10 Open Balances — as of ${firm.as_of}`;
  top.getCell(1, 1).font = { bold: true, size: 13 };
  const topHeaders = ["Client", "Matter", "Responsible Attorney", "Balance", "Days Past Due", "Track"];
  const topWidth = [28, 36, 24, 14, 13, 14];
  topHeaders.forEach((h, i) => { const c = top.getCell(2, i + 1); c.value = h; c.font = bold; top.getColumn(i + 1).width = topWidth[i]; });
  top.getColumn(4).numFmt = '"$"#,##0';
  const trackLabel: Record<TrackKey, string> = { gated: "Gated", semi_gated: "Semi-Gated", non_gated: "Non-Gated", unclassified: "Unclassified" };
  top10.forEach((t, ri) => {
    top.getCell(3 + ri, 1).value = t.client;
    top.getCell(3 + ri, 2).value = t.matter;
    top.getCell(3 + ri, 3).value = t.attorney;
    top.getCell(3 + ri, 4).value = t.balance;
    top.getCell(3 + ri, 5).value = t.days_past_due;
    top.getCell(3 + ri, 6).value = trackLabel[t.track];
  });

  // ---- Trust Requests tab ----
  // trust_kind bills only — advance-deposit / retainer funding requests, NOT
  // accounts receivable. Reports funded vs. unfunded so the firm can chase
  // outstanding replenishment requests without polluting AR. Title (row 1),
  // summary block (rows 2–6), detail header (row 8, frozen), rows from 9.
  const trustWs = wb.addWorksheet("Trust Requests", { views: [{ state: "frozen" as const, ySplit: 8 }] });
  const trustHeaders = ["Responsible Attorney", "Client", "Matter", "Bill #", "Issued", "Due", "Days Outstanding", "Amount Requested", "Status", "Date Funded"];
  const trustWidth = [24, 26, 42, 10, 12, 12, 16, 16, 11, 12];
  const moneyFmt = '"$"#,##0.00';
  trustWs.mergeCells(1, 1, 1, trustHeaders.length);
  trustWs.getCell(1, 1).value = `Trust / Retainer Replenishment Requests — as of ${firm.as_of}`;
  trustWs.getCell(1, 1).font = { bold: true, size: 13 };
  const trustSummary: Array<{ label: string; value: number; fmt?: string }> = [
    { label: "Requests Sent", value: trustRows.length },
    { label: "Total Requested", value: trust.requested_total, fmt: moneyFmt },
    { label: "Funded", value: trust.funded_total, fmt: moneyFmt },
    { label: "Unfunded", value: trust.unfunded_total, fmt: moneyFmt },
    { label: "Fund Rate", value: trust.fund_rate_pct, fmt: '0.0"%"' },
  ];
  trustSummary.forEach((s, i) => {
    const lbl = trustWs.getCell(2 + i, 1); lbl.value = s.label; lbl.font = bold;
    const val = trustWs.getCell(2 + i, 2); val.value = s.value; if (s.fmt) val.numFmt = s.fmt;
  });
  trustHeaders.forEach((h, i) => { const c = trustWs.getCell(8, i + 1); c.value = h; c.font = bold; trustWs.getColumn(i + 1).width = trustWidth[i]; });
  trustWs.getColumn(8).numFmt = moneyFmt; // Amount Requested
  let trr = 9;
  for (const t of trustRows) {
    trustWs.getCell(trr, 1).value = t.attorney;
    trustWs.getCell(trr, 2).value = t.client;
    trustWs.getCell(trr, 3).value = t.matter;
    trustWs.getCell(trr, 4).value = t.bill;
    trustWs.getCell(trr, 5).value = t.issued;
    trustWs.getCell(trr, 6).value = t.due;
    trustWs.getCell(trr, 7).value = t.days;
    trustWs.getCell(trr, 8).value = t.requested;
    trustWs.getCell(trr, 9).value = t.status;
    trustWs.getCell(trr, 10).value = t.dateFunded;
    trr++;
  }
  trustWs.getCell(trr, 1).value = "Total"; trustWs.getCell(trr, 1).font = bold;
  trustWs.getCell(trr, 8).value = trust.requested_total; trustWs.getCell(trr, 8).font = bold;

  // Detail tabs per responsible attorney: TWO views each —
  //   "{Attorney}"            : every bill, largest balance first
  //   "{Attorney} by Matter"  : bills grouped/sorted by matter, with a subtotal
  //                             row per matter (total AR exposure per matter)
  const usedNames = new Set<string>();
  const sheetName = (name: string): string => {
    let base = (name || "Unknown").replace(/[:\\/?*\[\]]/g, "-").slice(0, 31).trim() || "Unknown";
    let candidate = base, i = 2;
    while (usedNames.has(candidate.toLowerCase())) { const suf = `~${i++}`; candidate = base.slice(0, 31 - suf.length) + suf; }
    usedNames.add(candidate.toLowerCase());
    return candidate;
  };
  const detHeaders = ["Client", "Matter", "Bill #", "Issued", "Due", "Days Past Due", "Bucket", "Balance"];
  const detWidth = [26, 42, 10, 12, 12, 13, 10, 14];
  type DetBill = AttyDetail["bills"][number];
  const writeDetailTab = (tabName: string, title: string, bills: DetBill[], groupByMatter: boolean) => {
    const ws = wb.addWorksheet(sheetName(tabName), { views: [{ state: "frozen" as const, ySplit: 2 }] });
    ws.mergeCells(1, 1, 1, detHeaders.length);
    ws.getCell(1, 1).value = title;
    ws.getCell(1, 1).font = { bold: true, size: 13 };
    detHeaders.forEach((h, i) => { const c = ws.getCell(2, i + 1); c.value = h; c.font = bold; ws.getColumn(i + 1).width = detWidth[i]; });
    ws.getColumn(8).numFmt = '"$"#,##0.00';
    let rr = 3;
    const writeBill = (b: DetBill) => {
      ws.getCell(rr, 1).value = b.client;
      ws.getCell(rr, 2).value = b.matter;
      ws.getCell(rr, 3).value = b.bill;
      ws.getCell(rr, 4).value = b.issued;
      ws.getCell(rr, 5).value = b.due;
      ws.getCell(rr, 6).value = b.days_past_due;
      ws.getCell(rr, 7).value = b.bucket;
      ws.getCell(rr, 8).value = b.balance;
      rr++;
    };
    if (groupByMatter) {
      let curMatter: string | null = null, matterSum = 0;
      const flush = () => {
        if (curMatter === null) return;
        ws.getCell(rr, 2).value = `  Subtotal — ${curMatter}`; ws.getCell(rr, 2).font = bold;
        ws.getCell(rr, 8).value = r2(matterSum); ws.getCell(rr, 8).font = bold;
        rr++;
      };
      for (const b of bills) {
        if (b.matter !== curMatter) { flush(); curMatter = b.matter; matterSum = 0; }
        writeBill(b);
        matterSum += b.balance;
      }
      flush();
    } else {
      for (const b of bills) writeBill(b);
    }
    ws.getCell(rr, 1).value = "Total"; ws.getCell(rr, 1).font = bold;
    ws.getCell(rr, 8).value = r2(bills.reduce((s, b) => s + b.balance, 0)); ws.getCell(rr, 8).font = bold;
  };
  for (const d of detail) {
    if (!d.bills.length) continue;
    const stamp = `as of ${firm.as_of} (${d.bills.length} bills)`;
    // By amount (bills arrive sorted largest-first from the caller).
    writeDetailTab(d.attorney, `AR Detail — ${d.attorney} — by amount — ${stamp}`, d.bills, false);
    // By matter: matters ordered by total amount due (summed balance) descending —
    // the matter with the largest AR exposure first. Bills of a matter are kept
    // contiguous (the subtotal logic depends on it; ties broken by matter name) and
    // largest bill first within a matter.
    const matterDue = new Map<string, number>();
    for (const b of d.bills) matterDue.set(b.matter, (matterDue.get(b.matter) ?? 0) + b.balance);
    const byMatter = [...d.bills].sort((a, b) =>
      (matterDue.get(b.matter)! - matterDue.get(a.matter)!) ||
      a.matter.localeCompare(b.matter) ||
      b.balance - a.balance
    );
    writeDetailTab(`${d.attorney} by Matter`, `AR Detail — ${d.attorney} — by matter — ${stamp}`, byMatter, true);
  }

  const out = Buffer.from(await wb.xlsx.writeBuffer());

  // 4. Version the existing file, or create it the first time.
  const result = existingId
    ? await uploadToBox({ buffer: out, filename: AR_SCORECARD_FILENAME, folderId: AR_SCORECARD_FOLDER, overwriteFileId: existingId })
    : await createBoxFile({ buffer: out, filename: AR_SCORECARD_FILENAME, folderId: AR_SCORECARD_FOLDER });

  return {
    created: !existingId,
    weeks_tracked: merged.length,
    ...(result.uploaded
      ? { uploaded: true, box_file_id: result.box_file_id, box_url: result.box_url }
      : { uploaded: false, direct_download_url: (result as any).direct_download_url, reason: (result as any).reason }),
  };
}
