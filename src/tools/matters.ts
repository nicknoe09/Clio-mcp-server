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

}
