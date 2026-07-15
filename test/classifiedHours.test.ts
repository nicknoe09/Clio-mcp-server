import { describe, it, expect } from "vitest";
import { classifyRawEntries, isNonBillableEntry, type RawTimeEntry } from "../src/dashboard/classifiedHours";

const entry = (over: Partial<RawTimeEntry>): RawTimeEntry => ({
  id: 1, uid: 100, userName: "Test User", date: "2026-03-05",
  hours: 2, rate: 400, matterId: 555, nonBillableFlag: false,
  ...over,
});

describe("isNonBillableEntry", () => {
  it("is true only for a strict non_billable === true", () => {
    expect(isNonBillableEntry(true)).toBe(true);
    expect(isNonBillableEntry(false)).toBe(false);
    expect(isNonBillableEntry(undefined)).toBe(false);
    expect(isNonBillableEntry(null)).toBe(false);
    expect(isNonBillableEntry("true")).toBe(false); // never coerce
  });
});

describe("classifyRawEntries (strictly by the Clio non_billable flag)", () => {
  it("a non_billable entry at a dollar rate on a client (non-admin) matter is nonbillable", () => {
    // The Kenny Sumner bug: internal work booked at his $525 standard rate but
    // flagged non-billable in Clio was counted billable by the old matter/rate rules.
    const out = classifyRawEntries(
      [entry({ id: 1, matterId: 555, rate: 525, nonBillableFlag: true })],
      new Set(),
    );
    expect(out[0].cls).toBe("nonbillable");
  });

  it("classifies by the flag alone — rate and matter never flip the decision", () => {
    const out = classifyRawEntries(
      [
        entry({ id: 1, rate: 525, nonBillableFlag: true }),   // rated + flagged → nonbillable
        entry({ id: 2, rate: 0, nonBillableFlag: true }),     // zero-rate + flagged → nonbillable
        entry({ id: 3, rate: 0, nonBillableFlag: false }),    // zero-priced client work → billable
        entry({ id: 4, rate: 400, nonBillableFlag: false }),  // ordinary rated work → billable
        entry({ id: 5, matterId: undefined, nonBillableFlag: false }), // no matter → still flag-based
      ],
      new Set(),
    );
    expect(out.map((e) => e.cls)).toEqual(["nonbillable", "nonbillable", "billable", "billable", "billable"]);
  });

  it("drops identified fee placeholders into excluded", () => {
    const out = classifyRawEntries(
      [entry({ id: 7, matterId: 555, hours: 1, rate: 25000 }), entry({ id: 8 })],
      new Set([7]),
    );
    expect(out.find((e) => e.id === 7)!.cls).toBe("excluded");
    expect(out.find((e) => e.id === 8)!.cls).toBe("billable");
  });

  it("the non_billable flag wins over the excluded set — a flagged entry never leaves nonbillable", () => {
    const out = classifyRawEntries(
      [entry({ id: 9, nonBillableFlag: true })],
      new Set([9]),
    );
    expect(out[0].cls).toBe("nonbillable");
  });

  it("partitions every entry into exactly one bucket (billable + nonbillable + excluded == total)", () => {
    const raw = [
      entry({ id: 1, hours: 3.2, nonBillableFlag: false }),
      entry({ id: 2, hours: 1.0, rate: 25000, nonBillableFlag: false }), // placeholder
      entry({ id: 3, hours: 5.4, rate: 525, nonBillableFlag: true }),
      entry({ id: 4, hours: 0.6, rate: 0, nonBillableFlag: true }),
    ];
    const out = classifyRawEntries(raw, new Set([2]));
    const sum = (cls: string) => out.filter((e) => e.cls === cls).reduce((s, e) => s + e.hours, 0);
    const total = raw.reduce((s, e) => s + e.hours, 0);
    expect(sum("billable") + sum("nonbillable") + sum("excluded")).toBeCloseTo(total, 10);
    expect(sum("billable")).toBeCloseTo(3.2, 10);
    expect(sum("nonbillable")).toBeCloseTo(6.0, 10);
    expect(sum("excluded")).toBeCloseTo(1.0, 10);
  });

  it("reproduces Kenny Sumner's 2026-07-06..12 week: flag-based billable 48.4 / nonbillable 52.0 of 100.4 total", () => {
    // Condensed from the authoritative reproduction: 27.0h on tracked admin
    // matters, 25.0h on internal RomSum/joint-venture matters at his $525 rate
    // but flagged non-billable (the 24.6h Marketing+Finance gap plus 0.4h), and
    // 48.4h of real client work. The old matter/rate rules reported 73.4/27.0.
    const raw = [
      entry({ id: 1, uid: 344134017, hours: 48.4, rate: 525, nonBillableFlag: false }), // client work
      entry({ id: 2, uid: 344134017, hours: 21.8, rate: 525, nonBillableFlag: true }),  // 03595-RomSum - Marketing
      entry({ id: 3, uid: 344134017, hours: 2.8, rate: 525, nonBillableFlag: true }),   // 03593-RomSum - Finance
      entry({ id: 4, uid: 344134017, hours: 0.4, rate: 525, nonBillableFlag: true }),   // 03160-Joint Venture
      entry({ id: 5, uid: 344134017, hours: 27.0, rate: 0, nonBillableFlag: true }),    // tracked admin matters
    ];
    const out = classifyRawEntries(raw, new Set());
    const billable = out.filter((e) => e.cls === "billable").reduce((s, e) => s + e.hours, 0);
    const nonbillable = out.filter((e) => e.cls === "nonbillable").reduce((s, e) => s + e.hours, 0);
    expect(billable).toBeCloseTo(48.4, 10);
    expect(nonbillable).toBeCloseTo(52.0, 10);
    expect(billable + nonbillable).toBeCloseTo(100.4, 10);
  });

  it("preserves id/uid/userName/date/hours passthrough", () => {
    const out = classifyRawEntries(
      [entry({ id: 42, uid: 7, userName: "PAR", date: "2026-01-02", hours: 1.5 })],
      new Set(),
    );
    expect(out[0]).toEqual({ id: 42, uid: 7, userName: "PAR", date: "2026-01-02", hours: 1.5, cls: "billable" });
  });
});
