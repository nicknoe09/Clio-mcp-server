// ====================================================================
// AR aging buckets — the ONE definition of aging granularity
// --------------------------------------------------------------------
// Both get_ar_aging and get_ar_scorecard bucket invoices by
// `days_outstanding` (days past the invoice's due date, floored at 0). This
// module owns the day thresholds and the boundary rule so the two tools can
// never disagree, and so the cumulative ("N+") view is always DERIVED from the
// discrete view rather than computed independently.
//
// BOUNDARY RULE (the thing that caused downstream confusion before):
//   * Discrete buckets are inclusive on BOTH ends and mutually exclusive.
//     Day 30 is in "16-30"; day 31 opens "31-60". Day 0 (due today, not yet
//     late) is in "0-7".
//   * A cumulative bucket labelled "N+" means days_outstanding > N, i.e.
//     N+1 and beyond — NOT >= N. It is exactly the sum of every discrete
//     bucket that starts after day N. This is deliberate: it matches the
//     pre-existing ar_90plus / ar_120plus scorecard fields (both of which are
//     `days >= 91` / `days >= 121`), so the legacy fields and the new
//     cumulative buckets report the same dollars.
// ====================================================================

import { round2 } from "../utils/num";

export interface DiscreteBucketDef {
  /** Output key, e.g. "days_16_30". */
  key: string;
  /** Human label for workbook/report headers, e.g. "16-30". */
  label: string;
  /** Inclusive lower bound in days_outstanding. */
  min: number;
  /** Inclusive upper bound, or null for the open-ended top bucket. */
  max: number | null;
}

// Discrete/exclusive buckets at the 7/15/30/60/90/120/180/360 thresholds.
// Ordered youngest → oldest; the list is the source of truth for both views.
export const DISCRETE_BUCKETS: readonly DiscreteBucketDef[] = [
  { key: "days_0_7", label: "0-7", min: 0, max: 7 },
  { key: "days_8_15", label: "8-15", min: 8, max: 15 },
  { key: "days_16_30", label: "16-30", min: 16, max: 30 },
  { key: "days_31_60", label: "31-60", min: 31, max: 60 },
  { key: "days_61_90", label: "61-90", min: 61, max: 90 },
  { key: "days_91_120", label: "91-120", min: 91, max: 120 },
  { key: "days_121_180", label: "121-180", min: 121, max: 180 },
  { key: "days_181_360", label: "181-360", min: 181, max: 360 },
  { key: "days_over_360", label: "360+", min: 361, max: null },
] as const;

// Cumulative rollup thresholds. Each is a discrete bucket boundary, so every
// cumulative figure is a whole-number sum of discrete buckets.
export const CUMULATIVE_THRESHOLDS: readonly number[] = [7, 15, 30, 60, 90, 120, 180, 360] as const;

/** Output key for a cumulative threshold: 90 → "over_90" (days_outstanding > 90). */
export function cumulativeKey(threshold: number): string {
  return `over_${threshold}`;
}

/** Human label for a cumulative threshold: 90 → "90+". */
export function cumulativeLabel(threshold: number): string {
  return `${threshold}+`;
}

// Stale-AR / collectability-review threshold. Aligned to the top discrete
// bucket boundary (so stale AR is exactly the "360+" bucket and can never
// drift from it) rather than a free-floating 365.
export const STALE_THRESHOLD_DAYS = 360;

// One-line boundary statement reused verbatim in both tool descriptions, so the
// MCP tool-search index carries the rule and not just the bucket names.
export const BOUNDARY_RULE_TEXT =
  "Boundary rule: discrete buckets are inclusive on both ends and mutually exclusive " +
  "(day 30 is in 16-30, day 31 opens 31-60, day 0 = due today is in 0-7); a cumulative " +
  '"N+" bucket means days_outstanding > N (N+1 and beyond, NOT >= N), which is exactly ' +
  "the sum of the discrete buckets starting after day N and matches the legacy " +
  "ar_90plus/ar_120plus fields.";

