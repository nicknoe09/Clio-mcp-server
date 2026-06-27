import { describe, it, expect } from "vitest";
import { isIdentityMismatch } from "../src/clio/pagination";

describe("isIdentityMismatch — Clio token vs signed-in attorney", () => {
  it("no mismatch when emails are equal", () => {
    expect(isIdentityMismatch("kgonzalez@romanosumner.com", "kgonzalez@romanosumner.com")).toBe(false);
  });

  it("mismatch when the Clio token belongs to someone else", () => {
    // The Kenny-registered-as-Rachel case.
    expect(isIdentityMismatch("kgonzalez@romanosumner.com", "rtrevino@romanosumner.com")).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isIdentityMismatch("  Kenny@Firm.com ", "kenny@firm.com")).toBe(false);
  });

  it("fails open when either email is missing/unknown", () => {
    expect(isIdentityMismatch("", "kenny@firm.com")).toBe(false);
    expect(isIdentityMismatch("kenny@firm.com", "")).toBe(false);
    expect(isIdentityMismatch(undefined, undefined)).toBe(false);
  });
});
