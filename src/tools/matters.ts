import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle } from "../clio/pagination";

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
        if (params.matter_id) {
          const res = await rawGetSingle(`/matters/${params.matter_id}`, { fields: MATTER_FIELDS });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(res.data, null, 2) },
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

        // Fetch all recent time entries in one call instead of per-matter
        const recentEntries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          fields: "id,matter{id}",
          created_since: `${cutoffStr}T00:00:00+00:00`,
        });

        // Build set of matter IDs with recent activity
        const activeMatters = new Set(recentEntries.map((e: any) => e.matter?.id).filter(Boolean));

        // Matters with no recent entries are stale
        const staleMatterResults = matters
          .filter((m: any) => !activeMatters.has(m.id))
          .map((m: any) => ({
            id: m.id,
            display_number: m.display_number,
            description: m.description,
            client: m.client,
            responsible_attorney: m.responsible_attorney,
            open_date: m.open_date,
            days_inactive: params.days_inactive,
          }));

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
    "Matters with significant WIP that have not been billed. Shows unbilled time and expense value per matter above a threshold, sorted by total WIP value.",
    {
      min_wip_value: z
        .number()
        .optional()
        .default(500)
        .describe("Minimum WIP value to include (default $500)"),
    },
    async (params) => {
      try {
        const defaultStart = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
        const [timeEntries, expenses] = await Promise.all([
          fetchAllPages<any>("/activities", {
            type: "TimeEntry",
            billed: false,
            fields: "id,date,quantity,price,matter{id,display_number,description,client,responsible_attorney}",
            created_since: `${defaultStart}T00:00:00+00:00`,
          }),
          fetchAllPages<any>("/activities", {
            type: "ExpenseEntry",
            billed: false,
            fields: "id,date,price,matter{id,display_number,description,client,responsible_attorney}",
            created_since: `${defaultStart}T00:00:00+00:00`,
          }),
        ]);

        const matterWip: Record<number, { matter: any; time_value: number; expense_value: number; oldest_entry: string }> = {};

        for (const e of timeEntries) {
          if (!e.matter?.id) continue;
          const mid = e.matter.id;
          if (!matterWip[mid]) matterWip[mid] = { matter: e.matter, time_value: 0, expense_value: 0, oldest_entry: e.date };
          matterWip[mid].time_value += (e.quantity / 3600) * (e.price || 0);
          if (e.date < matterWip[mid].oldest_entry) matterWip[mid].oldest_entry = e.date;
        }

        for (const e of expenses) {
          if (!e.matter?.id) continue;
          const mid = e.matter.id;
          if (!matterWip[mid]) matterWip[mid] = { matter: e.matter, time_value: 0, expense_value: 0, oldest_entry: e.date };
          matterWip[mid].expense_value += e.price || 0;
          if (e.date < matterWip[mid].oldest_entry) matterWip[mid].oldest_entry = e.date;
        }

        const today = new Date();
        const results = Object.values(matterWip)
          .map((w) => {
            const total = w.time_value + w.expense_value;
            const daysAging = Math.floor((today.getTime() - new Date(w.oldest_entry).getTime()) / 86400000);
            return {
              matter_id: w.matter.id,
              matter_number: w.matter.display_number,
              matter_description: w.matter.description,
              client: w.matter.client,
              responsible_attorney: w.matter.responsible_attorney,
              unbilled_time_value: Math.round(w.time_value * 100) / 100,
              unbilled_expense_value: Math.round(w.expense_value * 100) / 100,
              total_wip: Math.round(total * 100) / 100,
              oldest_unbilled_entry: w.oldest_entry,
              days_aging: daysAging,
            };
          })
          .filter((r) => r.total_wip >= params.min_wip_value)
          .sort((a, b) => b.total_wip - a.total_wip);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: results.length,
              min_wip_threshold: params.min_wip_value,
              total_unbilled_wip: Math.round(results.reduce((s, r) => s + r.total_wip, 0) * 100) / 100,
              matters: results,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }),
          }],
          isError: true,
        };
      }
    }
  );
}
