import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";
import { jaccardSimilarity, hasTokenOverlap, normalizeText } from "../utils/normalize";

const TransactionSchema = z.object({
  date: z.string().describe("Transaction date (YYYY-MM-DD)"),
  amount: z.coerce.number().describe("Transaction amount"),
  description: z.string().describe("Transaction description"),
  merchant: z.string().describe("Merchant name"),
});

type Transaction = z.infer<typeof TransactionSchema>;

interface ClioExpense {
  id: number;
  date: string;
  price: number;
  note: string | null;
  category: string | null;
  matter: any;
  user: any;
}

type MatchType = "EXACT" | "LIKELY" | "POSSIBLE" | "UNMATCHED";

interface Match {
  transaction: Transaction;
  expense: ClioExpense | null;
  match_type: MatchType;
  confidence: number;
  notes?: string;
}

export function registerReconcileTools(server: McpServer): void {
  server.tool(
    "reconcile_statement",
    "Match bank/card transactions against Clio expense records. Uses multi-tier fuzzy matching with normalized merchant comparison.",
    {
      transactions: z
        .array(TransactionSchema)
        .describe("Array of bank/card transactions to reconcile"),
      start_date: z
        .string()
        .optional()
        .describe("Start date to search Clio expenses (YYYY-MM-DD)"),
      end_date: z
        .string()
        .optional()
        .describe("End date to search Clio expenses (YYYY-MM-DD)"),
      amount_tolerance: z
        .number()
        .optional()
        .default(1.0)
        .describe("Amount tolerance for matching (default $1.00)"),
      date_tolerance_days: z
        .number()
        .optional()
        .default(5)
        .describe("Date tolerance in days for matching (default 5)"),
    },
    async (params) => {
      try {
        // Determine date range
        let startDate = params.start_date;
        let endDate = params.end_date;

        if (!startDate || !endDate) {
          const dates = params.transactions.map((t) => t.date).sort();
          if (!startDate && dates.length > 0) {
            const d = new Date(dates[0]);
            d.setDate(d.getDate() - params.date_tolerance_days);
            startDate = d.toISOString().split("T")[0];
          }
          if (!endDate && dates.length > 0) {
            const d = new Date(dates[dates.length - 1]);
            d.setDate(d.getDate() + params.date_tolerance_days);
            endDate = d.toISOString().split("T")[0];
          }
        }

        // Fetch Clio expenses in the window
        const queryParams: Record<string, any> = {
          type: "ExpenseEntry",
          fields:
            "id,date,price,note,matter{id,display_number,client},user{id,name},expense_category{name}",
        };
        if (startDate) queryParams.created_since = `${startDate}T00:00:00+00:00`;

        let rawExpenses = await fetchAllPages<any>("/activities", queryParams);
        if (startDate) rawExpenses = rawExpenses.filter((e: any) => e.date >= startDate);
        if (endDate) rawExpenses = rawExpenses.filter((e: any) => e.date <= endDate);
        const clioExpenses: ClioExpense[] = rawExpenses.map((e: any) => ({
          id: e.id,
          date: e.date,
          price: e.price || 0,
          note: e.note,
          category: e.expense_category?.name ?? null,
          matter: e.matter,
          user: e.user,
        }));

        const matches: Match[] = [];
        const matchedExpenseIds = new Set<number>();

        for (const txn of params.transactions) {
          let bestMatch: Match = {
            transaction: txn,
            expense: null,
            match_type: "UNMATCHED",
            confidence: 0,
          };

          for (const exp of clioExpenses) {
            if (matchedExpenseIds.has(exp.id)) continue;

            // Amount check
            const amountDiff = Math.abs(txn.amount - exp.price);
            const amountMatch = amountDiff <= params.amount_tolerance;
            const amountClose =
              amountDiff <= Math.abs(txn.amount) * 0.05;

            // Date check
            const txnDate = new Date(txn.date);
            const expDate = new Date(exp.date);
            const daysDiff = Math.abs(
              Math.floor(
                (txnDate.getTime() - expDate.getTime()) /
                  (1000 * 60 * 60 * 24)
              )
            );
            const dateMatch = daysDiff <= params.date_tolerance_days;

            // Text similarity — combine merchant + description for matching
            const txnText = `${txn.merchant} ${txn.description}`;
            const expText = `${exp.note ?? ""} ${exp.category ?? ""}`;
            const similarity = jaccardSimilarity(txnText, expText);
            const overlap = hasTokenOverlap(txnText, expText);

            // Tier matching
            if (amountMatch && dateMatch && similarity > 0.8) {
              // EXACT
              if (bestMatch.match_type !== "EXACT" || similarity > bestMatch.confidence) {
                bestMatch = {
                  transaction: txn,
                  expense: exp,
                  match_type: "EXACT",
                  confidence: Math.round(similarity * 100) / 100,
                  notes: `Amount diff: $${amountDiff.toFixed(2)}, Date diff: ${daysDiff}d`,
                };
              }
            } else if (
              amountMatch &&
              similarity > 0.5 &&
              bestMatch.match_type !== "EXACT"
            ) {
              // LIKELY
              if (
                bestMatch.match_type !== "LIKELY" ||
                similarity > bestMatch.confidence
              ) {
                bestMatch = {
                  transaction: txn,
                  expense: exp,
                  match_type: "LIKELY",
                  confidence: Math.round(similarity * 100) / 100,
                  notes: `Amount diff: $${amountDiff.toFixed(2)}, Date diff: ${daysDiff}d`,
                };
              }
            } else if (
              amountClose &&
              overlap &&
              bestMatch.match_type !== "EXACT" &&
              bestMatch.match_type !== "LIKELY"
            ) {
              // POSSIBLE
              if (
                bestMatch.match_type !== "POSSIBLE" ||
                similarity > bestMatch.confidence
              ) {
                bestMatch = {
                  transaction: txn,
                  expense: exp,
                  match_type: "POSSIBLE",
                  confidence: Math.round(similarity * 100) / 100,
                  notes: `Amount diff: $${amountDiff.toFixed(2)}, Date diff: ${daysDiff}d, weak text match`,
                };
              }
            }
          }

          if (bestMatch.expense) {
            matchedExpenseIds.add(bestMatch.expense.id);
          }
          matches.push(bestMatch);
        }

        // Compute summary
        const matched = matches.filter((m) => m.match_type !== "UNMATCHED");
        const unmatched = matches.filter(
          (m) => m.match_type === "UNMATCHED"
        );

        const totalStmt = params.transactions.reduce(
          (s, t) => s + t.amount,
          0
        );
        const totalMatched = matched.reduce(
          (s, m) => s + m.transaction.amount,
          0
        );
        const totalUnmatched = unmatched.reduce(
          (s, m) => s + m.transaction.amount,
          0
        );
        const totalClioInWindow = clioExpenses.reduce(
          (s, e) => s + e.price,
          0
        );

        const matchCounts = {
          exact: matches.filter((m) => m.match_type === "EXACT").length,
          likely: matches.filter((m) => m.match_type === "LIKELY").length,
          possible: matches.filter(
            (m) => m.match_type === "POSSIBLE"
          ).length,
          unmatched: unmatched.length,
        };

        // Unmatched Clio expenses
        const unmatchedClioExpenses = clioExpenses.filter(
          (e) => !matchedExpenseIds.has(e.id)
        );

        // Group by matter
        const byMatter: Record<
          number,
          {
            matter_id: number;
            matter_name: string;
            matched_amount: number;
            unmatched_clio_amount: number;
          }
        > = {};

        for (const m of matched) {
          if (!m.expense?.matter?.id) continue;
          const mid = m.expense.matter.id;
          if (!byMatter[mid]) {
            byMatter[mid] = {
              matter_id: mid,
              matter_name:
                m.expense.matter.display_number ?? "Unknown",
              matched_amount: 0,
              unmatched_clio_amount: 0,
            };
          }
          byMatter[mid].matched_amount += m.transaction.amount;
        }

        for (const e of unmatchedClioExpenses) {
          if (!e.matter?.id) continue;
          const mid = e.matter.id;
          if (!byMatter[mid]) {
            byMatter[mid] = {
              matter_id: mid,
              matter_name: e.matter.display_number ?? "Unknown",
              matched_amount: 0,
              unmatched_clio_amount: 0,
            };
          }
          byMatter[mid].unmatched_clio_amount += e.price;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  summary: {
                    total_statement_amount:
                      Math.round(totalStmt * 100) / 100,
                    total_matched_amount:
                      Math.round(totalMatched * 100) / 100,
                    total_unmatched_amount:
                      Math.round(totalUnmatched * 100) / 100,
                    total_clio_expenses_in_window:
                      Math.round(totalClioInWindow * 100) / 100,
                    variance:
                      Math.round(
                        (totalStmt - totalClioInWindow) * 100
                      ) / 100,
                    match_counts: matchCounts,
                  },
                  matches: matches.filter(
                    (m) => m.match_type !== "UNMATCHED"
                  ),
                  unmatched_transactions: unmatched.map(
                    (m) => m.transaction
                  ),
                  unmatched_clio_expenses: unmatchedClioExpenses,
                  by_matter: Object.values(byMatter).map((m) => ({
                    ...m,
                    matched_amount:
                      Math.round(m.matched_amount * 100) / 100,
                    unmatched_clio_amount:
                      Math.round(m.unmatched_clio_amount * 100) / 100,
                  })),
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
