import { rawGetSingle, rawPatchSingle } from "./pagination";

// ============================================================
//  Matter custom-rate helper — shared by create_matter / set_matter_rate
// ============================================================
// Per-user (and matter-wide) billing rates live on a Matter via the
// `custom_rate` ASSOCIATION — NOT the scalar field create_matter used to
// send, and NOT the top-level `billing_method` (which Clio silently saves
// as "hourly" regardless of what you POST/PATCH). The association shape is:
//
//   custom_rate: {
//     type: "HourlyRate" | "FlatRate",
//     rates: [
//       { user:  { id }, rate },   // per-timekeeper rate
//       { group: { id }, rate },   // per-group rate
//       { rate }                   // matter-wide (no user/group)
//     ]
//   }
//
// Confirmed quirks (see Clio help "Matter Permissions and Rates" + the
// lawyered0/clio-mcp reference): the association is applied via PATCH on an
// existing matter, so the create flow is POST-then-PATCH. Setting a FlatRate
// flips the matter's billing_method to "flat" as a side effect.

export type UserRate = { user_id: number; rate: number };

export type CustomRateInput = {
  /** "hourly" → HourlyRate, "flat" → FlatRate. Defaults to "hourly". */
  rate_type?: "hourly" | "flat";
  /** A single matter-wide rate applied with no user/group. */
  matter_rate?: number;
  /** Per-timekeeper rates, e.g. [{ user_id: 123, rate: 300 }]. */
  user_rates?: UserRate[];
};

export type CustomRatePayload = {
  type: "HourlyRate" | "FlatRate";
  rates: Array<{ user?: { id: number }; rate: number }>;
};

/**
 * Build the custom_rate association object from a friendly input, or return
 * null when there's nothing to set. Pure (no I/O) so it can be unit-tested.
 */
export function buildCustomRatePayload(input: CustomRateInput): CustomRatePayload | null {
  const rates: Array<{ user?: { id: number }; rate: number }> = [];
  if (input.matter_rate !== undefined && input.matter_rate !== null) {
    rates.push({ rate: input.matter_rate });
  }
  for (const ur of input.user_rates ?? []) {
    rates.push({ user: { id: ur.user_id }, rate: ur.rate });
  }
  if (rates.length === 0) return null;
  return {
    type: input.rate_type === "flat" ? "FlatRate" : "HourlyRate",
    rates,
  };
}

// Field set for reading a matter's rate state back. custom_rate sub-fields are
// expanded best-effort; if Clio rejects the nesting the caller falls back to a
// billing_method-only read.
export const MATTER_RATE_READBACK_FIELDS =
  "id,display_number,billing_method,custom_rate{id,type,rates{rate,user{id,name}}}";

export const MATTER_RATE_READBACK_FIELDS_FALLBACK =
  "id,display_number,billing_method";

/**
 * PATCH a matter's custom_rate association and read the result back. Returns
 * the (best-effort) read-back matter. Throws on PATCH failure so callers can
 * surface Clio's error verbatim.
 */
export async function applyCustomRate(
  matterId: number,
  payload: CustomRatePayload,
): Promise<any> {
  await rawPatchSingle(`/matters/${matterId}`, { data: { custom_rate: payload } });

  // Read back — try the rich expansion first, fall back if Clio rejects it.
  try {
    const rb = await rawGetSingle(`/matters/${matterId}`, {
      fields: MATTER_RATE_READBACK_FIELDS,
    });
    return rb?.data ?? rb;
  } catch {
    try {
      const rb = await rawGetSingle(`/matters/${matterId}`, {
        fields: MATTER_RATE_READBACK_FIELDS_FALLBACK,
      });
      return rb?.data ?? rb;
    } catch {
      return null;
    }
  }
}
