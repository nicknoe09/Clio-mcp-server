import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import ExcelJS from "exceljs";
import { fetchAllPages } from "../clio/pagination";
import { uploadToBox, createBoxFile, findBoxFileId, downloadFromBox } from "../utils/box";

// Box folder that holds the firm's managed workbooks (same as the dashboard).
const AR_SCORECARD_FOLDER = "348313592902";
const AR_SCORECARD_FILENAME = "AR Scorecard.xlsx";

const BILL_FIELDS =
  "id,number,issued_at,due_at,balance,total,state,matters";

// trust_line_items has limited fields — use defaults + matter association
const TRUST_FIELDS = "id,date,total,matter{id,display_number,client}";

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
    "Full accounts receivable aging report. Groups outstanding invoices into buckets: Current (0-30), 31-60, 61-90, 91-120, 120+. Includes client emails for direct action.",
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
    "EOS-scorecard AR metrics from live Clio AR (state=awaiting_payment). Returns compact weekly measurables — total AR, % and $ over 90 and over 120 days, over 60 days, # invoices 90+, # delinquent clients, oldest invoice age, avg days outstanding — plus a per-responsible-attorney breakdown (incl. 120+) and the top 10 open balances. Aging buckets: Current, 1-30, 31-60, 61-90, 91-120, 120+. ALSO maintains a standalone 'AR Scorecard.xlsx' in Box that auto-updates: a 'Weekly Scorecard' tab appends one row per run (week-over-week trend), 'By Attorney' and 'Top 10 Accounts' refresh to the current snapshot, and one DETAIL tab per responsible attorney lists their full matter×bill AR (client, matter, bill #, issued, due, days past due, bucket, balance). Read-only against Clio; the only write is the AR Scorecard workbook (set update_workbook=false to skip it).",
    {
      as_of_date: z.string().optional().describe("As-of date for aging (YYYY-MM-DD, default today)"),
      update_workbook: z.boolean().optional().default(true).describe("Also update the AR Scorecard workbook in Box (default true). Set false for metrics-only."),
    },
    async (params) => {
      try {
        const asOf = params.as_of_date ? new Date(params.as_of_date + "T00:00:00") : new Date();
        const asOfStr = asOf.toISOString().split("T")[0];
        const bills = await fetchAllPages<any>("/bills", {
          // Request matter sub-objects WITHOUT deeper {name} nesting — Clio
          // returns client/responsible_attorney as full objects (with .name).
          // Bare `matters` omits client/responsible_attorney (everything came
          // back Unknown/Unassigned); the deep form matters{…client{name}} 400s.
          // This middle form is the proven get_wip_report pattern.
          fields: "id,number,issued_at,due_at,balance,total,state,matters{id,display_number,description,client,responsible_attorney}",
          state: "awaiting_payment",
        });

        const round2 = (n: number) => Math.round(n * 100) / 100;
        const bucketLabel = (d: number) =>
          d <= 0 ? "Current" : d <= 30 ? "1-30" : d <= 60 ? "31-60" : d <= 90 ? "61-90" : d <= 120 ? "91-120" : "120+";
        type Row = { balance: number; days: number; client: string; matter: string; attorney: string; bill: string; issued: string; due: string; bucket: string };
        const rows: Row[] = [];
        for (const b of bills) {
          const bal = typeof b.balance === "number" ? b.balance : parseFloat(b.balance) || 0;
          if (bal <= 0) continue;
          const due = b.due_at ? new Date(b.due_at) : (b.issued_at ? new Date(b.issued_at) : asOf);
          const days = Math.max(0, Math.floor((asOf.getTime() - due.getTime()) / 86400000));
          const m = b.matters?.[0];
          rows.push({
            balance: bal,
            days,
            client: m?.client?.name ?? "Unknown",
            // display_number already includes the matter name (e.g.
            // "02653-Lopez, Juan B. - Estate of"); only append description if it
            // adds something not already present.
            matter: (() => {
              const dn = String(m?.display_number ?? "").trim();
              const desc = String(m?.description ?? "").trim();
              if (dn && desc && !dn.includes(desc)) return `${dn} — ${desc}`;
              return dn || desc || "—";
            })(),
            attorney: m?.responsible_attorney?.name ?? "(Unassigned)",
            bill: String(b.number ?? b.id ?? ""),
            issued: b.issued_at ? String(b.issued_at).slice(0, 10) : "",
            due: b.due_at ? String(b.due_at).slice(0, 10) : "",
            bucket: bucketLabel(days),
          });
        }

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
          .map((r) => ({ client: r.client, matter: r.matter, attorney: r.attorney, balance: round2(r.balance), days_past_due: r.days }));

        // Full per-attorney bill detail (matter × bill) for the workbook tabs.
        const detail = byAttorney.map((a) => ({
          attorney: a.attorney,
          bills: rows
            .filter((r) => r.attorney === a.attorney)
            .sort((x, y) => y.balance - x.balance)
            .map((r) => ({ client: r.client, matter: r.matter, bill: r.bill, issued: r.issued, due: r.due, days_past_due: r.days, bucket: r.bucket, balance: round2(r.balance) })),
        }));

        // ---- Maintain the AR Scorecard workbook in Box ----
        let workbook_result: any = { skipped: true };
        if (params.update_workbook !== false) {
          try {
            workbook_result = await updateARScorecardWorkbook(firm, byAttorney, top10, detail);
          } catch (e: any) {
            workbook_result = { error: e?.message ?? String(e) };
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ firm, by_attorney: byAttorney, top_10_accounts: top10, workbook: workbook_result }, null, 2) }],
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
// Weekly Scorecard tab appends one row per as-of date (trend); By Attorney
// and Top 10 tabs are refreshed to the current snapshot each run. Built fresh
// with ExcelJS (a brand-new file we fully control, so formatting is clean).
// ====================================================================
type FirmMetrics = {
  as_of: string; total_ar: number; current: number; days_1_30: number; days_31_60: number;
  days_61_90: number; days_91_120: number; ar_90plus: number; ar_90plus_pct: number;
  ar_120plus: number; ar_120plus_pct: number; ar_60plus: number;
  ar_60plus_pct: number; invoices_90plus: number; delinquent_clients: number;
  oldest_invoice_days: number; avg_days_outstanding: number;
};

