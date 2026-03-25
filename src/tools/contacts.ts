import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle } from "../clio/pagination";

const CONTACT_FIELDS =
  "id,name,first_name,last_name,type,email_addresses,phone_numbers";

export function registerContactTools(server: McpServer): void {
  // get_users — list all firm users with IDs
  server.tool(
    "get_users",
    "List all users (timekeepers/staff) in the firm with their IDs, names, and roles. Use this to look up user_id values for other tools.",
    {},
    async () => {
      try {
        const users = await fetchAllPages<any>("/users", {
          fields: "id,name,email,enabled,subscription_type",
        });

        const formatted = users.map((u: any) => ({
          user_id: u.id,
          name: u.name,
          email: u.email,
          enabled: u.enabled,
          role: u.subscription_type,
        }));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: formatted.length, users: formatted }, null, 2),
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

  server.tool(
    "get_contacts",
    "Search contacts by name or email, optionally filter by type (Person/Company). Use matter_id to get contacts associated with a specific matter.",
    {
      search: z.string().optional().describe("Search query (name or email)"),
      matter_id: z.coerce.number().optional().describe("Get contacts associated with a specific matter"),
      type: z
        .enum(["Person", "Company", "all"])
        .optional()
        .default("all")
        .describe("Filter by contact type"),
    },
    async (params) => {
      try {
        if (!params.search && !params.matter_id) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: "Provide either 'search' or 'matter_id'" }),
            }],
            isError: true,
          };
        }

        let contacts: any[] = [];

        if (params.matter_id) {
          // Get matter details which include the client contact
          const matterData = await rawGetSingle(`/matters/${params.matter_id}`, {
            fields: "id,display_number,description,client{id,name,first_name,last_name,type,email_addresses,phone_numbers}",
          });
          const client = matterData?.data?.client;
          if (client) {
            contacts = [client];
          }
        } else if (params.search) {
          const queryParams: Record<string, any> = {
            fields: CONTACT_FIELDS,
            query: params.search,
          };
          if (params.type !== "all") {
            queryParams.type = params.type;
          }
          const allContacts = await fetchAllPages<any>("/contacts", queryParams);
          contacts = allContacts.slice(0, 200);
        }

        const formatted = contacts.map((c: any) => ({
          id: c.id,
          name: c.name,
          first_name: c.first_name,
          last_name: c.last_name,
          type: c.type,
          emails: c.email_addresses ?? [],
          phones: c.phone_numbers ?? [],
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
