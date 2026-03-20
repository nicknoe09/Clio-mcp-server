import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";

const CONTACT_FIELDS =
  "id,name,first_name,last_name,type,email_addresses,phone_numbers,matters{id,display_number}";

export function registerContactTools(server: McpServer): void {
  server.tool(
    "get_contacts",
    "Search contacts by name or email, optionally filter by type (Person/Company)",
    {
      search: z.string().describe("Search query (name or email)"),
      type: z
        .enum(["Person", "Company", "all"])
        .optional()
        .default("all")
        .describe("Filter by contact type"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: CONTACT_FIELDS,
          query: params.search,
        };
        if (params.type !== "all") {
          queryParams.type = params.type;
        }

        const contacts = await fetchAllPages<any>("/contacts", queryParams);

        const formatted = contacts.map((c: any) => ({
          id: c.id,
          name: c.name,
          first_name: c.first_name,
          last_name: c.last_name,
          type: c.type,
          emails: c.email_addresses ?? [],
          phones: c.phone_numbers ?? [],
          open_matters: c.matters ?? [],
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { count: formatted.length, contacts: formatted },
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
