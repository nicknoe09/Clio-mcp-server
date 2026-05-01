import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle } from "../clio/pagination";

const MATTER_FIELDS =
  "id,display_number,description,status,open_date,billing_method,responsible_attorney{id,name},client{id,name},practice_area{name}";

// trust_line_items has limited fields per Clio — id/date/total only, no description/type
const TRUST_FIELDS = "id,date,total,matter{id,display_number,client}";

const TIME_FIELDS =
  "id,date,quantity,rounded_quantity,price,note,user{id,name}";

const EXPENSE_FIELDS = "id,date,price,note,user{id,name}";

const BILL_FIELDS =
  "id,number,issued_at,due_at,balance,total,state";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

export function registerMatterFinancialsTools(server: McpServer): void {
  server.tool(
    "get_matter_financial_summary",
    "Per-matter financial snapshot: trust balance, recent trust activity, unbilled time and expenses (WIP), and outstanding invoices (AR). Use this when you need to see the full financial picture for a single matter.",
    {
      matter_id: z.coerce.number().describe("Clio matter ID"),
      trust_history_limit: z
        .number()
        .optional()
        .default(10)
        .describe("Max number of recent trust ledger entries to include (default 10)"),
      include_unbilled_detail: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include individual unbilled time/expense entries (default false — totals only)"),
    },
    async (params) => {
      try {
        const matterId = params.matter_id;

        const matterPromise = rawGetSingle(`/matters/${matterId}`, {
          fields: MATTER_FIELDS,
        });

        const trustPromise = fetchAllPages<any>("/trust_line_items", {
          matter_id: matterId,
          fields: TRUST_FIELDS,
        });

        const timePromise = fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          billed: false,
          matter_id: matterId,
          fields: TIME_FIELDS,
        });

        const expensePromise = fetchAllPages<any>("/activities", {
          type: "ExpenseEntry",
          billed: false,
          matter_id: matterId,
          fields: EXPENSE_FIELDS,
        });

        const billsPromise = fetchAllPages<any>("/bills", {
          matter_id: matterId,
          state: "awaiting_payment",
          fields: BILL_FIELDS,
        });

        const [matterRes, trustEntries, timeEntries, expenseEntries, outstandingBills] =
          await Promise.all([
            matterPromise,
            trustPromise,
            timePromise,
            expensePromise,
            billsPromise,
          ]);

        const matter = matterRes.data;
        const today = new Date();

        // --- Trust ---
        let trustBalance = 0;
        let lastDeposit: string | null = null;
        let lastDisbursement: string | null = null;
        const sortedTrust = [...trustEntries].sort((a: any, b: any) =>
          (b.date || "").localeCompare(a.date || "")
        );
        for (const entry of sortedTrust) {
          const amount = entry.total || 0;
          trustBalance += amount;
          if (amount > 0 && !lastDeposit) lastDeposit = entry.date;
          if (amount < 0 && !lastDisbursement) lastDisbursement = entry.date;
        }
        const lastTrustActivity = sortedTrust[0]?.date ?? null;
        const trustDormancyDays = lastTrustActivity
          ? daysBetween(today, new Date(lastTrustActivity))
          : null;

        const trustFlags: string[] = [];
        if (trustBalance < 500) trustFlags.push("LOW_BALANCE");
        if (trustDormancyDays !== null && trustDormancyDays > 90) trustFlags.push("DORMANT");

        // --- WIP (unbilled time + expenses) ---
        let unbilledHours = 0;
        let unbilledTimeValue = 0;
        let oldestEntryDate: string | null = null;

        const timeDetail: any[] = [];
        for (const e of timeEntries) {
          const hours = (e.rounded_quantity ?? e.quantity ?? 0) / 3600;
          const value = hours * (e.price || 0);
          unbilledHours += hours;
          unbilledTimeValue += value;
          if (!oldestEntryDate || (e.date && e.date < oldestEntryDate)) {
            oldestEntryDate = e.date;
          }
          if (params.include_unbilled_detail) {
            timeDetail.push({
              id: e.id,
              date: e.date,
              hours: round2(hours),
              rate: e.price,
              amount: round2(value),
              description: e.note,
              timekeeper: e.user,
            });
          }
        }

        let unbilledExpenses = 0;
        const expenseDetail: any[] = [];
        for (const e of expenseEntries) {
          unbilledExpenses += e.price || 0;
          if (!oldestEntryDate || (e.date && e.date < oldestEntryDate)) {
            oldestEntryDate = e.date;
          }
          if (params.include_unbilled_detail) {
            expenseDetail.push({
              id: e.id,
              date: e.date,
              amount: round2(e.price || 0),
              description: e.note,
              user: e.user,
            });
          }
        }

        const wipDaysSinceOldest = oldestEntryDate
          ? daysBetween(today, new Date(oldestEntryDate))
          : null;

        const wipFlags: string[] = [];
        if (wipDaysSinceOldest !== null && wipDaysSinceOldest > 60) wipFlags.push("RED");
        else if (wipDaysSinceOldest !== null && wipDaysSinceOldest > 30) wipFlags.push("YELLOW");

        const combinedWip = unbilledTimeValue + unbilledExpenses;

        // --- AR (outstanding bills for this matter) ---
        let arBalance = 0;
        let oldestDueDate: string | null = null;
        const outstanding = outstandingBills.map((b: any) => {
          const balance = b.balance || 0;
          arBalance += balance;
          const dueRef = b.due_at || b.issued_at;
          if (dueRef && (!oldestDueDate || dueRef < oldestDueDate)) {
            oldestDueDate = dueRef;
          }
          const dueDate = dueRef ? new Date(dueRef) : null;
          const daysOutstanding = dueDate ? Math.max(daysBetween(today, dueDate), 0) : null;
          return {
            bill_id: b.id,
            bill_number: b.number,
            issued_at: b.issued_at,
            due_at: b.due_at,
            total: b.total,
            balance: round2(balance),
            days_outstanding: daysOutstanding,
            state: b.state,
          };
        });
        outstanding.sort((a: any, b: any) => (b.days_outstanding ?? 0) - (a.days_outstanding ?? 0));

        const oldestArDays = oldestDueDate
          ? Math.max(daysBetween(today, new Date(oldestDueDate)), 0)
          : null;

        const arFlags: string[] = [];
        if (oldestArDays !== null && oldestArDays > 90) arFlags.push("OVER_90");
        else if (oldestArDays !== null && oldestArDays > 60) arFlags.push("OVER_60");
        else if (oldestArDays !== null && oldestArDays > 30) arFlags.push("OVER_30");

        // --- Recent trust activity (limited) ---
        const limit = Math.max(0, params.trust_history_limit ?? 10);
        const recentTrust = sortedTrust.slice(0, limit).map((e: any) => ({
          id: e.id,
          date: e.date,
          amount: round2(e.total || 0),
        }));

        const totalExposure = round2(combinedWip + arBalance);

        const result: any = {
          matter: {
            id: matter?.id,
            display_number: matter?.display_number,
            description: matter?.description,
            status: matter?.status,
            client: matter?.client,
            responsible_attorney: matter?.responsible_attorney,
            practice_area: matter?.practice_area,
            billing_method: matter?.billing_method,
            open_date: matter?.open_date,
          },
          trust: {
            balance: round2(trustBalance),
            entry_count: trustEntries.length,
            last_deposit_date: lastDeposit,
            last_disbursement_date: lastDisbursement,
            last_activity_date: lastTrustActivity,
            days_since_last_activity: trustDormancyDays,
            flags: trustFlags,
            recent_entries: recentTrust,
          },
          wip: {
            unbilled_hours: round2(unbilledHours),
            unbilled_time_value: round2(unbilledTimeValue),
            unbilled_expenses: round2(unbilledExpenses),
            combined_wip_value: round2(combinedWip),
            time_entry_count: timeEntries.length,
            expense_entry_count: expenseEntries.length,
            oldest_entry_date: oldestEntryDate,
            days_since_oldest_entry: wipDaysSinceOldest,
            flags: wipFlags,
          },
          ar: {
            balance: round2(arBalance),
            outstanding_bill_count: outstanding.length,
            oldest_outstanding_due_date: oldestDueDate,
            oldest_outstanding_days: oldestArDays,
            flags: arFlags,
            outstanding_bills: outstanding,
          },
          totals: {
            trust_balance: round2(trustBalance),
            wip_value: round2(combinedWip),
            ar_balance: round2(arBalance),
            wip_plus_ar: totalExposure,
          },
        };

        if (params.include_unbilled_detail) {
          result.wip.unbilled_time_entries = timeDetail;
          result.wip.unbilled_expense_entries = expenseDetail;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
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
