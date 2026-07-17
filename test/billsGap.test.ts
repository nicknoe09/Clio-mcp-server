import { describe, it, expect } from "vitest";
import { formatBillableMatter } from "../src/tools/billsGap";

describe("formatBillableMatter", () => {
  it("maps currency_code to currency and surfaces WIP fields", () => {
    const m = formatBillableMatter({
      id: 5,
      display_number: "00012-Smith",
      client: { id: 9, name: "Smith" },
      unbilled_hours: 3.5,
      unbilled_amount: 1225,
      amount_in_trust: 500,
      currency_code: "USD",
    });
    expect(m).toEqual({
      id: 5,
      display_number: "00012-Smith",
      client: { id: 9, name: "Smith" },
      unbilled_hours: 3.5,
      unbilled_amount: 1225,
      amount_in_trust: 500,
      currency: "USD",
    });
  });

  it("tolerates an empty object", () => {
    expect(formatBillableMatter({}).id).toBeUndefined();
  });
});