const WEEKLY_COLS: Array<{ key: keyof FirmMetrics; header: string; fmt?: string; width: number }> = [
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
];

type AttyDetail = { attorney: string; bills: Array<{ client: string; matter: string; bill: string; issued: string; due: string; days_past_due: number; bucket: string; balance: number }> };
async function updateARScorecardWorkbook(
  firm: FirmMetrics,
  byAttorney: Array<{ attorney: string; total_ar: number; ar_90plus: number; ar_90plus_pct: number; ar_120plus: number; ar_120plus_pct: number; invoices: number }>,
  top10: Array<{ client: string; matter: string; attorney: string; balance: number; days_past_due: number }>,
  detail: AttyDetail[],
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
  // 2. Append/replace this run's row (dedupe by as_of).
  const merged = history.filter((h) => h.as_of !== firm.as_of);
  merged.push(firm as any);
  merged.sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)));

  // 3. Build the workbook fresh.
  const wb = new ExcelJS.Workbook();
  wb.creator = "Clio MCP — AR Scorecard";
  const bold = { bold: true } as const;

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

  const top = wb.addWorksheet("Top 10 Accounts");
  top.getCell(1, 1).value = `Top 10 Open Balances — as of ${firm.as_of}`;
  top.getCell(1, 1).font = { bold: true, size: 13 };
  const topHeaders = ["Client", "Matter", "Responsible Attorney", "Balance", "Days Past Due"];
  const topWidth = [28, 36, 24, 14, 13];
  topHeaders.forEach((h, i) => { const c = top.getCell(2, i + 1); c.value = h; c.font = bold; top.getColumn(i + 1).width = topWidth[i]; });
  top.getColumn(4).numFmt = '"$"#,##0';
  top10.forEach((t, ri) => {
    top.getCell(3 + ri, 1).value = t.client;
    top.getCell(3 + ri, 2).value = t.matter;
    top.getCell(3 + ri, 3).value = t.attorney;
    top.getCell(3 + ri, 4).value = t.balance;
    top.getCell(3 + ri, 5).value = t.days_past_due;
  });

  // One detail tab per responsible attorney: the full matter × bill list.
  const usedNames = new Set<string>();
  const sheetName = (name: string): string => {
    let base = (name || "Unknown").replace(/[:\\/?*\[\]]/g, "-").slice(0, 28).trim() || "Unknown";
    let candidate = base, i = 2;
    while (usedNames.has(candidate.toLowerCase())) candidate = `${base.slice(0, 25)}~${i++}`;
    usedNames.add(candidate.toLowerCase());
    return candidate;
  };
  const detHeaders = ["Client", "Matter", "Bill #", "Issued", "Due", "Days Past Due", "Bucket", "Balance"];
  const detWidth = [26, 42, 10, 12, 12, 13, 10, 14];
  for (const d of detail) {
    if (!d.bills.length) continue;
    const ws = wb.addWorksheet(sheetName(d.attorney), { views: [{ state: "frozen" as const, ySplit: 2 }] });
    ws.mergeCells(1, 1, 1, detHeaders.length);
    ws.getCell(1, 1).value = `AR Detail — ${d.attorney} — as of ${firm.as_of} (${d.bills.length} bills)`;
    ws.getCell(1, 1).font = { bold: true, size: 13 };
    detHeaders.forEach((h, i) => { const c = ws.getCell(2, i + 1); c.value = h; c.font = bold; ws.getColumn(i + 1).width = detWidth[i]; });
    ws.getColumn(8).numFmt = '"$"#,##0.00';
    d.bills.forEach((b, ri) => {
      const rr = 3 + ri;
      ws.getCell(rr, 1).value = b.client;
      ws.getCell(rr, 2).value = b.matter;
      ws.getCell(rr, 3).value = b.bill;
      ws.getCell(rr, 4).value = b.issued;
      ws.getCell(rr, 5).value = b.due;
      ws.getCell(rr, 6).value = b.days_past_due;
      ws.getCell(rr, 7).value = b.bucket;
      ws.getCell(rr, 8).value = b.balance;
    });
    const tr = 3 + d.bills.length;
    ws.getCell(tr, 1).value = "Total"; ws.getCell(tr, 1).font = bold;
    ws.getCell(tr, 8).value = r2(d.bills.reduce((s, b) => s + b.balance, 0)); ws.getCell(tr, 8).font = bold;
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
