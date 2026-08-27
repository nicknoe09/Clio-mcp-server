import { describe, it, expect } from "vitest";
import {
  DISCRETE_BUCKETS,
  CUMULATIVE_THRESHOLDS,
  STALE_THRESHOLD_DAYS,
  bucketizeAging,
  cumulativeKey,
  discreteBucketKey,
  discreteBucketLabel,
  reconcileDiscreteBuckets,
  type AgingItem,
} from "../src/domain/arAging";
import { round2 } from "../src/utils/num";

// The bucket thresholds and the boundary rule are a firm reporting decision, and
// downstream consumers read the numbers literally. These tests lock in both the
// boundaries and the invariant that the cumulative view is DERIVED from the
// discrete one, so the two can never drift apart.

describe("discrete bucket boundaries", () => {
  it("covers the 7/15/30/60/90/120/180/360 thresholds in order", () => {
    expect(DISCRETE_BUCKETS.map((b) => b.label)).toEqual([
      "0-7", "8-15", "16-30", "31-60", "61-90", "91-120", "121-180", "181-360", "360+",
    ]);
  });

  it("is inclusive on both ends — day 30 is 16-30, day 31 opens 31-60", () => {
    expect(discreteBucketLabel(30)).toBe("16-30");
    expect(discreteBucketLabel(31)).toBe("31-60");
  });

  it("puts every boundary day in the bucket that names it", () => {
    for (const b of DISCRETE_BUCKETS) {
      expect(discreteBucketKey(b.min)).toBe(b.key);
      if (b.max !== null) {
        expect(discreteBucketKey(b.max)).toBe(b.key);
        // One day past the upper bound must fall into the NEXT bucket.
        expect(discreteBucketKey(b.max + 1)).not.toBe(b.key);
      }
    }
  });

  it("puts day 0 (due today, not yet late) in 0-7 and clamps negatives there too", () => {
    expect(discreteBucketLabel(0)).toBe("0-7");
    expect(discreteBucketLabel(-5)).toBe("0-7");
  });

  it("has no gaps and no overlaps between adjacent buckets", () => {
    for (let i = 1; i < DISCRETE_BUCKETS.length; i++) {
      expect(DISCRETE_BUCKETS[i].min).toBe(DISCRETE_BUCKETS[i - 1].max! + 1);
    }
    expect(DISCRETE_BUCKETS[0].min).toBe(0);
    expect(DISCRETE_BUCKETS[DISCRETE_BUCKETS.length - 1].max).toBeNull();
  });

  it("pins the stale-AR threshold to the top bucket's boundary", () => {
    const top = DISCRETE_BUCKETS[DISCRETE_BUCKETS.length - 1];
    expect(STALE_THRESHOLD_DAYS).toBe(top.min - 1);
    expect(discreteBucketKey(STALE_THRESHOLD_DAYS)).not.toBe(top.key);
    expect(discreteBucketKey(STALE_THRESHOLD_DAYS + 1)).toBe(top.key);
  });
});

// One invoice landing squarely in each discrete bucket, plus a couple of extras
// so counts and client unions are non-trivial.
const SAMPLE: AgingItem[] = [
  { days: 0, balance: 100.11, client: "A" },
  { days: 7, balance: 200.22, client: "B" },
  { days: 8, balance: 300.33, client: "A" },
  { days: 15, balance: 400.44, client: "C" },
  { days: 16, balance: 500.55, client: "C" },
  { days: 30, balance: 600.66, client: "D" },
  { days: 31, balance: 700.77, client: "D" },
  { days: 60, balance: 800.88, client: "E" },
  { days: 61, balance: 900.99, client: "E" },
  { days: 90, balance: 1000.01, client: "F" },
  { days: 91, balance: 1100.12, client: "G" },
  { days: 120, balance: 1200.23, client: "G" },
  { days: 121, balance: 1300.34, client: "H" },
  { days: 180, balance: 1400.45, client: "H" },
  { days: 181, balance: 1500.56, client: "I" },
  { days: 360, balance: 1600.67, client: "I" },
  { days: 361, balance: 1700.78, client: "J" },
  { days: 1800, balance: 1800.89, client: "K" },
];
const SAMPLE_TOTAL = round2(SAMPLE.reduce((s, i) => s + i.balance, 0));

