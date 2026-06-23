import { describe, it, expect } from "vitest";
import { adjustedBillingMonth } from "../src/dashboard/billed";
import {
  isExcludedBillingMethod,
  classifyFeePlaceholders,
  type ContingencyEntry,
} from "../src/dashboard/excludedHours";

describe("adjustedBillingMonth (27th–7th billing-month rule, cutoff=7)", () => {
  const cut = 7;
  it("bills late in a month stay in that month (May 27/31 → May)", () => {
    expect(adjustedBillingMonth("05/27/2026", cut)).toEqual({ year: 2026, month: 5 });
    expect(adjustedBillingMonth("05/31/2026", cut)).toEqual({ year: 2026, month: 5 });
  });
  it("bills in the first cutoff days roll back to the prior month (Jun 1/7 → May)", () => {
    expect(adjustedBillingMonth("06/01/2026", cut)).toEqual({ year: 2026, month: 5 });
    expect(adjustedBillingMonth("06/07/2026", cut)).toEqual({ year: 2026, month: 5 });
  });
  it("bills after the cutoff stay in the calendar month (Jun 8 → June)", () => {
    expect(adjustedBillingMonth("06/08/2026", cut)).toEqual({ year: 2026, month: 6 });
    expect(adjustedBillingMonth("06/26/2026", cut)).toEqual({ year: 2026, month: 6 });
  });
  it("January rollback crosses the year boundary (Jan 3 2026 → Dec 2025)", () => {
    expect(adjustedBillingMonth("01/03/2026", cut)).toEqual({ year: 2025, month: 12 });
    expect(adjustedBillingMonth("01/15/2026", cut)).toEqual({ year: 2026, month: 1 });
  });
  it("early-January-next-year rolls back into December of the reporting year", () => {
    expect(adjustedBillingMonth("01/05/2027", cut)).toEqual({ year: 2026, month: 12 });
  });
  it("returns null for unparseable dates", () => {
    expect(adjustedBillingMonth("", cut)).toBeNull();
    expect(adjustedBillingMonth("2026-05-27", cut)).toBeNull();
  });
  it("honors a custom cutoff day", () => {
    expect(adjustedBillingMonth("06/02/2026", 1)).toEqual({ year: 2026, month: 6 }); // day 2 > cutoff 1 → stays
    expect(adjustedBillingMonth("06/01/2026", 1)).toEqual({ year: 2026, month: 5 }); // day 1 ≤ cutoff 1 → rolls back
  });
});

describe("isExcludedBillingMethod (contingency / flat-fee)", () => {
  it("flags contingency and flat-fee variants", () => {
    expect(isExcludedBillingMethod("contingency")).toBe(true);
    expect(isExcludedBillingMethod("Contingency")).toBe(true);
    expect(isExcludedBillingMethod("flat")).toBe(true);
    expect(isExcludedBillingMethod("flat_fee")).toBe(true);
    expect(isExcludedBillingMethod("Flat Rate")).toBe(true);
    expect(isExcludedBillingMethod("fixed")).toBe(true);
  });
  it("does not flag hourly / pro bono / empty", () => {
    expect(isExcludedBillingMethod("hourly")).toBe(false);
    expect(isExcludedBillingMethod("pro_bono")).toBe(false);
    expect(isExcludedBillingMethod("")).toBe(false);
    expect(isExcludedBillingMethod(undefined)).toBe(false);
    expect(isExcludedBillingMethod(null)).toBe(false);
  });
});

describe("classifyFeePlaceholders (1-hour off-rate fee dumps only)", () => {
  // user 1 bills at $450/hr; user 2 at $350/hr.
  const base: ContingencyEntry[] = [
    { uid: 1, month: 1, hours: 2.4, rate: 450 },  // real worked time
    { uid: 1, month: 1, hours: 0.6, rate: 450 },  // real worked time
    { uid: 2, month: 1, hours: 3.0, rate: 350 },  // real worked time
  ];

  it("excludes a 1h entry priced at the whole fee (rate ≠ standard)", () => {
    const out = classifyFeePlaceholders([...base, { uid: 1, month: 1, hours: 1.0, rate: 30000 }]);
    expect(out[1]?.[1]).toBeCloseTo(1.0, 5);
    // user 2 had no dump
    expect(out[1]?.[2]).toBeUndefined();
  });

  it("keeps real worked time on contingency/flat matters (multi-hour, any rate)", () => {
    const out = classifyFeePlaceholders(base);
    expect(out).toEqual({});
  });

  it("keeps a legitimate 1.0h entry billed at the standard rate", () => {
    const out = classifyFeePlaceholders([...base, { uid: 1, month: 2, hours: 1.0, rate: 450 }]);
    expect(out[2]).toBeUndefined();
  });

  it("the dump does not get to define the standard rate", () => {
    // Only a 1h $25k entry plus one real $450 entry → standard stays $450, dump excluded.
    const out = classifyFeePlaceholders([
      { uid: 9, month: 3, hours: 1.0, rate: 25000 },
      { uid: 9, month: 3, hours: 1.7, rate: 450 },
    ]);
    expect(out[3]?.[9]).toBeCloseTo(1.0, 5);
  });

  it("falls back to a high-rate ceiling when the user has no other entry to compare", () => {
    // Only a lone 1h $40k entry — no standard rate inferable → still flagged via fallback.
    const lone = classifyFeePlaceholders([{ uid: 5, month: 1, hours: 1.0, rate: 40000 }]);
    expect(lone[1]?.[5]).toBeCloseTo(1.0, 5);
    // A lone 1h entry at a plausible hourly rate is NOT flagged (can't prove it's a dump).
    const plausible = classifyFeePlaceholders([{ uid: 6, month: 1, hours: 1.0, rate: 450 }]);
    expect(plausible).toEqual({});
  });
});
