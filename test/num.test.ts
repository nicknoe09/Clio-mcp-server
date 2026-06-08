import { describe, it, expect } from "vitest";
import { round2, round1, fmt } from "../src/utils/num";

describe("num", () => {
  it("round2", () => {
    expect(round2(3.14159)).toBe(3.14);
    expect(round2(1.999)).toBe(2);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1234.5678)).toBe(1234.57);
  });
  it("round1", () => {
    expect(round1(1.25)).toBe(1.3);
    expect(round1(1.24)).toBe(1.2);
  });
  it("fmt", () => {
    expect(fmt(1234.5)).toBe("$1,234.50");
    expect(fmt(0)).toBe("$0.00");
    expect(fmt(null)).toBe("");
    expect(fmt(undefined)).toBe("");
  });
});
