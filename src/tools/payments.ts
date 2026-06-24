// ============================================================
// Payment-level tool: get_payments.
//
// Fills the gap left by get_bills (which only exposes bill-level paid/outstanding
// TOTALS) and the Fee Allocation report (current-state collections only). Each row
// from Clio's /allocations endpoint is ONE payment (or credit) applied to ONE bill:
// the queryable per-payment record. A single client payment split across several
// bills shows up as several allocation rows sharing the same parent `payment.id`.
//
// Voids/reversals: when a payment is voided in Clio its allocations are reversed,
// which surfaces here as reversing rows (negative `amount`) and/or a distinct
// allocation `type`. Pass include_reversals=false to drop non-positive rows when you
// only want money that actually landed.
//
// Trust-side cash movement (IOLTA deposits/withdrawals) is a SEPARATE surface — see
// get_matter_financial_summary / get_trust_balances, which read /bank_transactions.
// ============================================================
import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";

// Conservative, high-confidence field set. If Clio rejects a field it returns a 400
// naming the offending field; the catch block surfaces that as `clio_error` so the
// set can be trimmed without guesswork (same approach as debug_bill_fields).
const ALLOCATION_FIELDS =
  "id,date,amount,type,bill{id,number,state}," +
  "matter{id,display_number},contact{id,name},payment{id,date,amount}";

export function registerPaymentTools(server: McpServer): void {
  server.tool(
    "get_payments",
    "Query INDIVIDUAL payments/credits applied to bills (Clio allocations) — the per-payment detail get_bills doesn't expose. Each row is one payment applied to one bill, with `amount`, `date`, `type`, the `bill`/`matter`/`contact`, and the parent `payment` (one client payment split across bills shares a `payment.id`). Filter by matter, contact, bill, or date range. Voided/reversed payments surface as reversing rows (negative `amount`); set include_reversals=false to drop them.",
    {
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      contact_id: z.coerce.number().optional().describe("Filter by contact/client ID"),
      bill_id: z.coerce.number().optional().describe("Filter to allocations against a single bill ID"),
      start_date: z.string().optional().describe("Only allocations dated on/after this date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("Only allocations dated on/before this date (YYYY-MM-DD)"),
      include_reversals: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include reversing/voided rows (non-positive amounts). Default true."),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: ALLOCATION_FIELDS,
          order: "date(desc)",
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.contact_id) queryParams.contact_id = params.contact_id;
        if (params.bill_id) queryParams.bill_id = params.bill_id;

        let allocations = await fetchAllPages<any>("/allocations", queryParams);

        // Date range filtered client-side on the allocation `date` (mirrors get_expenses):
        // avoids depending on a server-side date param whose name varies by resource.
        if (params.start_date) allocations = allocations.filter((a: any) => a.date >= params.start_date!);
        if (params.end_date) allocations = allocations.filter((a: any) => a.date <= params.end_date!);
        if (params.include_reversals === false) allocations = allocations.filter((a: any) => (a.amount ?? 0) > 0);

        const formatted = allocations.map((a: any) => ({
          id: a.id,
          date: a.date,
          amount: a.amount,
          type: a.type ?? null,
          is_reversal: (a.amount ?? 0) < 0,
          bill: a.bill ? { id: a.bill.id, number: a.bill.number ?? null, state: a.bill.state ?? null } : null,
          matter: a.matter ?? null,
          contact: a.contact ?? null,
          payment: a.payment ? { id: a.payment.id, date: a.payment.date ?? null, amount: a.payment.amount ?? null } : null,
        }));

        const total = Math.round(
          formatted.reduce((s: number, a: any) => s + (a.amount || 0), 0) * 100
        ) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { count: formatted.length, total_amount: total, payments: formatted },
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
