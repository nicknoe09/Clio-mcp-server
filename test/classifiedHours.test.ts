import { describe, it, expect } from "vitest";
import { classifyRawEntries, type RawTimeEntry } from "../src/dashboard/classifiedHours";

const entry = (over: Partial<RawTimeEntry>): RawTimeEntry => ({
  id: 1, uid: 100, userName: "Test User", date: "2026-03-05",
  hours: 2, rate: 400, matterId: 555, nonBillableFlag: false,
  ...over,
});

describe("classifyRawEntries", () => {
  const adminIds = new Set([901, 902]);

  it("classifies admin-matter time as nonbillable regardless of price or flag", () => {
    const out = classifyRawEntries(
      [
        entry({ id: 1, matterId: 901, rate: 400 }),               // rated CLE-style entry
        entry({ id: 2, matterId: 902, rate: 0, nonBillableFlag: true }),
      ],
      adminIds, new Set(),
    );
    expect(out.map((e) => e.cls)).toEqual(["nonbillable", "nonbillable"]);
  });

  it("classifies zero-priced client-matter entries as billable (col I = total − admin)", () => {
    const out = classifyRawEntries(
      [entry({ id: 1, matterId: 555, rate: 0, nonBillableFlag: true })],
      adminIds, new Set(),
    );
    expect(out[0].cls).toBe("billable");
  });

  it("drops identified fee placeholders into excluded", () => {
    const out = classifyRawEntries(
      [entry({ id: 7, matterId: 555, hours: 1, rate: 25000 }), entry({ id: 8 })],
      adminIds, new Set([7]),
    );
    expect(out.find((e) => e.id === 7)!.cls).toBe("excluded");
    expect(out.find((e) => e.id === 8)!.cls).toBe("billable");
  });

  it("admin membership wins over the excluded set", () => {
    const out = classifyRawEntries(
      [entry({ id: 9, matterId: 901 })],
      adminIds, new Set([9]),
    );
    expect(out[0].cls).toBe("nonbillable");
  });

  it("entries with no matter are billable (never admin) unless excluded", () => {
    const out = classifyRawEntries([entry({ id: 3, matterId: undefined })], adminIds, new Set());
    expect(out[0].cls).toBe("billable");
  });

  it("preserves id/uid/userName/date/hours passthrough", () => {
    const out = classifyRawEntries(
      [entry({ id: 42, uid: 7, userName: "PAR", date: "2026-01-02", hours: 1.5 })],
      adminIds, new Set(),
    );
    expect(out[0]).toEqual({ id: 42, uid: 7, userName: "PAR", date: "2026-01-02", hours: 1.5, cls: "billable" });
  });
});
