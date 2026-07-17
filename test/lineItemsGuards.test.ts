import { describe, it, expect } from "vitest";
import {
  assertNewHoursSane,
  reconcileHardCombineHours,
  reconcileHardCombineDollars,
  MAX_ENTRY_HOURS_PER_DAY,
} from "../src/clio/lineItems";

// Overcharge guards for the hour-change path, which PATCHes /activities
// directly and so bypasses patchTimeEntrySmart's inflation guard. These are
// the only protection between a missing-decimal fat-finger (0.6h -> "60") and
// a client's invoice, so they are unit-tested in isolation.
describe("assertNewHoursSane (24h/entry ceiling)", () => {
  it("allows normal invoice-review values (reductions and small increases)", () => {
    expect(() => assertNewHoursSane(0.4, { originalHours: 0.6 })).not.toThrow();
    expect(() => assertNewHoursSane(1.4, { originalHours: 0.2 })).not.toThrow(); // hard-combine roll-up
    expect(() => assertNewHoursSane(MAX_ENTRY_HOURS_PER_DAY)).not.toThrow(); // exactly at the ceiling
  });

  it("rejects a value above the daily ceiling (the classic 100x fat-finger)", () => {
    expect(() => assertNewHoursSane(60, { originalHours: 0.6 })).toThrow(/24h\/day sanity ceiling/);
  });

  it("force overrides the ceiling", () => {
    expect(() => assertNewHoursSane(60, { originalHours: 0.6, force: true })).not.toThrow();
  });
});

describe("reconcileHardCombineHours (hours conservation)", () => {
  it("matches when requested == primary + sum(secondaries)", () => {
    const r = reconcileHardCombineHours(0.2, [0.6, 0.6], 1.4);
    expect(r.expected).toBeCloseTo(1.4, 6);
    expect(r.matches).toBe(true);
    expect(r.delta_hours).toBeCloseTo(0, 6);
  });

  it("flags a mistyped total (e.g. 14 instead of 1.4)", () => {
    const r = reconcileHardCombineHours(0.2, [0.6, 0.6], 14);
    expect(r.expected).toBeCloseTo(1.4, 6);
    expect(r.matches).toBe(false);
    expect(r.delta_hours).toBeCloseTo(12.6, 6);
  });

  it("tolerates sub-cent rounding noise", () => {
    expect(reconcileHardCombineHours(0.1, [0.2], 0.3).matches).toBe(true);
  });
});

describe("reconcileHardCombineDollars (rate-aware value conservation)", () => {
  it("conserves dollars when all rates match", () => {
    // 0.4h@195 primary + 0.4h@195 secondary -> 0.8h@195
    const r = reconcileHardCombineDollars({ hours: 0.4, rate: 195 }, [{ hours: 0.4, rate: 195 }], 0.8);
    expect(r.expected_dollars).toBeCloseTo(156, 2);
    expect(r.resulting_dollars).toBeCloseTo(156, 2);
    expect(r.rates_uniform).toBe(true);
    expect(r.matches).toBe(true);
  });

  it("flags the live-confirmed differing-rate loss ($178 -> $156)", () => {
    // 0.4h@195 primary + 0.4h@250 secondary, rolled to 0.8h at the primary's $195
    const r = reconcileHardCombineDollars({ hours: 0.4, rate: 195 }, [{ hours: 0.4, rate: 250 }], 0.8);
    expect(r.expected_dollars).toBeCloseTo(178, 2); // 78 + 100
    expect(r.resulting_dollars).toBeCloseTo(156, 2); // 0.8 * 195
    expect(r.delta_dollars).toBeCloseTo(-22, 2);
    expect(r.rates_uniform).toBe(false);
    expect(r.matches).toBe(false);
  });
});
