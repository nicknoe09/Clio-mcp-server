import { describe, it, expect } from "vitest";
import { formatLink } from "../src/tools/clioPayments";

describe("formatLink", () => {
  it("surfaces the pay-now url, target bill, and collected payment", () => {
    const l = formatLink({
      id: 11,
      url: "https://pay.clio.com/abc",
      amount: 500,
      currency: "USD",
      active: true,
      expires_at: "2026-09-01T00:00:00Z",
      bill: { id: 77, number: "INV-77" },
      contact: { id: 42, name: "Smith" },
      clio_payments_payment: { id: 9, state: "completed", amount: 500 },
    });
    expect(l.url).toBe("https://pay.clio.com/abc");
    expect(l.bill).toEqual({ id: 77, number: "INV-77" });
    expect(l.payment).toEqual({ id: 9, state: "completed", amount: 500 });
    expect(l.active).toBe(true);
  });

  it("tolerates an empty object", () => {
    expect(formatLink({}).id).toBeUndefined();
    expect(formatLink({}).payment).toBeUndefined();
  });
});
