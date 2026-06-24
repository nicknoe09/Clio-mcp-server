import { describe, it, expect } from "vitest";
import { deriveHoursPartition } from "../src/dashboard/workedHours";

// Locks the 26 Compare hours partition: Billable (col I) = Total worked (col J) −
// Nonbillable (col H), DERIVED. This is the fix for the inflated col I (Paul, March:
// the issue-date Revenue value 282 / Total 352.6 instead of worked ~250 / 323.4).
// The invariant that matters: col I + col H == col J == the manual Activities total.
describe("deriveHoursPartition (26 Compare cols I/H/J)", () => {
  it("derives billable as total − nonbillable", () => {
    const { billable } = deriveHoursPartition(323.4, 70.6);
    expect(billable).toBeCloseTo(252.8, 5);
  });

  it("guarantees billable + nonbillable == total (col I + col H == col J)", () => {
    for (const [total, nb] of [[323.4, 70.6], [210.6, 1.4], [500, 0], [88.2, 12.6]]) {
      const { billable } = deriveHoursPartition(total, nb);
      expect(billable + nb).toBeCloseTo(total, 5);
    }
  });

  it("never returns negative billable, and flags the impossible partition", () => {
    const r = deriveHoursPartition(40, 70.6); // nonbillable exceeds total
    expect(r.billable).toBe(0);
    expect(r.clamped).toBe(true);
  });

  it("does not clamp when nonbillable <= total", () => {
    expect(deriveHoursPartition(323.4, 70.6).clamped).toBe(false);
    expect(deriveHoursPartition(70.6, 70.6).clamped).toBe(false);
  });

  it("a flag-based billable that exceeds total−nonbillable (admin time not flagged) cannot inflate the derived figure", () => {
    // Real worked total 323.4, admin/nonbillable categories 70.6 → billable must be 252.8,
    // regardless of how many admin entries were logged WITHOUT the non_billable flag
    // (those inflated the old flag-based col I toward 282).
    const { billable } = deriveHoursPartition(323.4, 70.6);
    expect(billable).toBeLessThan(282); // the inflated value the bug produced
    expect(billable).toBeCloseTo(252.8, 5);
  });
});
