import { describe, it, expect } from "vitest";
import { resolveTimeEntryScope, TIME_ENTRY_STATUSES } from "../src/tools/time";

// Regression tests for the 2026-07-02 report: get_time_entries(billed="false")
// returned 0 entries for matters whose draft bill was demonstrably full.
// Draft-bill entries are status="draft" (not "unbilled") AND billed=true in
// Clio, so both the old server-side mapping and the old client-side flag
// filter excluded them. status="draft" is the supported pull path now.
describe("resolveTimeEntryScope", () => {
  it('status="draft" passes through server-side with NO client billed filter', () => {
    const scope = resolveTimeEntryScope("all", "draft");
    expect(scope.serverStatus).toBe("draft");
    // Draft entries carry billed=true — a client-side flag filter would
    // empty the result set again. It must be absent.
    expect(scope.clientBilled).toBeUndefined();
  });

  it("every Clio status value passes through untouched", () => {
    for (const status of TIME_ENTRY_STATUSES) {
      expect(resolveTimeEntryScope("all", status).serverStatus).toBe(status);
    }
  });

  it('billed="false" stays strictly unbilled (server + client filters)', () => {
    const scope = resolveTimeEntryScope("false");
    expect(scope.serverStatus).toBe("unbilled");
    expect(scope.clientBilled).toBe(false);
  });

  it('billed="true" filters client-side only (status="billed" would miss draft entries)', () => {
    const scope = resolveTimeEntryScope("true");
    expect(scope.serverStatus).toBeUndefined();
    expect(scope.clientBilled).toBe(true);
  });

  it('billed="all" with no status applies no filters', () => {
    expect(resolveTimeEntryScope("all")).toEqual({});
  });

  it("rejects ambiguous billed + status combinations", () => {
    expect(() => resolveTimeEntryScope("false", "draft")).toThrow(/Ambiguous/);
    expect(() => resolveTimeEntryScope("true", "unbilled")).toThrow(/Ambiguous/);
  });
});
