import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BILL_LINE_ITEM_FIELDS } from "../src/tools/bills";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

// Regression guard for the get_bill_line_items timeout (reported 2026-07-02):
// timekeepers were resolved with one GET /activities/{id} per line in an
// unbounded Promise.all, so bills with >~50 lines hit Clio's rate limit and
// the 429 backoff pushed the call past the connector gateway timeout. The fix
// pulls user{id,name} directly on /line_items (1-level nesting, which Clio
// supports — same selector the draft-bill audit uses) and deletes the fan-out.
describe("get_bill_line_items field selector", () => {
  it("requests user{id,name} on /line_items directly", () => {
    expect(BILL_LINE_ITEM_FIELDS).toContain("user{id,name}");
  });

  it("does not use 2-level nesting (400 InvalidFields on /line_items)", () => {
    // e.g. activity{id,user{id,name}} — the PR #110 bug.
    expect(BILL_LINE_ITEM_FIELDS).not.toMatch(/\{[^}]*\{/);
  });

  it("does not request rounded_quantity (invalid on /line_items)", () => {
    expect(BILL_LINE_ITEM_FIELDS).not.toContain("rounded_quantity");
  });

  it("has no per-activity timekeeper fan-out in bills.ts", () => {
    // The timeout came from `activityIds.map(... rawGetSingle("/activities/…"))`
    // inside get_bill_line_items. Guard against the pattern reappearing: no
    // /activities/${...} GET may sit inside a .map( callback in this file.
    const code = src("src/tools/bills.ts")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/\.map\([^)]*rawGetSingle\(`\/activities\//);
  });
});
