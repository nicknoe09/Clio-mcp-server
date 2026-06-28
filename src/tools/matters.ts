import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle, rawPostSingle } from "../clio/pagination";
import { resolveCustomFieldsForCreate, type CustomFieldInput } from "../clio/customFieldResolver";
import { buildCustomRatePayload, applyCustomRate, type UserRate } from "../clio/matterRate";

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
  // NOTE on rates: billing rates live on a Matter via the `custom_rate`
  // ASSOCIATION (not a scalar, and not the top-level billing_method — which
  // Clio silently saves as "hourly" regardless). The association is applied
  // by PATCH, so when rate input is given this tool does POST-then-PATCH:
  // create the matter, then PATCH custom_rate = { type, rates:[...] }. Rates
  // can be matter-wide (matter_rate) and/or per-timekeeper (user_rates).
  server.tool(
    "create_matter",
    "Open (create) a new matter in Clio via POST /matters. Requires client_id (the matter's client — an existing contact). All other fields are optional: description, status, open_date, billing_method, practice_area_id, responsible_attorney_id, originating_attorney_id. Custom intake fields (e.g. Cause #, Court, Bill Frequency, Paralegal) can be set in the same call via custom_fields. Per-timekeeper billing rates can be set via user_rates (e.g. $300 for one attorney, $250 for another) — written through Clio's custom_rate association with a POST-then-PATCH, so if the rate PATCH fails the matter is still created and the rate error is reported. Each user_rates entry needs a user_id and a rate; Clio requires a user per rate (no user-less matter-wide rate). Use list_custom_fields(parent_type='Matter') for fields, get_contacts for client_id, and get_users for attorney/timekeeper user IDs. Reads the matter back after creation; surfaces Clio validation errors verbatim.",
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
      rate_type: z
        .enum(["hourly", "flat"])
        .optional()
        .default("hourly")
        .describe("Type of rate for user_rates. 'hourly' (default) → Clio HourlyRate; 'flat' → FlatRate (a flat fee; Clio flips billing_method to 'flat' as a side effect)."),
      user_rates: z
        .array(
          z.object({
            user_id: z.coerce.number().describe("Clio user ID of the timekeeper. Find via get_users."),
            rate: z.coerce.number().describe("This user's rate on this matter, e.g. 300 or 250."),
          }),
        )
        .optional()
        .describe("Per-timekeeper rates on the matter, e.g. [{user_id: 123, rate: 300}, {user_id: 456, rate: 250}]. Each entry maps a user to their own rate (Clio's custom_rate.rates array). Clio requires a user per rate — there is no user-less matter-wide rate."),
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
        if (resolvedCustomFields && resolvedCustomFields.entries.length > 0) {
          data.custom_field_values = resolvedCustomFields.entries;
        }

        const result = await rawPostSingle("/matters", { data });
        const created = result?.data ?? result;

        // Apply per-user billing rates via the custom_rate association (PATCH).
        // The matter already exists at this point, so a rate failure does NOT
        // undo creation — we report it alongside the created matter instead.
        const ratePayload = buildCustomRatePayload({
          rate_type: params.rate_type,
          user_rates: params.user_rates as UserRate[] | undefined,
        });
        let rateResult: any = null;
        if (ratePayload && created?.id) {
          try {
            const rb = await applyCustomRate(created.id, ratePayload);
            rateResult = {
              applied: true,
              sent: ratePayload,
              billing_method: rb.billing_method,
              custom_rate: rb.custom_rate,
            };
          } catch (rateErr: any) {
            rateResult = {
              applied: false,
              sent: ratePayload,
              status: rateErr.response?.status,
              message: "Matter was created, but applying the rate failed. Set it with set_matter_rate.",
              clio_error: rateErr.response?.data,
            };
          }
        }

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
                  rate: rateResult,
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
        if (status === 422) interpretation = "Clio rejected the matter. Most often: client_id is not a valid contact, or a field value (e.g. billing_method, practice_area_id, a custom_field_values entry) is invalid. See clio_error for the specific field.";
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

  // ============================================================
  //  set_matter_rate — set billing rates on an EXISTING matter
  // ============================================================
  // Companion to create_matter's rate handling: PATCHes the custom_rate
  // association on a matter that already exists. Use for backfilling rates,
  // changing them, or when create_matter's rate PATCH failed.
  server.tool(
    "set_matter_rate",
    "Set per-timekeeper billing rate(s) on an existing matter via Clio's custom_rate association (PATCH /matters/{id}). Provide user_rates — one entry per timekeeper, each with a user_id and a rate (e.g. $300 for one attorney and $250 for another). At least one entry is required; Clio requires a user per rate (there is no user-less matter-wide rate). rate_type selects 'hourly' (HourlyRate, default) or 'flat' (FlatRate — a flat fee, which flips the matter's billing_method to 'flat'). NOTE: the top-level billing_method field cannot be set directly — Clio always saves 'hourly' unless a FlatRate custom_rate is applied. Reads the matter back and returns billing_method (a 'flat' result confirms a FlatRate took). Use get_users to find user IDs.",
    {
      matter_id: z.coerce.number().describe("Clio matter ID to set the rate on."),
      rate_type: z
        .enum(["hourly", "flat"])
        .optional()
        .default("hourly")
        .describe("'hourly' (default) → HourlyRate; 'flat' → FlatRate (flat fee; flips billing_method to 'flat')."),
      user_rates: z
        .array(
          z.object({
            user_id: z.coerce.number().describe("Clio user ID of the timekeeper. Find via get_users."),
            rate: z.coerce.number().describe("This user's rate on this matter, e.g. 300 or 250."),
          }),
        )
        .min(1)
        .describe("Per-timekeeper rates (at least one), e.g. [{user_id: 123, rate: 300}, {user_id: 456, rate: 250}]. Each entry needs a user_id and a rate."),
    },
    async (params) => {
      const ratePayload = buildCustomRatePayload({
        rate_type: params.rate_type,
        user_rates: params.user_rates as UserRate[],
      });
      if (!ratePayload) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: "Provide at least one user_rates entry (each with user_id and rate).",
            }),
          }],
          isError: true,
        };
      }
      try {
        const rb = await applyCustomRate(params.matter_id, ratePayload);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              matter: rb.matter,
              sent: ratePayload,
              billing_method: rb.billing_method,
              custom_rate: rb.custom_rate,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status;
        let interpretation: string | undefined;
        if (status === 422) interpretation = "Clio rejected the rate. Check that user_ids are valid timekeepers and rate values are numbers; see clio_error.";
        else if (status === 404) interpretation = "Matter not found (check matter_id).";
        else if (status === 403) interpretation = "Forbidden — the token lacks permission to edit matter rates.";
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: err.message,
              status,
              interpretation,
              sent: ratePayload,
              clio_error: err.response?.data,
            }, null, 2),
          }],
          isError: true,
        };
      }
    }
  );

}
