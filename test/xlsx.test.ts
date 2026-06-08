import { describe, it, expect } from "vitest";
import { colToNum } from "../src/utils/xlsx";

describe("colToNum", () => {
  it("maps Excel column letters to 1-based numbers", () => {
    expect(colToNum("A")).toBe(1);
    expect(colToNum("Z")).toBe(26);
    expect(colToNum("AA")).toBe(27);
    expect(colToNum("N")).toBe(14);
    expect(colToNum("S")).toBe(19);
  });
});
