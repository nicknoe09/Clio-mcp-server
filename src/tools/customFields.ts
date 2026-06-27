import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle } from "../clio/pagination";

// CustomField definitions live in Clio's /custom_fields resource. Each
// CustomField has a parent_type (Matter / Contact / Activity / Bill / etc.)
// and a field_type (text_line, picklist, date, currency, checkbox, numeric,
// email, url, etc.). VALUES live on the parent resource itself, accessed
// via field expansion (e.g. matters?fields=...,custom_field_values{...}).
//
// IMPORTANT: Clio's field selector only supports 1-level nesting on
// /custom_field_values (verified empirically — 2-level breaks with
// "InvalidFields"). So we expand custom_field_values{id,field_name,value}
// and don't try to expand the inner custom_field. Callers wanting field
// metadata (type / required / etc.) cross-reference via list_custom_fields.

const CUSTOM_FIELD_FIELDS =
  "id,name,parent_type,field_type,displayed,deleted,required,display_order";

export function registerCustomFieldTools(server: McpServer): void {
  server.tool(
    "list_custom_fields",
    "List Clio CustomField definitions firm-wide. Returns each field's id, name, parent_type (Matter / Contact / Activity / Bill / etc.), field_type (text_line / picklist / date / currency / checkbox / numeric / email / url / etc.), displayed, required, and display_order. Use this to discover what custom fields the firm has configured. To see VALUES on a specific matter, use get_matter_custom_field_values.",
    {
      parent_type: z
        .string()
        .optional()
        .describe(
          "Filter by parent type. Common values: 'Matter', 'Contact', 'Activity', 'Bill'. Case-sensitive — Clio expects PascalCase.",
        ),
      field_type: z
        .string()
        .optional()
        .describe(
          "Filter by field type. Common values: 'text_line', 'text_area', 'picklist', 'date', 'currency', 'checkbox', 'numeric', 'email', 'url'.",
        ),
      include_deleted: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include soft-deleted custom field definitions. Default false."),
      query: z
        .string()
        .optional()
        .describe("Wildcard search on the field name."),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = { fields: CUSTOM_FIELD_FIELDS };
        if (params.parent_type) queryParams.parent_type = params.parent_type;
        if (params.field_type) queryParams.field_type = params.field_type;
        if (params.include_deleted) queryParams.deleted = true;
        if (params.query) queryParams.query = params.query;

        const fields = await fetchAllPages<any>("/custom_fields", queryParams);

        // Sort for predictable output: parent_type, then Clio's display_order,
        // then id as tiebreaker.
        fields.sort((a: any, b: any) => {
          const pa = String(a.parent_type || "").localeCompare(
            String(b.parent_type || ""),
          );
          if (pa !== 0) return pa;
          const da =
            typeof a.display_order === "number"
              ? a.display_order
              : Number.MAX_SAFE_INTEGER;
          const db =
            typeof b.display_order === "number"
              ? b.display_order
              : Number.MAX_SAFE_INTEGER;
          if (da !== db) return da - db;
          return (a.id || 0) - (b.id || 0);
        });

        const formatted = fields.map((f: any) => ({
          id: f.id,
          name: f.name,
          parent_type: f.parent_type ?? null,
          field_type: f.field_type ?? null,
          displayed: f.displayed ?? null,
          required: f.required ?? null,
          deleted: f.deleted ?? null,
          display_order: f.display_order ?? null,
        }));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: formatted.length,
              filter: {
                parent_type: params.parent_type ?? null,
                field_type: params.field_type ?? null,
                include_deleted: params.include_deleted ?? false,
                query: params.query ?? null,
              },
              custom_fields: formatted,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: err.message,
              status: err.response?.status,
              clio_error: err.response?.data,
            }),
          }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_matter_custom_field_values",
    "Get the custom field values set on a specific matter. Returns each value's id, field_name, and value, along with the matter context (id, display_number, description). Use list_custom_fields to discover the schema (which fields exist firm-wide, their types and parent types); use this tool to see what's actually set on one matter.",
    {
      matter_id: z.coerce.number().describe("Clio matter ID"),
    },
    async (params) => {
      try {
        const resp = await rawGetSingle(`/matters/${params.matter_id}`, {
          // 1-level nesting only — Clio rejects 2-level (so we can't get
          // custom_field{...} embedded; cross-reference via list_custom_fields).
          fields:
            "id,display_number,description,custom_field_values{id,field_name,value}",
        });
        const matter = resp.data;
        if (!matter) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Matter ${params.matter_id} not found.`,
              }),
            }],
            isError: true,
          };
        }
        const cfvs: any[] = matter.custom_field_values || [];
        const formatted = cfvs.map((cfv) => ({
          id: cfv.id,
          field_name: cfv.field_name ?? null,
          value: cfv.value ?? null,
        }));
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              matter: {
                id: matter.id,
                display_number: matter.display_number,
                description: matter.description,
              },
              count: formatted.length,
              custom_field_values: formatted,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: err.message,
              status: err.response?.status,
              clio_error: err.response?.data,
            }),
          }],
          isError: true,
        };
      }
    },
  );
}
