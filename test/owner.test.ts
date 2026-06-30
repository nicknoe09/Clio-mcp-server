import { describe, it, expect, afterEach } from "vitest";
import { isOwnerEmail, getOwnerEmails } from "../src/clio/owner";

describe("isOwnerEmail — owner-only custom calendaring gate", () => {
  const owners = ["nnoe@romanosumner.com"];

  it("matches the configured owner email", () => {
    expect(isOwnerEmail("nnoe@romanosumner.com", owners)).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isOwnerEmail("  NNoe@RomanoSumner.com ", owners)).toBe(true);
  });

  it("rejects any other firm user", () => {
    expect(isOwnerEmail("kgonzalez@romanosumner.com", owners)).toBe(false);
  });

  it("treats a missing/blank email as not the owner (fail-closed)", () => {
    expect(isOwnerEmail(undefined, owners)).toBe(false);
    expect(isOwnerEmail("", owners)).toBe(false);
    expect(isOwnerEmail("   ", owners)).toBe(false);
  });

  it("supports multiple configured owners", () => {
    const many = ["a@firm.com", "b@firm.com"];
    expect(isOwnerEmail("b@firm.com", many)).toBe(true);
    expect(isOwnerEmail("c@firm.com", many)).toBe(false);
  });
});

describe("getOwnerEmails — env parsing", () => {
  const original = process.env.OWNER_EMAILS;
  afterEach(() => {
    if (original === undefined) delete process.env.OWNER_EMAILS;
    else process.env.OWNER_EMAILS = original;
  });

  it("defaults to the original author when unset", () => {
    delete process.env.OWNER_EMAILS;
    expect(getOwnerEmails()).toEqual(["nnoe@romanosumner.com"]);
  });

  it("parses a comma-separated list, trimmed and lowercased", () => {
    process.env.OWNER_EMAILS = " First@Firm.com , second@firm.com ";
    expect(getOwnerEmails()).toEqual(["first@firm.com", "second@firm.com"]);
  });

  it("drops empty entries", () => {
    process.env.OWNER_EMAILS = "a@firm.com,,";
    expect(getOwnerEmails()).toEqual(["a@firm.com"]);
  });
});
