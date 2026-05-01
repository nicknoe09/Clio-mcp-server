import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle } from "../clio/pagination";

const MATTER_FIELDS =
  "id,display_number,description,status,open_date,billing_method,responsible_attorney{id,name},client{id,name},practice_area{name}";

// Per Clio's documented trust_line_item resource: id, etag, date, total,
// note, created_at, updated_at, plus relations bill / matter / client.
// (No `description`, no `type`, no `subject`, no `transaction`.)
const TRUST_FIELDS =
  "id,date,total,note,bill{id},matter{id,display_number,client}";

const TIME_FIELDS =
  "id,date,quantity,rounded_quantity,price,note,user{id,name},bill{id,state}";

const EXPENSE_FIELDS = "id,date,price,note,user{id,name},bill{id,state}";

const BILL_FIELDS = "id,number,issued_at,due_at,balance,total,state";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

export function registerMatterFinancialsTools(server: McpServer): void {
  server.tool(
    "get_matter_financial_summary",
    "Per-matter financial snapshot: trust balance (matter-tagged deposits net of bill-tagged disbursements), WIP split into truly-unbilled vs draft-billed, and outstanding invoices (AR). Matches the Clio matter dashboard.",
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

        const matterRes = await rawGetSingle(`/matters/${matterId}`, {
          fields: MATTER_FIELDS,
        });
        const matter = matterRes.data;
        const clientId = matter?.client?.id;

        // Fetch the matter's bills first because the per-matter trust
        // balance is computed from matter-tagged deposits PLUS bill-tagged
        // disbursements — we need the full bill list to fan out trust
        // queries by bill_id (the only documented bill linkage filter on
        // /trust_line_items).
        const allMatterBills = await fetchAllPages<any>("/bills", {
          matter_id: matterId,
          fields: "id,state",
        });
        const matterBillIds: number[] = allMatterBills
          .map((b: any) => b.id)
          .filter((id: any): id is number => typeof id === "number");

        const trustByMatterPromise = fetchAllPages<any>("/trust_line_items", {
          matter_id: matterId,
          fields: TRUST_FIELDS,
        });

        // One query per bill — Clio's documented filter is bill_id (single
        // value), so we fan out and dedupe on the way back. .catch returns
        // [] so a single bad bill doesn't drop the whole report.
        const trustByBillPromises = matterBillIds.map((billId) =>
          fetchAllPages<any>("/trust_line_items", {
            bill_id: billId,
            fields: TRUST_FIELDS,
          }).catch(() => [] as any[])
        );

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

        const draftBillsPromise = fetchAllPages<any>("/bills", {
          matter_id: matterId,
          state: "draft",
          fields: BILL_FIELDS,
        });

        const outstandingBillsPromise = fetchAllPages<any>("/bills", {
          matter_id: matterId,
          state: "awaiting_payment",
          fields: BILL_FIELDS,
        });

        const [
          trustByMatterEntries,
          trustByBillResults,
          timeEntries,
          expenseEntries,
          draftBills,
          outstandingBills,
        ] = await Promise.all([
          trustByMatterPromise,
          Promise.all(trustByBillPromises),
          timePromise,
          expensePromise,
          draftBillsPromise,
          outstandingBillsPromise,
        ]);

        const today = new Date();

        // --- Trust ---
        // Union the matter-tagged ledger (deposits and any matter-direct
        // disbursements) with bill-tagged entries (disbursements paid from
        // trust against this matter's bills). Dedupe by id since an entry
        // could in theory carry both linkages.
        const seenTrustIds = new Set<number>();
        const allTrustEntries: any[] = [];
        for (const e of [...trustByMatterEntries, ...trustByBillResults.flat()]) {
          if (e?.id != null && !seenTrustIds.has(e.id)) {
            seenTrustIds.add(e.id);
            allTrustEntries.push(e);
          }
        }

        const trustBalance = allTrustEntries.reduce(
          (s: number, e: any) => s + (e.total || 0),
          0
        );

        const matterTaggedSum = trustByMatterEntries.reduce(
          (s: number, e: any) => s + (e.total || 0),
          0
        );
        const billTaggedEntries = trustByBillResults
          .flat()
          .filter((e: any) => !trustByMatterEntries.some((m: any) => m.id === e.id));
        const billTaggedSum = billTaggedEntries.reduce(
          (s: number, e: any) => s + (e.total || 0),
          0
        );

        const sortedTrust = [...allTrustEntries].sort((a: any, b: any) =>
          (b.date || "").localeCompare(a.date || "")
        );

        let lastDeposit: string | null = null;
        let lastDisbursement: string | null = null;
        for (const entry of sortedTrust) {
          const amount = entry.total || 0;
          if (amount > 0 && !lastDeposit) lastDeposit = entry.date;
          if (amount < 0 && !lastDisbursement) lastDisbursement = entry.date;
        }
        const lastTrustActivity = sortedTrust[0]?.date ?? null;
        const trustDormancyDays = lastTrustActivity
          ? daysBetween(today, new Date(lastTrustActivity))
          : null;

        const trustFlags: string[] = [];
        if (trustBalance < 500) trustFlags.push("LOW_BALANCE");
        if (trustDormancyDays !== null && trustDormancyDays > 90) {
          trustFlags.push("DORMANT");
        }

        const limit = Math.max(0, params.trust_history_limit ?? 10);
        const recentTrust = sortedTrust.slice(0, limit).map((e: any) => ({
          id: e.id,
          date: e.date,
          amount: round2(e.total || 0),
          note: e.note ?? null,
          bill_id: e.bill?.id ?? null,
        }));

        // --- WIP buckets ---
        // bill === null → truly unbilled; bill.state === "draft" → on a
        // draft bill (Clio's "Draft" total reflects the bill total post-
        // write-down, not the raw activity sum, so we fetch draft bills
        // separately and use their `total` instead of summing activities).
        let unbilledHours = 0;
        let unbilledTimeValue = 0;
        let oldestUnbilledDate: string | null = null;
        const unbilledTimeDetail: any[] = [];
        for (const e of timeEntries) {
          if (e.bill?.id != null) continue;
          const hours = (e.rounded_quantity ?? e.quantity ?? 0) / 3600;
          const value = hours * (e.price || 0);
          unbilledHours += hours;
          unbilledTimeValue += value;
          if (!oldestUnbilledDate || (e.date && e.date < oldestUnbilledDate)) {
            oldestUnbilledDate = e.date;
          }
          if (params.include_unbilled_detail) {
            unbilledTimeDetail.push({
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
        const unbilledExpenseDetail: any[] = [];
        for (const e of expenseEntries) {
          if (e.bill?.id != null) continue;
          unbilledExpenses += e.price || 0;
          if (!oldestUnbilledDate || (e.date && e.date < oldestUnbilledDate)) {
            oldestUnbilledDate = e.date;
          }
          if (params.include_unbilled_detail) {
            unbilledExpenseDetail.push({
              id: e.id,
              date: e.date,
              amount: round2(e.price || 0),
              description: e.note,
              user: e.user,
            });
          }
        }

        const unbilledTotal = unbilledTimeValue + unbilledExpenses;

        const draftBillTotal = draftBills.reduce(
          (s: number, b: any) => s + (b.total || 0),
          0
        );
        const draftBillSummary = draftBills.map((b: any) => ({
          bill_id: b.id,
          bill_number: b.number,
          total: round2(b.total || 0),
          balance: round2(b.balance || 0),
        }));

        const combinedWip = unbilledTotal + draftBillTotal;

        const wipDaysSinceOldest = oldestUnbilledDate
          ? daysBetween(today, new Date(oldestUnbilledDate))
          : null;
        const wipFlags: string[] = [];
        if (wipDaysSinceOldest !== null && wipDaysSinceOldest > 60) wipFlags.push("RED");
        else if (wipDaysSinceOldest !== null && wipDaysSinceOldest > 30) wipFlags.push("YELLOW");

        // --- AR ---
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
          const daysOutstanding = dueDate
            ? Math.max(daysBetween(today, dueDate), 0)
            : null;
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
        outstanding.sort(
          (a: any, b: any) => (b.days_outstanding ?? 0) - (a.days_outstanding ?? 0)
        );

        const oldestArDays = oldestDueDate
          ? Math.max(daysBetween(today, new Date(oldestDueDate)), 0)
          : null;
        const arFlags: string[] = [];
        if (oldestArDays !== null && oldestArDays > 90) arFlags.push("OVER_90");
        else if (oldestArDays !== null && oldestArDays > 60) arFlags.push("OVER_60");
        else if (oldestArDays !== null && oldestArDays > 30) arFlags.push("OVER_30");

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
            balance_scope: "matter",
            balance_source: "trust_line_items.matter_id_union_bill_id",
            client_id: clientId ?? null,
            matter_bill_count: matterBillIds.length,
            matter_tagged_entry_count: trustByMatterEntries.length,
            matter_tagged_sum: round2(matterTaggedSum),
            bill_tagged_entry_count: billTaggedEntries.length,
            bill_tagged_sum: round2(billTaggedSum),
            total_entry_count: allTrustEntries.length,
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
            unbilled_total: round2(unbilledTotal),
            draft_bill_count: draftBills.length,
            draft_bill_total: round2(draftBillTotal),
            draft_bills: draftBillSummary,
            combined_wip_value: round2(combinedWip),
            time_entry_count: timeEntries.length,
            expense_entry_count: expenseEntries.length,
            oldest_unbilled_entry_date: oldestUnbilledDate,
            days_since_oldest_unbilled: wipDaysSinceOldest,
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
          result.wip.unbilled_time_entries = unbilledTimeDetail;
          result.wip.unbilled_expense_entries = unbilledExpenseDetail;
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
