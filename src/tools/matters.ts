import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle, rawPostSingle } from "../clio/pagination";
import { resolveCustomFieldsForCreate, type CustomFieldInput } from "../clio/customFieldResolver";

const MATTER_FIELDS =
  "id,display_number,description,status,open_date,billing_method,responsible_attorney{id,name},client{id,name},practice_area{name}";

// Richer field set used when reading a matter back after creation, so the
// caller sees everything they just set (attorneys, practice area, dates).
const MATTER_CREATE_READBACK_FIELDS =
  "id,display_number,description,status,open_date,billing_method," +
  "client{id,name},responsible_attorney{id,name},originating_attorney{id,name}," +
  "practice_area{id,name},custom_field_values{id,field_name,value}";

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

  // ============================================================
  //  create_matter — "open a matter" (POST /matters)
  // ============================================================
  // Creates a new matter for an existing client (contact). client_id is the
  // ONLY required field; everything else is optional. Associations
  // (client, practice area, attorneys) are passed by id. The matter is read
  // back with a rich field set so the caller sees exactly what was created.
  //
  // NOTE on custom_rate: matter-level custom rates are not a confirmed scalar
  // field on Clio's matter-create payload (this is one of the things
  // probe_billing_write_apis verifies). It's therefore OPT-IN: omit it and
  // creation uses only confirmed fields; pass it and the value is sent as
  // data.custom_rate, with any Clio rejection surfaced verbatim rather than
  // silently dropped — so a wrong field shape is visible, not hidden.
  server.tool(
    "create_matter",
    "Open (create) a new matter in Clio via POST /matters. Requires client_id (the matter's client — an existing contact). All other fields are optional: description, status, open_date, billing_method, practice_area_id, responsible_attorney_id, originating_attorney_id, and (opt-in/experimental) custom_rate. Custom intake fields (e.g. Cause #, Court, Bill Frequency, Paralegal, per-user hourly rate) can be set in the same call via custom_fields — pass each by field_name (or custom_field_id) with its value; picklists like Court accept the option label or option id, contact fields like Paralegal accept a contact id. Use list_custom_fields(parent_type='Matter') to discover available fields. Reads the matter back after creation and returns it; surfaces Clio validation errors verbatim. Use get_contacts to find a client_id and get_users to find attorney user IDs.",
    {
      client_id: z.coerce.number().describe("REQUIRED. Clio contact ID of the matter's client. Find via get_contacts."),
      description: z.string().optional().describe("Matter description / name (e.g. 'Smith v. Jones — Personal Injury')."),
      status: z
        .enum(["open", "pending", "closed"])
        .optional()
        .default("open")
        .describe("Matter status. Defaults to 'open' (i.e. 'open the matter')."),
      open_date: z.string().optional().describe("Open date (YYYY-MM-DD). Defaults to Clio's server default (today) if omitted."),
      billing_method: z
        .enum(["hourly", "flat", "contingency", "pro_bono"])
        .optional()
        .describe("Billing method for the matter."),
      practice_area_id: z.coerce.number().optional().describe("Practice area ID to assign. (Clio references practice areas by ID, not name.)"),
      responsible_attorney_id: z.coerce.number().optional().describe("Clio user ID of the responsible attorney. Find via get_users."),
      originating_attorney_id: z.coerce.number().optional().describe("Clio user ID of the originating attorney. Find via get_users."),
      custom_rate: z
        .coerce
        .number()
        .optional()
        .describe("OPT-IN / EXPERIMENTAL: matter-level custom hourly rate. Sent as data.custom_rate; field shape is pending probe_billing_write_apis confirmation, so if Clio rejects it the error is surfaced verbatim. Omit unless you specifically need a matter-level rate."),
      custom_fields: z
        .array(
          z.object({
            field_name: z
              .string()
              .optional()
              .describe("Exact Matter CustomField name (case-sensitive), e.g. 'Cause #', 'Court', 'Bill Frequency', 'Paralegal'."),
            custom_field_id: z
              .coerce
              .number()
              .optional()
              .describe("Matter CustomField id, if known. Used instead of field_name."),
            value: z
              .union([z.string(), z.number(), z.boolean()])
              .describe("Value to set. Picklist (e.g. Court, Bill Frequency): option label (string) or option id (number). Contact field (e.g. Paralegal): contact id (number). Checkbox: true/false. Text/currency/date/etc.: string."),
          }),
        )
        .optional()
        .describe("Custom intake fields to set on the matter (e.g. Cause #, Court, Bill Frequency=Monthly, Paralegal, per-user hourly rate). Each entry needs field_name or custom_field_id plus a value. Resolution is validated against the firm's Matter custom fields before the matter is created; if any entry is invalid the matter is NOT created and the errors are returned."),
    },
    async (params) => {
      try {
        // Resolve custom intake fields BEFORE creating, so a bad field name or
        // picklist option aborts cleanly instead of leaving a half-configured
        // matter behind. Picklist labels are resolved to option ids here.
        let resolvedCustomFields: Awaited<ReturnType<typeof resolveCustomFieldsForCreate>> | null = null;
        if (params.custom_fields && params.custom_fields.length > 0) {
          resolvedCustomFields = await resolveCustomFieldsForCreate(
            "Matter",
            params.custom_fields as CustomFieldInput[],
          );
          if (resolvedCustomFields.errors.length > 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message: "One or more custom_fields could not be resolved; the matter was NOT created.",
                  context: "custom_field_resolution_failed",
                  custom_field_errors: resolvedCustomFields.errors,
                }, null, 2),
              }],
              isError: true,
            };
          }
        }

        const data: Record<string, any> = {
          client: { id: params.client_id },
          status: params.status,
        };
        if (params.description !== undefined) data.description = params.description;
        if (params.open_date !== undefined) data.open_date = params.open_date;
        if (params.billing_method !== undefined) data.billing_method = params.billing_method;
        if (params.practice_area_id !== undefined) data.practice_area = { id: params.practice_area_id };
        if (params.responsible_attorney_id !== undefined) data.responsible_attorney = { id: params.responsible_attorney_id };
        if (params.originating_attorney_id !== undefined) data.originating_attorney = { id: params.originating_attorney_id };
        if (params.custom_rate !== undefined) data.custom_rate = params.custom_rate;
        if (resolvedCustomFields && resolvedCustomFields.entries.length > 0) {
          data.custom_field_values = resolvedCustomFields.entries;
        }

        const result = await rawPostSingle("/matters", { data });
        const created = result?.data ?? result;

        // Read back with the rich field set so the caller sees the resolved
        // associations (attorney names, practice area name) the POST response
        // may not fully expand.
        let readback: any = null;
        if (created?.id) {
          try {
            const rb = await rawGetSingle(`/matters/${created.id}`, { fields: MATTER_CREATE_READBACK_FIELDS });
            readback = rb?.data ?? rb;
          } catch {
            /* non-fatal: fall back to the POST response below */
          }
        }

        const matter = readback ?? created;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  created: true,
                  matter: {
                    id: matter?.id,
                    display_number: matter?.display_number ?? null,
                    description: matter?.description ?? null,
                    status: matter?.status ?? null,
                    open_date: matter?.open_date ?? null,
                    billing_method: matter?.billing_method ?? null,
                    client: matter?.client ?? null,
                    responsible_attorney: matter?.responsible_attorney ?? null,
                    originating_attorney: matter?.originating_attorney ?? null,
                    practice_area: matter?.practice_area ?? null,
                    custom_field_values: matter?.custom_field_values ?? [],
                  },
                  custom_fields_set: resolvedCustomFields?.resolved ?? [],
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
        if (status === 422) interpretation = "Clio rejected the matter. Most often: client_id is not a valid contact, or a field value (e.g. custom_rate, billing_method, practice_area_id, a custom_field_values entry) is invalid. See clio_error for the specific field.";
        else if (status === 404) interpretation = "A referenced resource was not found (check client_id / attorney IDs / practice_area_id).";
        else if (status === 403) interpretation = "Forbidden — the token lacks permission to create matters.";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: err.message,
                status,
                interpretation,
                clio_error: err.response?.data,
              }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }
  );

}
