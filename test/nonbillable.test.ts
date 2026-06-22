import { describe, it, expect } from "vitest";
import { CATEGORY_PREFIXES } from "../src/dashboard/nonbillable";

// Pins the firm's admin matter numbers so the nonbillable categories can't silently
// regress. Other Admin must be 02888 (the live "02888-Admin" matter) — it was 00158,
// which never existed, so Other Admin pulled 0.0 for everyone and collapsed Total Hrs.
describe("nonbillable CATEGORY_PREFIXES", () => {
  const byKey = Object.fromEntries(CATEGORY_PREFIXES.map((c) => [c.key, c.prefixes]));

  it("Other Admin points at 02888 (not the nonexistent 00158)", () => {
    expect(byKey.otherAdmin).toEqual(["02888"]);
    expect(byKey.otherAdmin).not.toContain("00158");
  });

  it("Biz Dev includes both Business Development (00706) and Website (00316)", () => {
    expect(byKey.bizDev).toEqual(expect.arrayContaining(["00706", "00316"]));
  });

  it("Potential Clients = 00050, CLE = 00707", () => {
    expect(byKey.potentialClients).toEqual(["00050"]);
    expect(byKey.cle).toEqual(["00707"]);
  });

  it("covers exactly the four tracked categories", () => {
    expect(CATEGORY_PREFIXES.map((c) => c.key).sort()).toEqual(
      ["bizDev", "cle", "otherAdmin", "potentialClients"],
    );
  });
});
