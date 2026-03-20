import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";
import { getClioClient } from "../clio/client";
import { withBackoff } from "../clio/rateLimit";

const MATTER_FIELDS =
  "id,display_number,description,status,open_date,billing_method,responsible_attorney{id,name},client{id,name},practice_area{name}";

export function registerMatterTools(server: McpServer): void {
  // get_matters
  server.tool(
    "get_matters",
    "List all matters with optional filters for status, responsible attorney, and client",
    {
      status: z
        .enum(["open", "closed", "all"])
        .optional()
        .default("open")
        .describe("Filter by matter status"),
      responsible_attorney_id: z
        .number()
        .optional()
        .describe("Filter by responsible attorney ID"),
      client_id: z.number().optional().describe("Filter by client ID"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: MATTER_FIELDS,
        };
        if (params.status !== "all") {
          queryParams.status = params.status;
        }
        if (params.responsible_attorney_id) {
          queryParams.responsible_attorney_id = params.responsible_attorney_id;
        }
        if (params.client_id) {
          queryParams.client_id = params.client_id;
        }

        const matters = await fetchAllPages<any>("/matters", queryParams);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { count: matters.length, matters },
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

  // get_matter
  server.tool(
    "get_matter",
    "Get a single matter by ID or search by query string",
    {
      matter_id: z.number().optional().describe("Clio matter ID"),
      search_query: z
        .string()
        .optional()
        .describe("Search query (matter name or number)"),
    },
    async (params) => {
      try {
        const client = getClioClient();

        if (params.matter_id) {
          const res = await withBackoff(() =>
            client.get(`/matters/${params.matter_id}`, {
              params: { fields: MATTER_FIELDS },
            })
          );
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(res.data.data, null, 2) },
            ],
          };
        }

        if (params.search_query) {
          const matters = await fetchAllPages<any>("/matters", {
            fields: MATTER_FIELDS,
            query: params.search_query,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { count: matters.length, matters },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: "Provide either matter_id or search_query",
              }),
            },
          ],
          isError: true,
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

  // get_stale_matters
  server.tool(
    "get_stale_matters",
    "Find open matters with no time entries in X days (default 30). Identifies dormant matters.",
    {
      days_inactive: z
        .number()
        .optional()
        .default(30)
        .describe("Number of days without activity to be considered stale"),
      responsible_attorney_id: z
        .number()
        .optional()
        .describe("Filter by responsible attorney ID"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: MATTER_FIELDS,
          status: "open",
        };
        if (params.responsible_attorney_id) {
          queryParams.responsible_attorney_id = params.responsible_attorney_id;
        }

        const matters = await fetchAllPages<any>("/matters", queryParams);

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - params.days_inactive);
        const cutoffStr = cutoffDate.toISOString().split("T")[0];

        const timeFields =
          "id,date,matter{id}";

        const staleMatterResults: any[] = [];

        for (const matter of matters) {
          const recentEntries = await fetchAllPages<any>("/activities", {
            type: "TimeEntry",
            matter_id: matter.id,
            date_from: cutoffStr,
            fields: timeFields,
            limit: 1,
          });

          if (recentEntries.length === 0) {
            staleMatterResults.push({
              id: matter.id,
              display_number: matter.display_number,
              description: matter.description,
              client: matter.client,
              responsible_attorney: matter.responsible_attorney,
              open_date: matter.open_date,
              days_inactive: params.days_inactive,
            });
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: staleMatterResults.length,
                  days_inactive_threshold: params.days_inactive,
                  stale_matters: staleMatterResults,
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

  // get_billing_gaps
  server.tool(
    "get_billing_gaps",
    "Matters with significant WIP that have not had a bill issued in 30+ days. Revenue sitting on the table.",
    {
      min_wip_value: z
        .number()
        .optional()
        .default(500)
        .describe("Minimum WIP value to include (default $500)"),
      days_since_last_bill: z
        .number()
        .optional()
        .default(30)
        .describe("Minimum days since last bill (default 30)"),
    },
    async (params) => {
      try {
        const client = getClioClient();

        // Get all unbilled time entries
        const timeEntries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          billed: false,
          fields:
            "id,date,quantity,price,total,matter{id,display_number,description,client{id,name},responsible_attorney{id,name}}",
        });

        // Get all unbilled expenses
        const expenses = await fetchAllPages<any>("/activities", {
          type: "Expense",
          billed: false,
          fields:
            "id,date,price,matter{id,display_number,description,client{id,name},responsible_attorney{id,name}}",
        });

        // Group WIP by matter
        const matterWip: Record<
          number,
          {
            matter: any;
            time_value: number;
            expense_value: number;
            total_wip: number;
            oldest_entry: string;
          }
        > = {};

        for (const entry of timeEntries) {
          if (!entry.matter?.id) continue;
          const mid = entry.matter.id;
          if (!matterWip[mid]) {
            matterWip[mid] = {
              matter: entry.matter,
              time_value: 0,
              expense_value: 0,
              total_wip: 0,
              oldest_entry: entry.date,
            };
          }
          const value = (entry.quantity / 3600) * (entry.price || 0);
          matterWip[mid].time_value += value;
          matterWip[mid].total_wip += value;
          if (entry.date < matterWip[mid].oldest_entry) {
            matterWip[mid].oldest_entry = entry.date;
          }
        }

        for (const exp of expenses) {
          if (!exp.matter?.id) continue;
          const mid = exp.matter.id;
          if (!matterWip[mid]) {
            matterWip[mid] = {
              matter: exp.matter,
              time_value: 0,
              expense_value: 0,
              total_wip: 0,
              oldest_entry: exp.date,
            };
          }
          matterWip[mid].expense_value += exp.price || 0;
          matterWip[mid].total_wip += exp.price || 0;
          if (exp.date < matterWip[mid].oldest_entry) {
            matterWip[mid].oldest_entry = exp.date;
          }
        }

        // Get most recent bill per matter
        const bills = await fetchAllPages<any>("/bills", {
          fields: "id,issued_at,matter{id}",
          order: "issued_at(desc)",
        });

        const lastBillByMatter: Record<number, string> = {};
        for (const bill of bills) {
          if (!bill.matter?.id) continue;
          const mid = bill.matter.id;
          if (!lastBillByMatter[mid] || bill.issued_at > lastBillByMatter[mid]) {
            lastBillByMatter[mid] = bill.issued_at;
          }
        }

        const today = new Date();
        const results: any[] = [];

        for (const [midStr, wip] of Object.entries(matterWip)) {
          const mid = parseInt(midStr, 10);
          if (wip.total_wip < params.min_wip_value) continue;

          const lastBill = lastBillByMatter[mid];
          let daysSinceLastBill: number;

          if (!lastBill) {
            daysSinceLastBill = Math.floor(
              (today.getTime() - new Date(wip.oldest_entry).getTime()) /
                (1000 * 60 * 60 * 24)
            );
          } else {
            daysSinceLastBill = Math.floor(
              (today.getTime() - new Date(lastBill).getTime()) /
                (1000 * 60 * 60 * 24)
            );
          }

          if (daysSinceLastBill >= params.days_since_last_bill) {
            results.push({
              matter_id: mid,
              matter_number: wip.matter.display_number,
              matter_description: wip.matter.description,
              client: wip.matter.client,
              responsible_attorney: wip.matter.responsible_attorney,
              total_wip_value: Math.round(wip.total_wip * 100) / 100,
              unbilled_time_value: Math.round(wip.time_value * 100) / 100,
              unbilled_expense_value:
                Math.round(wip.expense_value * 100) / 100,
              last_bill_date: lastBill || "Never billed",
              days_since_last_bill: daysSinceLastBill,
            });
          }
        }

        results.sort((a, b) => b.total_wip_value - a.total_wip_value);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: results.length,
                  min_wip_threshold: params.min_wip_value,
                  days_threshold: params.days_since_last_bill,
                  total_at_risk_wip: Math.round(
                    results.reduce((s, r) => s + r.total_wip_value, 0) * 100
                  ) / 100,
                  matters: results,
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
