import { rawGetSingle, rawPatchSingle } from "./pagination";

// ============================================================
//  Matter custom-rate helper — shared by create_matter / set_matter_rate
// ============================================================
// Per-timekeeper billing rates live on a Matter via the `custom_rate`
// ASSOCIATION — NOT the scalar field create_matter used to send, and NOT the
// top-level `billing_method` (which Clio silently saves as "hourly" regardless
// of what you POST/PATCH). The association shape is:
//
//   custom_rate: {
//     type: "HourlyRate" | "FlatRate",
//     rates: [ { user: { id }, rate }, ... ]
//   }
//
// Confirmed against the live API (see PR #160 live test): EVERY rate entry
// MUST name a user (or group) — a user-less "matter-wide" rate is rejected
// ("A user or a group is required for a custom 'HourlyRate'" / "User can't be
// blank"). So rates are always per-user here. The association is applied via
// PATCH on an existing matter, so the create flow is POST-then-PATCH. Setting
// a FlatRate flips the matter's billing_method to "flat" as a side effect
// (observable via get_matter) — an HourlyRate leaves it "hourly".

export type UserRate = { user_id: number; rate: number };

export type CustomRateInput = {
  /** "hourly" → HourlyRate, "flat" → FlatRate. Defaults to "hourly". */
  rate_type?: "hourly" | "flat";
  /** Per-timekeeper rates, e.g. [{ user_id: 123, rate: 300 }]. Required (≥1). */
  user_rates?: UserRate[];
};

export type CustomRatePayload = {
  type: "HourlyRate" | "FlatRate";
  rates: Array<{ user: { id: number }; rate: number }>;
};

/**
 * Build the custom_rate association object from per-user input, or return null
 * when there are no user rates to set. Pure (no I/O) so it can be unit-tested.
 * Each entry names a user — Clio requires a user (or group) per rate.
 */
export function buildCustomRatePayload(input: CustomRateInput): CustomRatePayload | null {
  const rates = (input.user_rates ?? []).map((ur) => ({
    user: { id: ur.user_id },
    rate: ur.rate,
  }));
  if (rates.length === 0) return null;
  return {
    type: input.rate_type === "flat" ? "FlatRate" : "HourlyRate",
    rates,
  };
}

// Field set for reading a matter's rate state back. billing_method always
// reads (and reflects FlatRate as "flat"); custom_rate sub-fields are expanded
// best-effort and fall back if Clio rejects the nesting.
export const MATTER_RATE_READBACK_FIELDS =
  "id,display_number,billing_method,custom_rate{id,type}";

export const MATTER_RATE_READBACK_FIELDS_FALLBACK =
  "id,display_number,billing_method";

export type RateReadback = {
  matter: { id: number | null; display_number: string | null };
  billing_method: string | null;
  /** Best-effort echo of the persisted custom_rate (Clio may not expose it on read). */
  custom_rate: any;
};

/**
 * PATCH a matter's custom_rate association and read the result back. Returns a
 * normalized RateReadback. Throws on PATCH failure so callers can surface
 * Clio's error verbatim.
 */
export async function applyCustomRate(
  matterId: number,
  payload: CustomRatePayload,
): Promise<RateReadback> {
  await rawPatchSingle(`/matters/${matterId}`, { data: { custom_rate: payload } });

  // Read back — try the custom_rate expansion first, fall back if Clio rejects
  // it (the per-rate values may not be exposed on read; billing_method always is).
  let m: any = null;
  try {
    const rb = await rawGetSingle(`/matters/${matterId}`, {
      fields: MATTER_RATE_READBACK_FIELDS,
    });
    m = rb?.data ?? rb;
  } catch {
    try {
      const rb = await rawGetSingle(`/matters/${matterId}`, {
        fields: MATTER_RATE_READBACK_FIELDS_FALLBACK,
      });
      m = rb?.data ?? rb;
    } catch {
      m = null;
    }
  }

  return {
    matter: { id: m?.id ?? matterId, display_number: m?.display_number ?? null },
    billing_method: m?.billing_method ?? null,
    custom_rate: m?.custom_rate ?? null,
  };
}
