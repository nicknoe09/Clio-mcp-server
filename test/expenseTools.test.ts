import { describe, it, expect } from "vitest";
import { resolveExpenseCategory, deriveConversionAmount, ExpenseCategoryRef } from "../src/tools/expenses";

const CATS: ExpenseCategoryRef[] = [
  { id: 1, name: "Filing Fees" },
  { id: 2, name: "Postage" },
  { id: 3, name: "Court Reporter Fees" },
  { id: 4, name: "Expert Fees" },
];

describe("resolveExpenseCategory", () => {
  it("resolves by id", () => {
    expect(resolveExpenseCategory(CATS, { id: 2 })).toEqual({ id: 2, name: "Postage" });
  });

  it("throws on unknown id with available list", () => {
    expect(() => resolveExpenseCategory(CATS, { id: 99 })).toThrow(/not found.*Filing Fees \(1\)/s);
  });

  it("resolves by exact name, case-insensitively", () => {
    expect(resolveExpenseCategory(CATS, { name: "filing fees" })).toEqual({ id: 1, name: "Filing Fees" });
    expect(resolveExpenseCategory(CATS, { name: "POSTAGE" })).toEqual({ id: 2, name: "Postage" });
  });

  it("resolves by unique substring", () => {
    expect(resolveExpenseCategory(CATS, { name: "postag" })).toEqual({ id: 2, name: "Postage" });
    expect(resolveExpenseCategory(CATS, { name: "reporter" })).toEqual({ id: 3, name: "Court Reporter Fees" });
  });

  it("prefers exact match over substring when both would hit", () => {
    const cats = [...CATS, { id: 5, name: "Fees" }];
    // "fees" is an exact match for "Fees" even though it's a substring of three others
    expect(resolveExpenseCategory(cats, { name: "fees" })).toEqual({ id: 5, name: "Fees" });
  });

  it("throws on ambiguous substring, listing the candidates", () => {
    expect(() => resolveExpenseCategory(CATS, { name: "fees" })).toThrow(/ambiguous.*Filing Fees.*Court Reporter Fees.*Expert Fees/s);
  });

  it("throws on no match, listing available categories", () => {
    expect(() => resolveExpenseCategory(CATS, { name: "mileage" })).toThrow(/not found.*Postage/s);
  });

  it("id takes precedence when both id and name are given", () => {
    expect(resolveExpenseCategory(CATS, { id: 3, name: "Postage" })).toEqual({ id: 3, name: "Court Reporter Fees" });
  });

  it("throws when neither id nor name is given", () => {
    expect(() => resolveExpenseCategory(CATS, {})).toThrow(/provide expense_category_id or expense_category_name/);
  });

  it("handles an empty category list", () => {
    expect(() => resolveExpenseCategory([], { name: "anything" })).toThrow(/not found/);
    expect(() => resolveExpenseCategory([], { id: 1 })).toThrow(/not found/);
  });
});

describe("deriveConversionAmount", () => {
  it("computes hours × rate from rounded_quantity (seconds)", () => {
    // 0.5h at $450/hr = $225
    expect(deriveConversionAmount({ rounded_quantity: 1800, quantity: 1750, price: 450 })).toBe(225);
  });

  it("falls back to quantity when rounded_quantity is missing", () => {
    // 2h at $300/hr = $600
    expect(deriveConversionAmount({ quantity: 7200, price: 300 })).toBe(600);
  });

  it("returns 0 for a non-billable entry (no rate)", () => {
    expect(deriveConversionAmount({ quantity: 3600 })).toBe(0);
    expect(deriveConversionAmount({ quantity: 3600, price: 0 })).toBe(0);
  });

  it("returns 0 when there is no duration", () => {
    expect(deriveConversionAmount({ price: 450 })).toBe(0);
  });

  it("rounds to cents", () => {
    // 0.1h (360s) at $333/hr = $33.30
    expect(deriveConversionAmount({ quantity: 360, price: 333 })).toBe(33.3);
    // 1/3 h at $100 = 33.333... → 33.33
    expect(deriveConversionAmount({ quantity: 1200, price: 100 })).toBe(33.33);
  });
});
