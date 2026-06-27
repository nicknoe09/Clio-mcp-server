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
    "find_matters_by_custom_field",
    "Find matters whose CustomField value matches a given criterion — without brute-forcing per-matter lookups. Clio's /matters endpoint has NO server-side filter for custom_field_values, but it DOES support expanding `custom_field_values{id,field_name,value}` inline on the matter list response. So this tool runs ONE paginated `/matters?fields=...,custom_field_values{...}` query (3-4 calls for a ~500-matter firm) and filters client-side. Use this instead of looping through `get_matter_custom_field_values` per matter — that costs ~N HTTP calls instead of ~3. Returns the matching matters with `id`, `display_number`, `description`, `status`, `responsible_attorney`, `client`, plus the matched field's raw `value` and resolved `value_label` (picklist text, contact name, or Yes/No for checkbox). Picklist + contact labels are resolved via the same bulk-lookup path get_matter_custom_field_values uses.",
    {
      field_name: z.string().describe("Exact name of the CustomField to filter on, e.g. 'Contingency', 'Bill Frequency', 'Cause No.'. Case-sensitive."),
      expected_value: z
        .union([z.string(), z.number(), z.boolean()])
        .optional()
        .describe("Optional. The value to filter for. Pass true/false for checkbox fields, the picklist OPTION LABEL (string, case-insensitive) or option id (number) for picklist fields, the contact id (number) for contact fields, and the exact string for text fields. Omit to return ALL matters that have this field SET to any non-null value (useful for sparse fields)."),
      status: z
        .enum(["open", "closed", "pending", "all"])
        .optional()
        .default("open")
        .describe("Filter matters by status before the custom-field filter is applied. Default 'open' (most invoice-review use cases)."),
    },
    async (params) => {
      try {
        // Step 1: Bulk fetch matters with custom_field_values expanded. ONE
        // paginated query covers the whole open-matter set in 3-4 calls,
        // vs the ~N calls a per-matter loop would burn.
        const queryParams: Record<string, any> = {
          fields:
            "id,display_number,description,status,responsible_attorney{id,name},client{id,name},practice_area{name},billing_method,custom_field_values{id,field_name,value}",
        };
        if (params.status !== "all") queryParams.status = params.status;

        const matters = await fetchAllPages<any>("/matters", queryParams);

        // Step 2: First-pass filter — find matters where field_name appears in
        // custom_field_values. (Sparse fields: matters that don't have the
        // field instantiated won't appear in their cfvs array at all.)
        const parseFieldType = (id: unknown): string | null => {
          if (typeof id !== "string") return null;
          const idx = id.indexOf("-");
          return idx > 0 ? id.slice(0, idx) : null;
        };
        type MatterMatch = {
          matter: any;
          cfv: any;
          field_type: string | null;
        };
        const firstPass: MatterMatch[] = [];
        for (const m of matters) {
          const cfvs: any[] = m.custom_field_values || [];
          const hit = cfvs.find((cfv) => cfv.field_name === params.field_name);
          if (hit) firstPass.push({ matter: m, cfv: hit, field_type: parseFieldType(hit.id) });
        }

        // Step 3: Apply expected_value filter (if any). For checkbox/numeric/
        // contact, compare directly. For picklist, allow callers to pass
        // either the option id (number) or the option label (string).
        // For text fields, exact string match.
        const exp = params.expected_value;
        const wantsValueMatch = exp !== undefined && exp !== null;

        // For picklist label-string match, we need to resolve options.
        let picklistFieldByName: Map<string, any> | null = null;
        if (
          wantsValueMatch &&
          typeof exp === "string" &&
          firstPass.some((m) => m.field_type === "picklist")
        ) {
          const cfFields = await fetchAllPages<any>("/custom_fields", {
            fields: "id,name,field_type,picklist_options{id,option}",
            parent_type: "Matter",
          });
          picklistFieldByName = new Map<string, any>();
          for (const f of cfFields) {
            if (f.field_type === "picklist" && Array.isArray(f.picklist_options)) {
              picklistFieldByName.set(f.name, f);
            }
          }
        }

        const matchesExpected = (m: MatterMatch): boolean => {
          if (!wantsValueMatch) {
            // No expected_value provided → match any non-null value.
            return m.cfv.value !== null && m.cfv.value !== undefined;
          }
          const v = m.cfv.value;
          if (v === null || v === undefined) return false;
          if (m.field_type === "checkbox" && typeof exp === "boolean") {
            return v === exp;
          }
          if (m.field_type === "picklist") {
            if (typeof exp === "number") return v === exp;
            if (typeof exp === "string" && picklistFieldByName) {
              const field = picklistFieldByName.get(params.field_name);
              const opt = field?.picklist_options?.find(
                (o: any) =>
                  typeof o.option === "string" &&
                  o.option.toLowerCase() === exp.toLowerCase(),
              );
              return opt ? v === opt.id : false;
            }
            return false;
          }
          if (m.field_type === "contact" && typeof exp === "number") {
            return v === exp;
          }
          // text_line, text_area, date, currency, numeric, email, url
          if (typeof exp === "string" && typeof v === "string") {
            return v === exp;
          }
          if (typeof exp === "number" && typeof v === "number") {
            return v === exp;
          }
          return false;
        };

        const matched = firstPass.filter(matchesExpected);

        // Step 4: Resolve labels for the matched set. Reuse the same bulk-
        // lookup pattern get_matter_custom_field_values uses.
        const contactIds = new Set<number>();
        for (const m of matched) {
          if (m.field_type === "contact" && typeof m.cfv.value === "number") {
            contactIds.add(m.cfv.value);
          }
        }
        const hasMatchedPicklist = matched.some((m) => m.field_type === "picklist");

        const [picklistFieldsForLabels, contactRecords] = await Promise.all([
          hasMatchedPicklist && !picklistFieldByName
            ? fetchAllPages<any>("/custom_fields", {
                fields: "id,name,field_type,picklist_options{id,option}",
                parent_type: "Matter",
              })
            : Promise.resolve(
                picklistFieldByName
                  ? Array.from(picklistFieldByName.values())
                  : [],
              ),
          Promise.all(
            Array.from(contactIds).map(async (cid) => {
              try {
                const cr = await rawGetSingle(`/contacts/${cid}`, {
                  fields: "id,name",
                });
                return cr.data && typeof cr.data.id === "number"
                  ? { id: cr.data.id, name: cr.data.name as string | undefined }
                  : null;
              } catch {
                return null;
              }
            }),
          ),
        ]);

        const finalPicklistFieldByName =
          picklistFieldByName ??
          new Map<string, any>(
            (picklistFieldsForLabels as any[])
              .filter(
                (f) =>
                  f.field_type === "picklist" && Array.isArray(f.picklist_options),
              )
              .map((f) => [f.name, f]),
          );
        const contactNameById = new Map<number, string>();
        for (const c of contactRecords) {
          if (c && c.name) contactNameById.set(c.id, c.name);
        }

        const formatted = matched.map(({ matter, cfv, field_type }) => {
          const value = cfv.value ?? null;
          let valueLabel: string | null = null;
          if (value !== null) {
            if (field_type === "picklist") {
              const field = finalPicklistFieldByName.get(params.field_name);
              const opt = Array.isArray(field?.picklist_options)
                ? field.picklist_options.find((o: any) => o.id === value)
                : undefined;
              valueLabel = opt?.option ?? null;
            } else if (field_type === "contact") {
              valueLabel =
                typeof value === "number" ? contactNameById.get(value) ?? null : null;
            } else if (field_type === "checkbox") {
              valueLabel = value === true ? "Yes" : value === false ? "No" : null;
            }
          }
          return {
            id: matter.id,
            display_number: matter.display_number,
            description: matter.description,
            status: matter.status,
            billing_method: matter.billing_method ?? null,
            practice_area: matter.practice_area?.name ?? null,
            responsible_attorney: matter.responsible_attorney
              ? { id: matter.responsible_attorney.id, name: matter.responsible_attorney.name }
              : null,
            client: matter.client
              ? { id: matter.client.id, name: matter.client.name }
              : null,
            field_name: cfv.field_name,
            field_type,
            value,
            value_label: valueLabel,
          };
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              filter: {
                field_name: params.field_name,
                expected_value: params.expected_value ?? null,
                status: params.status ?? "open",
              },
              matters_scanned: matters.length,
              matters_with_field_set: firstPass.length,
              count: formatted.length,
              matters: formatted,
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
    "Get the custom field values set on a specific matter, with picklist option labels and contact names auto-resolved. Returns each value's id, field_name, field_type, raw value, and a human-readable value_label (when applicable — picklist option text, contact name, or 'Yes'/'No' for checkboxes). Use list_custom_fields to discover the schema (which fields exist firm-wide); use this tool to see what's actually set on one matter.",
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

        // Parse field_type from the CFV id prefix. Clio formats CFV ids as
        // "{field_type}-{numeric_id}" (e.g. "picklist-1532667664",
        // "text_line-7375737049", "contact-428026490"). Splitting on the
        // first "-" gives the type; the field_type names themselves never
        // contain "-" per Clio's enum.
        const parseFieldType = (id: unknown): string | null => {
          if (typeof id !== "string") return null;
          const idx = id.indexOf("-");
          return idx > 0 ? id.slice(0, idx) : null;
        };

        // Determine which lookups are needed.
        const hasPicklist = cfvs.some(
          (cfv) => parseFieldType(cfv.id) === "picklist" && cfv.value !== null && cfv.value !== undefined,
        );
        const contactIds = new Set<number>();
        for (const cfv of cfvs) {
          if (
            parseFieldType(cfv.id) === "contact" &&
            typeof cfv.value === "number"
          ) {
            contactIds.add(cfv.value);
          }
        }

        // Parallel resolution:
        //   - Matter CustomFields with picklist_options (one bulk call, only if needed)
        //   - Each referenced contact in parallel (each is a tiny per-contact GET)
        const [matterCustomFields, contactRecords] = await Promise.all([
          hasPicklist
            ? fetchAllPages<any>("/custom_fields", {
                fields: "id,name,field_type,picklist_options{id,option}",
                parent_type: "Matter",
              })
            : Promise.resolve([] as any[]),
          Promise.all(
            Array.from(contactIds).map(async (cid) => {
              try {
                const cr = await rawGetSingle(`/contacts/${cid}`, {
                  fields: "id,name",
                });
                return cr.data && typeof cr.data.id === "number"
                  ? { id: cr.data.id, name: cr.data.name as string | undefined }
                  : null;
              } catch {
                return null;
              }
            }),
          ),
        ]);

        // Build lookup maps.
        const picklistFieldByName = new Map<string, any>();
        for (const f of matterCustomFields) {
          if (f.field_type === "picklist" && Array.isArray(f.picklist_options)) {
            picklistFieldByName.set(f.name, f);
          }
        }
        const contactNameById = new Map<number, string>();
        for (const c of contactRecords) {
          if (c && c.name) contactNameById.set(c.id, c.name);
        }

        // Resolve each value's human-readable label where applicable.
        const formatted = cfvs.map((cfv) => {
          const fieldType = parseFieldType(cfv.id);
          let valueLabel: string | null = null;
          const value = cfv.value ?? null;
          if (value !== null) {
            if (fieldType === "picklist") {
              const field = picklistFieldByName.get(cfv.field_name);
              const opt = Array.isArray(field?.picklist_options)
                ? field.picklist_options.find((o: any) => o.id === value)
                : undefined;
              valueLabel = opt?.option ?? null;
            } else if (fieldType === "contact") {
              valueLabel =
                typeof value === "number" ? contactNameById.get(value) ?? null : null;
            } else if (fieldType === "checkbox") {
              valueLabel = value === true ? "Yes" : value === false ? "No" : null;
            }
            // text_line, text_area, currency, date, numeric, email, url:
            // value IS the human-readable representation; no separate label.
          }
          return {
            id: cfv.id,
            field_name: cfv.field_name ?? null,
            field_type: fieldType,
            value,
            value_label: valueLabel,
          };
        });

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
