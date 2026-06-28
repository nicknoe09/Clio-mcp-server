import { fetchAllPages } from "./pagination";

// ============================================================
//  Custom-field resolver — shared by create_contact / create_matter
// ============================================================
// Clio writes custom field values on the parent resource via the
// `custom_field_values` association:
//   custom_field_values: [{ custom_field: { id }, value }]
// On CREATE (POST) there is no existing CustomFieldValue, so each entry is
// just { custom_field: { id }, value } — no entry id, no _destroy.
//
// The tricky part is the `value` wire shape, which depends on field_type:
//   - picklist : the OPTION id (number), NOT the option text. Callers may
//                pass either the option label (string, case-insensitive) or
//                the option id (number); we resolve a label to its id.
//   - contact  : the contact id (number).
//   - checkbox : "true" / "false".
//   - everything else (text_line, text_area, date, currency, numeric,
//                email, url): the value passed through as a string.
// Clio's OpenAPI types `value` as a string and coerces server-side, so we
// stringify the resolved value. This mirrors set_matter_custom_field_value's
// proven resolution logic so the two write paths stay consistent.

export type CustomFieldInput = {
  /** Exact CustomField name (case-sensitive). One of field_name / custom_field_id is required. */
  field_name?: string;
  /** CustomField id, if known. Takes precedence over field_name when both are given. */
  custom_field_id?: number;
  /**
   * For picklist: option label (string) or option id (number).
   * For contact: contact id (number). For checkbox: boolean.
   * For text/date/currency/numeric/email/url: string (or number, stringified).
   */
  value: string | number | boolean;
};

/** A picklist option as returned by /custom_fields?fields=...,picklist_options{id,option}. */
export type PicklistOption = { id: number; option?: string };

/** A CustomField definition (subset of fields we need to resolve a value). */
export type CustomFieldDef = {
  id: number;
  name: string;
  field_type: string;
  deleted?: boolean;
  picklist_options?: PicklistOption[];
};

export type WireValueOk = { ok: true; wireValue: string };
export type WireValueErr = {
  ok: false;
  message: string;
  context: string;
  valid_options?: PicklistOption[];
};

/**
 * Resolve a single input value into the string wire shape Clio expects for the
 * given CustomField, applying field-type-aware validation. Pure (no I/O) so it
 * can be unit-tested. Does NOT handle clearing (create has no value to clear).
 */
export function resolveCfvWireValue(
  field: CustomFieldDef,
  value: string | number | boolean,
): WireValueOk | WireValueErr {
  const fieldType = field.field_type;

  if (fieldType === "checkbox") {
    if (typeof value !== "boolean") {
      return {
        ok: false,
        context: "value_type_mismatch",
        message: `Field "${field.name}" is a checkbox; value must be true or false (got ${typeof value}).`,
      };
    }
    return { ok: true, wireValue: value ? "true" : "false" };
  }

  if (fieldType === "picklist") {
    const opts = Array.isArray(field.picklist_options) ? field.picklist_options : [];
    let optionId: number | null = null;
    if (typeof value === "number") {
      optionId = opts.find((o) => o.id === value)?.id ?? null;
    } else if (typeof value === "string") {
      const lower = value.toLowerCase();
      optionId =
        opts.find(
          (o) => typeof o.option === "string" && o.option.toLowerCase() === lower,
        )?.id ?? null;
    }
    if (optionId === null) {
      return {
        ok: false,
        context: "picklist_option_not_found",
        message: `Value "${value}" doesn't match any option on picklist "${field.name}". Valid options: ${opts
          .map((o) => o.option)
          .filter(Boolean)
          .join(" | ")}`,
        valid_options: opts.map((o) => ({ id: o.id, option: o.option })),
      };
    }
    return { ok: true, wireValue: String(optionId) };
  }

  if (fieldType === "contact") {
    if (typeof value !== "number") {
      return {
        ok: false,
        context: "value_type_mismatch",
        message: `Field "${field.name}" is a contact field; value must be a contact_id (number).`,
      };
    }
    return { ok: true, wireValue: String(value) };
  }

  // text_line, text_area, date, currency, numeric, email, url
  return { ok: true, wireValue: typeof value === "string" ? value : String(value) };
}

/** A successfully resolved custom_field_values entry, ready to embed in a POST body. */
export type ResolvedCfvEntry = { custom_field: { id: number }; value: string };

export type ResolvedField = {
  custom_field_id: number;
  field_name: string;
  field_type: string;
  input_value: string | number | boolean;
  wire_value: string;
};

export type CfvResolutionError = {
  input: CustomFieldInput;
  message: string;
  context: string;
  valid_options?: PicklistOption[];
};

export type CfvResolution = {
  /** Entries to drop into data.custom_field_values on the POST. */
  entries: ResolvedCfvEntry[];
  /** Human-readable summary of what resolved, for the tool's response. */
  resolved: ResolvedField[];
  /** Any inputs that failed to resolve (unknown field, bad picklist option, type mismatch). */
  errors: CfvResolutionError[];
};

/**
 * Resolve a list of custom-field inputs for a CREATE on the given parent type
 * ("Contact" or "Matter"). Fetches the CustomField definitions once (with
 * picklist options) and resolves each input against them. Inputs that can't be
 * resolved are collected in `errors` rather than throwing, so the caller can
 * decide whether to abort or surface them.
 */
export async function resolveCustomFieldsForCreate(
  parentType: "Contact" | "Matter",
  inputs: CustomFieldInput[],
): Promise<CfvResolution> {
  const result: CfvResolution = { entries: [], resolved: [], errors: [] };
  if (!inputs || inputs.length === 0) return result;

  const fields = await fetchAllPages<CustomFieldDef>("/custom_fields", {
    fields: "id,name,field_type,deleted,picklist_options{id,option}",
    parent_type: parentType,
  });

  for (const input of inputs) {
    if (input.custom_field_id === undefined && !input.field_name) {
      result.errors.push({
        input,
        context: "missing_identifier",
        message: "Each custom field entry needs a field_name or custom_field_id.",
      });
      continue;
    }

    const field = fields.find((f) =>
      input.custom_field_id !== undefined
        ? f.id === input.custom_field_id && !f.deleted
        : f.name === input.field_name && !f.deleted,
    );
    if (!field) {
      const ident =
        input.custom_field_id !== undefined
          ? `id ${input.custom_field_id}`
          : `name "${input.field_name}"`;
      result.errors.push({
        input,
        context: "custom_field_not_found",
        message: `No ${parentType} CustomField with ${ident}. Use list_custom_fields(parent_type="${parentType}") to see valid fields.`,
      });
      continue;
    }

    const resolved = resolveCfvWireValue(field, input.value);
    if (!resolved.ok) {
      result.errors.push({
        input,
        context: resolved.context,
        message: resolved.message,
        valid_options: resolved.valid_options,
      });
      continue;
    }

    result.entries.push({ custom_field: { id: field.id }, value: resolved.wireValue });
    result.resolved.push({
      custom_field_id: field.id,
      field_name: field.name,
      field_type: field.field_type,
      input_value: input.value,
      wire_value: resolved.wireValue,
    });
  }

  return result;
}
