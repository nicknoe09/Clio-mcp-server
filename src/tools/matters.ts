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
      client_id: z.coerce.number().optional().describe("Filter by client ID"),
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
      matter_id: z.coerce.number().optional().describe("Clio matter ID"),
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
    "Find open matters with no time entries in X days (default 30). Requires responsible_attorney_id to keep response times fast.",
    {
      responsible_attorney_id: z
        .coerce.number()
        .describe("Responsible attorney ID (required — use get_users to find IDs)"),
      days_inactive: z
        .coerce.number()
        .optional()
        .default(30)
        .describe("Number of days without activity to be considered stale"),
      limit: z
        .coerce.number()
        .optional()
        .default(50)
        .describe("Maximum number of stale matters to return (default 50)"),
    },
    async (params) => {
      try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - params.days_inactive);
        const cutoffStr = cutoffDate.toISOString().split("T")[0];

        // Step 1: Fetch open matters for this attorney (single paginated call)
        const matters = await fetchAllPages<any>("/matters", {
          fields: MATTER_FIELDS,
          status: "open",
          responsible_attorney_id: params.responsible_attorney_id,
        });

        // Step 2: Fetch recent activities (single paginated call, capped)
        // Only need matter IDs to build the "active" set
        const recentEntries = await fetchAllPages<any>("/activities", {
          type: "TimeEntry",
          fields: "id,date,matter{id}",
          created_since: `${cutoffStr}T00:00:00+00:00`,
        }, 4000);

        // Build set of matter IDs with recent activity
        const activeMatters = new Set<number>();
        for (const e of recentEntries) {
          if (e.matter?.id) activeMatters.add(e.matter.id);
        }

        // Step 3: Filter to stale matters
        const staleMatterResults: any[] = [];
        for (const m of matters) {
          if (staleMatterResults.length >= params.limit) break;
          if (activeMatters.has(m.id)) continue;

          staleMatterResults.push({
            id: m.id,
            display_number: m.display_number,
            description: m.description,
            client: m.client,
            responsible_attorney: m.responsible_attorney,
            open_date: m.open_date,
            days_inactive: params.days_inactive + "+",
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: staleMatterResults.length,
                  limit: params.limit,
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

}
