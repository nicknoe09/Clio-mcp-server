import { describe, it, expect, beforeEach } from "vitest";
import { readTokenScopes, growScopeReport } from "../src/tools/grow";

/** Build a fake JWT (header.payload.signature) carrying the given payload. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
}

describe("readTokenScopes", () => {
  it("reads Hydra-style `scp` array claims", () => {
    const token = jwt({ scp: ["grow_contact_read", "grow_matter_read"] });
    expect(readTokenScopes(token)).toEqual(["grow_contact_read", "grow_matter_read"]);
  });

  it("reads space-delimited `scope` string claims", () => {
    const token = jwt({ scope: "grow_contact_read grow_matter_read" });
    expect(readTokenScopes(token)).toEqual(["grow_contact_read", "grow_matter_read"]);
  });

  it("returns [] for a JWT with no scope claim (distinct from opaque)", () => {
    expect(readTokenScopes(jwt({ sub: "abc" }))).toEqual([]);
  });

  it("returns null for opaque (non-JWT) tokens and missing tokens", () => {
    expect(readTokenScopes("opaque-random-token")).toBeNull();
    expect(readTokenScopes(undefined)).toBeNull();
  });

  it("returns null when the payload segment is not valid base64/JSON", () => {
    expect(readTokenScopes("aaa.!!!not-json!!!.ccc")).toBeNull();
  });
});

describe("growScopeReport", () => {
  beforeEach(() => {
    process.env.GROW_OAUTH_SCOPE =
      "grow_contact_read grow_matter_read grow_matter_note_read";
  });

  it("flags the scopes a re-consent would add (requested minus granted)", () => {
    const token = jwt({ scp: ["grow_contact_read", "grow_matter_read"] });
    const report = growScopeReport(token);
    expect(report.requested_scope).toEqual([
      "grow_contact_read",
      "grow_matter_read",
      "grow_matter_note_read",
    ]);
    expect(report.token_scope).toEqual(["grow_contact_read", "grow_matter_read"]);
    // The stored token predates the note scope → surfaced as missing.
    expect(report.missing_scope).toEqual(["grow_matter_note_read"]);
  });

  it("reports no missing scopes when the token carries everything requested", () => {
    const token = jwt({
      scp: ["grow_contact_read", "grow_matter_read", "grow_matter_note_read"],
    });
    expect(growScopeReport(token).missing_scope).toEqual([]);
  });

  it("null missing_scope + a note when the token is opaque", () => {
    const report = growScopeReport("opaque-token");
    expect(report.token_scope).toBeNull();
    expect(report.missing_scope).toBeNull();
    expect(report.scope_note).toContain("/grow/oauth/start");
  });
});
