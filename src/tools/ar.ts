import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";

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
            "id,date,quantity,price,matter{id,display_number,description,client,responsible_attorney}",
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
          const hours = e.quantity / 3600;
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
}
