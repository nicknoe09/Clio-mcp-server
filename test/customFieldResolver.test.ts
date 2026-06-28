import { describe, it, expect } from "vitest";
import { resolveCfvWireValue, type CustomFieldDef } from "../src/clio/customFieldResolver";

const picklist: CustomFieldDef = {
  id: 101,
  name: "Court",
  field_type: "picklist",
  picklist_options: [
    { id: 5001, option: "CCL1" },
    { id: 5002, option: "CCL6" },
  ],
};

describe("resolveCfvWireValue — picklist", () => {
  it("resolves an option label (case-insensitive) to the option id", () => {
    const r = resolveCfvWireValue(picklist, "ccl6");
    expect(r).toEqual({ ok: true, wireValue: "5002" });
  });

  it("accepts an option id directly and stringifies it", () => {
    const r = resolveCfvWireValue(picklist, 5001);
    expect(r).toEqual({ ok: true, wireValue: "5001" });
  });

  it("rejects an unknown option and lists the valid ones", () => {
    const r = resolveCfvWireValue(picklist, "CCL9");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.context).toBe("picklist_option_not_found");
      expect(r.valid_options).toEqual([
        { id: 5001, option: "CCL1" },
        { id: 5002, option: "CCL6" },
      ]);
    }
  });
});

describe("resolveCfvWireValue — contact", () => {
  const contact: CustomFieldDef = { id: 102, name: "Paralegal", field_type: "contact" };

  it("accepts a contact id (number) and stringifies it", () => {
    expect(resolveCfvWireValue(contact, 428026490)).toEqual({ ok: true, wireValue: "428026490" });
  });

  it("rejects a non-numeric contact value", () => {
    const r = resolveCfvWireValue(contact, "Jane Paralegal");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.context).toBe("value_type_mismatch");
  });
});

describe("resolveCfvWireValue — checkbox", () => {
  const checkbox: CustomFieldDef = { id: 103, name: "Contingency", field_type: "checkbox" };

  it("maps booleans to 'true'/'false'", () => {
    expect(resolveCfvWireValue(checkbox, true)).toEqual({ ok: true, wireValue: "true" });
    expect(resolveCfvWireValue(checkbox, false)).toEqual({ ok: true, wireValue: "false" });
  });

  it("rejects a non-boolean", () => {
    const r = resolveCfvWireValue(checkbox, "yes");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.context).toBe("value_type_mismatch");
  });
});

describe("resolveCfvWireValue — passthrough types", () => {
  it("passes a text value through unchanged", () => {
    const text: CustomFieldDef = { id: 104, name: "Cause #", field_type: "text_line" };
    expect(resolveCfvWireValue(text, "2024-CV-12345")).toEqual({ ok: true, wireValue: "2024-CV-12345" });
  });

  it("stringifies a numeric currency value", () => {
    const currency: CustomFieldDef = { id: 105, name: "Hourly Rate", field_type: "currency" };
    expect(resolveCfvWireValue(currency, 300)).toEqual({ ok: true, wireValue: "300" });
  });
});
