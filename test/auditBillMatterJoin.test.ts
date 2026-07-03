import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { matchBillMatter } from "../src/tools/audit";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

// Regression tests for the 2026-07-02 audit undercount (94 draft bills
// counted vs 95 found by authoritative per-matter get_bills scoping): the
// old join checked only bill.matters[0], silently dropping any bill whose
// relevant matter wasn't in the first position.
describe("matchBillMatter", () => {
  const matterIds = new Set([101, 102]);

  it("matches a bill whose matter is first", () => {
    expect(matchBillMatter({ matters: [{ id: 101 }] }, matterIds)).toBe(101);
  });

  it("matches a bill whose matter is NOT in position 0 (the dropped-bill bug)", () => {
    expect(matchBillMatter({ matters: [{ id: 999 }, { id: 102 }] }, matterIds)).toBe(102);
  });

  it("returns the matched matter id, not blindly matters[0]", () => {
    // The per-bill matter lookup must use the matter that joined, otherwise
    // line items get attributed to a matter outside the audit scope.
    const bill = { matters: [{ id: 999 }, { id: 101 }] };
    expect(matchBillMatter(bill, matterIds)).toBe(101);
  });

  it("returns null for bills with no matching matter", () => {
    expect(matchBillMatter({ matters: [{ id: 999 }] }, matterIds)).toBeNull();
  });

  it("returns null for bills with no matter reference at all", () => {
    expect(matchBillMatter({}, matterIds)).toBeNull();
    expect(matchBillMatter({ matters: [] }, matterIds)).toBeNull();
    expect(matchBillMatter({ matters: [null, { id: undefined }] as any }, matterIds)).toBeNull();
  });
});

describe("audit draft-bill scoping code", () => {
  it("no matters[0]-only join remains in audit.ts", () => {
    // Both audit_draft_bills and download_bill_audit must scope bills via
    // matchBillMatter. Guard against the first-position-only check returning.
    const code = src("src/tools/audit.ts")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/matters\?\.\[0\]\s*;?\s*\n?.*matterIds\.has/);
    expect(code).not.toMatch(/const matterId = bill\.matters\?\.\[0\]/);
  });
});
