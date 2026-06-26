import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawPostSingle, rawDeleteSingle } from "../clio/pagination";

// Custom Actions register clickable links inside Clio's own UI (on an
// Activity, Contact, Document, Matter, or Folder page). When a user clicks
// one, Clio opens the action's target_url in a new tab, appending
// custom_action_id, user_id, subject_url and a custom_action_nonce. The
// third-party app is then expected to call back to subject_url (passing the
// nonce) to validate the click and pull record data — that callback handler
// is a separate HTTP route, NOT one of these tools. These tools cover only
// the management side: list / create / delete the action definitions.
const CUSTOM_ACTION_FIELDS =
  "id,etag,created_at,updated_at,label,target_url,ui_reference";

// The locations in Clio's UI where a custom action link can be placed.
const UI_REFERENCES = [
  "activities/show",
  "documents/show",
  "contacts/show",
  "matters/show",
  "folders/show",
] as const;

export function registerCustomActionTools(server: McpServer): void {
  // get_custom_actions
  server.tool(
    "get_custom_actions",
    "List the firm's Clio Custom Actions (the clickable links this application has registered in Clio's UI). Returns id, label, target_url, ui_reference (where the link appears), and timestamps. Optionally filter by ui_reference. Read-only.",
    {
      ui_reference: z
        .enum(UI_REFERENCES)
        .optional()
        .describe("Optional: only return actions placed at this UI location (e.g. 'matters/show')."),
    },
    async (params) => {
      try {
        // NOTE: /custom_actions does not document an `order` query param, and
        // Clio rejects order=id on some list endpoints — so override the
        // helper's default order to undefined (buildQueryString drops it) and
        // rely on page_token cursor pagination, which works without an order.
        const actions = await fetchAllPages<any>("/custom_actions", {
          fields: CUSTOM_ACTION_FIELDS,
          order: undefined,
        });

        const filtered = params.ui_reference
          ? actions.filter((a: any) => a.ui_reference === params.ui_reference)
          : actions;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: filtered.length,
                  custom_actions: filtered.map((a: any) => ({
                    id: a.id,
                    label: a.label,
                    target_url: a.target_url,
                    ui_reference: a.ui_reference,
                    created_at: a.created_at ?? null,
                    updated_at: a.updated_at ?? null,
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

  // create_custom_action
  server.tool(
    "create_custom_action",
    "Register a new Clio Custom Action — a clickable link Clio displays in its UI at the given ui_reference (e.g. on every matter's page). When clicked, Clio opens target_url in a new tab and appends custom_action_id, user_id, subject_url and custom_action_nonce. A link is unique per (application, user, ui_reference, label), so reusing the same label + ui_reference will be rejected by Clio as a duplicate.",
    {
      label: z.string().describe("Text shown on the link/button in Clio (e.g. 'Issue Draft Bill')."),
      target_url: z
        .string()
        .describe("Absolute https URL Clio opens when the link is clicked. Clio appends custom_action_id, user_id, subject_url and custom_action_nonce as query params."),
      ui_reference: z
        .enum(UI_REFERENCES)
        .describe("Where the link appears in Clio: 'activities/show', 'documents/show', 'contacts/show', 'matters/show', or 'folders/show'."),
    },
    async (params) => {
      try {
        const result = await rawPostSingle("/custom_actions", {
          data: {
            label: params.label,
            target_url: params.target_url,
            ui_reference: params.ui_reference,
          },
        });
        const created = result?.data ?? result;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  created: true,
                  custom_action: {
                    id: created?.id,
                    label: created?.label,
                    target_url: created?.target_url,
                    ui_reference: created?.ui_reference,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        const status = err.response?.status;
        let interpretation: string | undefined;
        if (status === 422)
          interpretation =
            "Clio rejected the custom action. Most often: a link with this label already exists at this ui_reference (links are unique per application/user/ui_reference/label), or target_url is not a valid absolute https URL.";
        else if (status === 403)
          interpretation = "Forbidden — the token lacks permission to manage custom actions.";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: true,
                  message: err.message,
                  status,
                  interpretation,
                  clio_error: err.response?.data,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // delete_custom_action
  server.tool(
    "delete_custom_action",
    "Delete a Clio Custom Action by ID (removes the link from Clio's UI). Find IDs via get_custom_actions.",
    {
      custom_action_id: z.coerce.number().describe("Clio CustomAction ID to delete."),
    },
    async (params) => {
      try {
        await rawDeleteSingle(`/custom_actions/${params.custom_action_id}`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  deleted_custom_action_id: params.custom_action_id,
                  message: `Custom action ${params.custom_action_id} deleted.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        const status = err.response?.status;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  custom_action_id: params.custom_action_id,
                  message: err.message,
                  status,
                  interpretation:
                    status === 404
                      ? "No custom action with that ID (already deleted, or never existed)."
                      : undefined,
                  clio_error: err.response?.data,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