/** Discrete bucket key for a days_outstanding value. Negative days clamp to the youngest bucket. */
export function discreteBucketKey(days: number): string {
  const d = Math.max(0, days);
  for (const b of DISCRETE_BUCKETS) {
    if (b.max === null || d <= b.max) return b.key;
  }
  return DISCRETE_BUCKETS[DISCRETE_BUCKETS.length - 1].key;
}

/** Human label for a days_outstanding value (e.g. 95 → "91-120"). */
export function discreteBucketLabel(days: number): string {
  const key = discreteBucketKey(days);
  return DISCRETE_BUCKETS.find((b) => b.key === key)!.label;
}

export interface AgingItem {
  /** days_outstanding for the invoice. */
  days: number;
  /** Open balance in dollars. */
  balance: number;
  /** Client name, for the unique-client count. Optional. */
  client?: string;
}

export interface BucketSummary {
  /** Bucket label ("16-30", "90+"). */
  label: string;
  /** Inclusive day range, human-readable. */
  range: string;
  total: number;
  count: number;
  unique_clients: number;
}

export interface AgingBuckets {
  discrete: Record<string, BucketSummary>;
  cumulative: Record<string, BucketSummary>;
}

function summarize(label: string, range: string, items: AgingItem[]): BucketSummary {
  return {
    label,
    range,
    total: round2(items.reduce((s, i) => s + i.balance, 0)),
    count: items.length,
    unique_clients: new Set(items.map((i) => i.client ?? "")).size,
  };
}

/**
 * Partition items into the discrete buckets, then DERIVE the cumulative
 * buckets from those same partitions. Cumulative totals are re-summed from the
 * discrete members (not from the rounded discrete totals) so the two views can
 * never drift, and unique_clients is a true union rather than a sum.
 */
export function bucketizeAging(items: AgingItem[]): AgingBuckets {
  const members: Record<string, AgingItem[]> = {};
  for (const b of DISCRETE_BUCKETS) members[b.key] = [];
  for (const it of items) members[discreteBucketKey(it.days)].push(it);

  const discrete: Record<string, BucketSummary> = {};
  for (const b of DISCRETE_BUCKETS) {
    const range = b.max === null ? `${b.min}+ days` : `${b.min}-${b.max} days`;
    discrete[b.key] = summarize(b.label, range, members[b.key]);
  }

  const cumulative: Record<string, BucketSummary> = {};
  for (const t of CUMULATIVE_THRESHOLDS) {
    // Every discrete bucket that STARTS after day t — i.e. days_outstanding > t.
    const rolled = DISCRETE_BUCKETS.filter((b) => b.min > t).flatMap((b) => members[b.key]);
    cumulative[cumulativeKey(t)] = summarize(cumulativeLabel(t), `> ${t} days`, rolled);
  }

  return { discrete, cumulative };
}

export interface BucketReconciliation {
  ok: boolean;
  /** Sum of the discrete bucket totals. */
  discrete_sum: number;
  /** The total_ar the buckets must reproduce. */
  total_ar: number;
  delta: number;
}

/**
 * Reconciliation guardrail: the discrete buckets are mutually exclusive and
 * exhaustive, so their totals MUST sum to total_ar to the cent. A failure here
 * means a bucket boundary or a filter changed and the report is not trustworthy.
 */
export function reconcileDiscreteBuckets(
  discrete: Record<string, BucketSummary>,
  totalAr: number
): BucketReconciliation {
  const discrete_sum = round2(
    DISCRETE_BUCKETS.reduce((s, b) => s + (discrete[b.key]?.total ?? 0), 0)
  );
  const delta = round2(discrete_sum - totalAr);
  return { ok: Math.abs(delta) <= 0.01, discrete_sum, total_ar: round2(totalAr), delta };
}
