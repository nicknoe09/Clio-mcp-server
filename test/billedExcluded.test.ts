import { describe, it, expect } from "vitest";
import { adjustedBillingMonth } from "../src/dashboard/billed";
import { isExcludedBillingMethod } from "../src/dashboard/excludedHours";

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
