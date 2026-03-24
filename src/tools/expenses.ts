import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";

const EXPENSE_FIELDS =
  "id,date,price,note,type,billed,matter{id,display_number,client},user{id,name},expense_category{name}";

export function registerExpenseTools(server: McpServer): void {
  // get_expenses
  server.tool(
    "get_expenses",
    "Get expense entries with optional filters",
    {
      matter_id: z.number().optional().describe("Filter by matter ID"),
      user_id: z.number().optional().describe("Filter by user ID"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      billed: z
        .enum(["true", "false", "all"])
        .optional()
        .default("all")
        .describe("Filter by billed status"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          type: "ExpenseEntry",
          fields: EXPENSE_FIELDS,
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.user_id) queryParams.user_id = params.user_id;
        if (params.start_date) queryParams.created_since = `${params.start_date}T00:00:00+00:00`;
        if (params.billed !== "all") queryParams.billed = params.billed === "true";

        let entries = await fetchAllPages<any>("/activities", queryParams);
        if (params.start_date) entries = entries.filter((e: any) => e.date >= params.start_date);
        if (params.end_date) entries = entries.filter((e: any) => e.date <= params.end_date);

        const formatted = entries.map((e: any) => ({
          id: e.id,
          date: e.date,
          amount: e.price,
          category: e.expense_category?.name ?? null,
          description: e.note,
          billed: e.billed,
          matter: e.matter,
          user: e.user,
        }));

        const total = Math.round(
          formatted.reduce((s: number, e: any) => s + (e.amount || 0), 0) * 100
        ) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { count: formatted.length, total_amount: total, expenses: formatted },
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

  // get_unbilled_expenses
  server.tool(
    "get_unbilled_expenses",
    "Get all unbilled expenses grouped by matter with totals",
    {
      matter_id: z.number().optional().describe("Filter by matter ID"),
      user_id: z.number().optional().describe("Filter by user ID"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          type: "ExpenseEntry",
          billed: false,
          fields: EXPENSE_FIELDS,
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.user_id) queryParams.user_id = params.user_id;

        const entries = await fetchAllPages<any>("/activities", queryParams);

        const byMatter: Record<
          number,
          { matter: any; expenses: any[]; total: number }
        > = {};

        for (const e of entries) {
          const mid = e.matter?.id ?? 0;
          if (!byMatter[mid]) {
            byMatter[mid] = { matter: e.matter, expenses: [], total: 0 };
          }
          byMatter[mid].expenses.push({
            id: e.id,
            date: e.date,
            amount: e.price,
            category: e.expense_category?.name ?? null,
            description: e.note,
            user: e.user,
          });
          byMatter[mid].total += e.price || 0;
        }

        const matterGroups = Object.values(byMatter).map((g) => ({
          matter: g.matter,
          expense_count: g.expenses.length,
          total: Math.round(g.total * 100) / 100,
          expenses: g.expenses,
        }));

        matterGroups.sort((a, b) => b.total - a.total);

        const firmTotal =
          Math.round(matterGroups.reduce((s, g) => s + g.total, 0) * 100) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  firm_total: firmTotal,
                  total_entries: entries.length,
                  matter_count: matterGroups.length,
                  by_matter: matterGroups,
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
