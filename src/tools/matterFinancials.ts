import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle } from "../clio/pagination";

const MATTER_FIELDS =
  "id,display_number,description,status,open_date,billing_method,responsible_attorney{id,name},client{id,name},practice_area{name}";

// trust_line_items has limited fields per Clio — id/date/total only, no description/type
const TRUST_FIELDS = "id,date,total,matter{id,display_number,client}";

// bill{id,state} lets us bucket activities into truly unbilled vs. draft-billed.
// Clio leaves activities flagged billed=false until a bill is *issued*, so an
// entry can be on a draft bill and still come back from billed=false queries.
const TIME_FIELDS =
  "id,date,quantity,rounded_quantity,price,note,user{id,name},bill{id,state}";

const EXPENSE_FIELDS = "id,date,price,note,user{id,name},bill{id,state}";

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
    "Per-matter financial snapshot: trust balance (from the client's funds_in_trust), WIP split into truly-unbilled vs draft-billed, and outstanding invoices (AR). Mirrors the WIP/Draft/AR breakdown shown on the Clio matter dashboard.",
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

        // Pull the matter first so we can use the client id to fetch the
        // authoritative trust balance (Clio holds trust per-contact, not per-matter).
        const matterRes = await rawGetSingle(`/matters/${matterId}`, {
          fields: MATTER_FIELDS,
        });
        const matter = matterRes.data;
        const clientId = matter?.client?.id;

        // Trust balance has multiple candidate sources because Clio doesn't
        // expose a single canonical per-matter balance:
        //   1. contact.pending_funds_in_trust — typical Clio UI source
        //   2. contact.funds_in_trust — alternate field name
        //   3. sum of /trust_line_items?contact_id=X — net of all client
        //      transactions; captures bill-payment disbursements that the
        //      ?matter_id=X scope misses (those are tagged to the bill, which
        //      lives under the contact, not the matter).
        // We fetch all three and pick the first one that returns a value.
        const clientPromise: Promise<any> = clientId
          ? rawGetSingle(`/contacts/${clientId}`, {
              fields: "id,name,pending_funds_in_trust,funds_in_trust",
            }).catch(() => null)
          : Promise.resolve(null);

        const trustPromise = fetchAllPages<any>("/trust_line_items", {
          matter_id: matterId,
          fields: TRUST_FIELDS,
        });

        const contactTrustLedgerPromise: Promise<any[]> = clientId
          ? fetchAllPages<any>("/trust_line_items", {
              contact_id: clientId,
              fields: TRUST_FIELDS,
            }).catch(() => [])
          : Promise.resolve([]);

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

        // Pull draft bills separately so we can report Clio's "Draft" total
        // (which reflects bill total after any write-downs/discounts, not the
        // raw activity sum).
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
          clientRes,
          trustEntries,
          contactTrustEntries,
          timeEntries,
          expenseEntries,
          draftBills,
          outstandingBills,
        ] = await Promise.all([
          clientPromise,
          trustPromise,
          contactTrustLedgerPromise,
          timePromise,
          expensePromise,
          draftBillsPromise,
          outstandingBillsPromise,
        ]);

        const today = new Date();

        // --- Trust ---
        // Pick the first source that returns a value:
        //   1. contact.pending_funds_in_trust
        //   2. contact.funds_in_trust
        //   3. sum of trust_line_items by contact_id (captures disbursements)
        const contactData = clientRes?.data ?? null;
        const pendingFunds =
          typeof contactData?.pending_funds_in_trust === "number"
            ? contactData.pending_funds_in_trust
            : null;
        const fundsInTrust =
          typeof contactData?.funds_in_trust === "number"
            ? contactData.funds_in_trust
            : null;
        const contactLedgerSum = contactTrustEntries.length
          ? contactTrustEntries.reduce(
              (s: number, e: any) => s + (e.total || 0),
              0
            )
          : null;

        let clientFundsInTrust: number | null = null;
        let trustBalanceSource: string | null = null;
        if (pendingFunds !== null) {
          clientFundsInTrust = pendingFunds;
          trustBalanceSource = "contacts.pending_funds_in_trust";
        } else if (fundsInTrust !== null) {
          clientFundsInTrust = fundsInTrust;
          trustBalanceSource = "contacts.funds_in_trust";
        } else if (contactLedgerSum !== null) {
          clientFundsInTrust = contactLedgerSum;
          trustBalanceSource = "trust_line_items.sum_by_contact_id";
        }

        let lastDeposit: string | null = null;
        let lastDisbursement: string | null = null;
        const sortedTrust = [...trustEntries].sort((a: any, b: any) =>
          (b.date || "").localeCompare(a.date || "")
        );
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
        if (clientFundsInTrust !== null && clientFundsInTrust < 500) {
          trustFlags.push("LOW_BALANCE");
        }
        if (trustDormancyDays !== null && trustDormancyDays > 90) trustFlags.push("DORMANT");

        // --- WIP buckets ---
        // bill === null  → truly unbilled (Clio's "Unbilled" number)
        // bill.state === "draft" → on a draft bill (Clio's "Draft" number — but
        //   we use the bill total below, not the raw activity sum, because
        //   draft bills can include write-downs/discounts).
        // Other bill states → already on an issued bill; ignore (shouldn't
        //   normally appear under billed=false but we defensively skip).
        let unbilledHours = 0;
        let unbilledTimeValue = 0;
        let oldestUnbilledDate: string | null = null;

        const unbilledTimeDetail: any[] = [];
        for (const e of timeEntries) {
          const onBill = e.bill?.id != null;
          if (onBill) continue;
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
          const onBill = e.bill?.id != null;
          if (onBill) continue;
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

        // Draft bills — sum the bill totals (post write-downs).
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

        // Combined WIP = unbilled + draft (matches Clio's matter dashboard "Work in Progress")
        const combinedWip = unbilledTotal + draftBillTotal;

        const wipDaysSinceOldest = oldestUnbilledDate
          ? daysBetween(today, new Date(oldestUnbilledDate))
          : null;

        const wipFlags: string[] = [];
        if (wipDaysSinceOldest !== null && wipDaysSinceOldest > 60) wipFlags.push("RED");
        else if (wipDaysSinceOldest !== null && wipDaysSinceOldest > 30) wipFlags.push("YELLOW");

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

        const trustBalanceForTotals = clientFundsInTrust ?? 0;
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
            // Clio holds trust against the client (contact), not the matter,
            // so this is the client's net trust balance — accurate even when
            // the client has multiple matters with this firm.
            balance: clientFundsInTrust !== null ? round2(clientFundsInTrust) : null,
            balance_scope: "client",
            balance_source: trustBalanceSource,
            // Diagnostic: the candidate values we considered, so we can see
            // which Clio fields are populated for this account.
            balance_candidates: {
              pending_funds_in_trust:
                pendingFunds !== null ? round2(pendingFunds) : null,
              funds_in_trust: fundsInTrust !== null ? round2(fundsInTrust) : null,
              contact_ledger_sum:
                contactLedgerSum !== null ? round2(contactLedgerSum) : null,
            },
            client_id: clientId ?? null,
            ledger_entry_count: trustEntries.length,
            contact_ledger_entry_count: contactTrustEntries.length,
            last_deposit_date: lastDeposit,
            last_disbursement_date: lastDisbursement,
            last_activity_date: lastTrustActivity,
            days_since_last_activity: trustDormancyDays,
            flags: trustFlags,
            recent_entries: recentTrust,
          },
          wip: {
            // Truly unbilled (no bill association)
            unbilled_hours: round2(unbilledHours),
            unbilled_time_value: round2(unbilledTimeValue),
            unbilled_expenses: round2(unbilledExpenses),
            unbilled_total: round2(unbilledTotal),
            // On draft bills (sum of bill totals, post write-down)
            draft_bill_count: draftBills.length,
            draft_bill_total: round2(draftBillTotal),
            draft_bills: draftBillSummary,
            // Combined — matches Clio's matter-dashboard "Work in Progress"
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
            trust_balance: clientFundsInTrust !== null ? round2(trustBalanceForTotals) : null,
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
