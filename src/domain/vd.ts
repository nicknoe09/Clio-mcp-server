// ============================================================
// V&D Of-Counsel compensation split — single source for the tiered attorney
// split and staff allowance constants. Shared by the V&D calculator
// (get_attributable_collections) and the dashboard's Bonus Tracker.
// ============================================================
import { round2 } from "../utils/num";

// Attorney collected-fee tiers: marginal V&D vs firm share by YTD band.
const ATTORNEY_TIERS = [
  { ceiling: 250000, vdPct: 0.825, firmPct: 0.175 },
  { ceiling: 500000, vdPct: 0.80, firmPct: 0.20 },
  { ceiling: Infinity, vdPct: 0.775, firmPct: 0.225 },
];

// Staff time split beyond the monthly allowance (used by the V&D calculator).
export const STAFF_VD_PCT = 0.35;
export const STAFF_FIRM_PCT = 0.65;
// Staff hours/month per of-counsel that get attorney-tier treatment.
export const STAFF_ALLOWANCE_HOURS = 10;

/**
 * Apply the tiered V&D/firm split to `amount`, given combined YTD collections
 * already processed. Returns the V&D and firm dollar shares + the new YTD total.
 */
export function applyTieredSplit(amount: number, ytdBefore: number): { vd: number; firm: number; ytdAfter: number } {
  let remaining = amount, vd = 0, firm = 0, ytd = ytdBefore;
  for (const tier of ATTORNEY_TIERS) {
    if (remaining <= 0) break;
    const space = Math.max(0, tier.ceiling - ytd);
    if (space <= 0) continue;
    const inTier = Math.min(remaining, space);
    vd += inTier * tier.vdPct; firm += inTier * tier.firmPct;
    ytd += inTier; remaining -= inTier;
  }
  return { vd: round2(vd), firm: round2(firm), ytdAfter: ytd };
}
