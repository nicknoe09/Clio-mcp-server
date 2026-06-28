import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { rawGetSingle } from "../clio/pagination";
import { getContext } from "../auth/identity";

const WHO_AM_I_FIELDS =
  "id,name,first_name,last_name,email,enabled,subscription_type,account{id,name}";

export function registerWhoAmITools(server: McpServer): void {
  server.tool(
    "who_am_i",
    "Show who you are authenticated as. Reports two identities: the MCP request identity (the Microsoft/platform email and user id this session is bound to, from the per-request auth context) and the Clio identity (the user the active Clio access token belongs to, fetched live from Clio's /users/who_am_i endpoint, including their Clio user id, name, email, role, and firm/account). Use this to confirm whose Clio account the tools are acting on before reading or writing data.",
    {},
    async () => {
      // MCP/platform identity — bound to this request via AsyncLocalStorage.
      const ctx = getContext();
      const mcp_identity = ctx
        ? { email: ctx.userEmail, user_id: ctx.userId, clio_token_error: ctx.clioError }
        : { error: "No request identity context available." };

      // Clio identity — who the live access token actually belongs to.
      let clio_identity: any;
      try {
        const res = await rawGetSingle("/users/who_am_i", { fields: WHO_AM_I_FIELDS });
        const u = res?.data ?? {};
        clio_identity = {
          clio_user_id: u.id,
          name: u.name,
          first_name: u.first_name,
          last_name: u.last_name,
          email: u.email,
          enabled: u.enabled,
          role: u.subscription_type,
          account: u.account,
        };
      } catch (err: any) {
        clio_identity = {
          error: true,
          message: err.message,
          status: err.response?.status,
          clio_error: err.response?.data,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ mcp_identity, clio_identity }, null, 2),
          },
        ],
      };
    }
  );
}