describe("bucketizeAging — discrete exclusivity", () => {
  const { discrete } = bucketizeAging(SAMPLE);

  it("sums to the total to the cent", () => {
    const sum = round2(DISCRETE_BUCKETS.reduce((s, b) => s + discrete[b.key].total, 0));
    expect(sum).toBe(SAMPLE_TOTAL);
  });

  it("assigns every invoice exactly once", () => {
    const count = DISCRETE_BUCKETS.reduce((s, b) => s + discrete[b.key].count, 0);
    expect(count).toBe(SAMPLE.length);
  });

  it("reconciles via reconcileDiscreteBuckets", () => {
    const recon = reconcileDiscreteBuckets(discrete, SAMPLE_TOTAL);
    expect(recon.ok).toBe(true);
    expect(recon.delta).toBe(0);
  });

  it("flags a mismatch rather than silently passing", () => {
    const recon = reconcileDiscreteBuckets(discrete, SAMPLE_TOTAL + 0.02);
    expect(recon.ok).toBe(false);
    expect(recon.delta).toBe(-0.02);
  });

  it("survives an empty invoice set (all zeros, reconciles to 0)", () => {
    const { discrete: empty, cumulative } = bucketizeAging([]);
    for (const b of DISCRETE_BUCKETS) {
      expect(empty[b.key]).toMatchObject({ total: 0, count: 0, unique_clients: 0 });
    }
    for (const t of CUMULATIVE_THRESHOLDS) {
      expect(cumulative[cumulativeKey(t)]).toMatchObject({ total: 0, count: 0 });
    }
    expect(reconcileDiscreteBuckets(empty, 0).ok).toBe(true);
  });
});

describe("bucketizeAging — cumulative derives from discrete", () => {
  const { discrete, cumulative } = bucketizeAging(SAMPLE);

  it('reports every threshold as "N+"', () => {
    expect(CUMULATIVE_THRESHOLDS.map((t) => cumulative[cumulativeKey(t)].label)).toEqual([
      "7+", "15+", "30+", "60+", "90+", "120+", "180+", "360+",
    ]);
  });

  it("equals the sum of the discrete buckets starting after the threshold", () => {
    for (const t of CUMULATIVE_THRESHOLDS) {
      const expected = round2(
        DISCRETE_BUCKETS.filter((b) => b.min > t).reduce((s, b) => s + discrete[b.key].total, 0)
      );
      expect(cumulative[cumulativeKey(t)].total).toBe(expected);
    }
  });

  it('means "> N days", not ">= N" — day 90 is NOT in 90+, day 91 is', () => {
    const only90 = bucketizeAging([{ days: 90, balance: 500, client: "X" }]);
    expect(only90.cumulative[cumulativeKey(90)].total).toBe(0);
    expect(only90.cumulative[cumulativeKey(60)].total).toBe(500);

    const only91 = bucketizeAging([{ days: 91, balance: 500, client: "X" }]);
    expect(only91.cumulative[cumulativeKey(90)].total).toBe(500);
  });

  it("nests: each threshold is a superset of the next (360+ ⊂ 180+ ⊂ 120+ …)", () => {
    for (let i = 1; i < CUMULATIVE_THRESHOLDS.length; i++) {
      const wider = cumulative[cumulativeKey(CUMULATIVE_THRESHOLDS[i - 1])];
      const narrower = cumulative[cumulativeKey(CUMULATIVE_THRESHOLDS[i])];
      expect(wider.total).toBeGreaterThanOrEqual(narrower.total);
      expect(wider.count).toBeGreaterThanOrEqual(narrower.count);
    }
  });

  it("uses the widest rollup (7+) = total minus the 0-7 bucket", () => {
    expect(cumulative[cumulativeKey(7)].total).toBe(round2(SAMPLE_TOTAL - discrete.days_0_7.total));
  });

  it("makes 360+ exactly the top discrete bucket (the stale-AR tier)", () => {
    expect(cumulative[cumulativeKey(360)].total).toBe(discrete.days_over_360.total);
    expect(cumulative[cumulativeKey(360)].count).toBe(discrete.days_over_360.count);
  });

  it("unions clients rather than summing per-bucket client counts", () => {
    // Client G has invoices in 91-120 AND 121-180 territory in SAMPLE terms:
    // days 91 and 120 are both in 91-120, so use a purpose-built set instead.
    const { cumulative: c } = bucketizeAging([
      { days: 100, balance: 10, client: "same" },
      { days: 200, balance: 10, client: "same" },
    ]);
    expect(c[cumulativeKey(90)].count).toBe(2);
    expect(c[cumulativeKey(90)].unique_clients).toBe(1);
  });
});
