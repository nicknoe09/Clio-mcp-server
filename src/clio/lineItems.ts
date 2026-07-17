import { fetchAllPages, rawGetSingle, rawPatchSingle, rawPostSingle, rawDeleteSingle } from "./pagination";

export interface LineItemSummary {
  id: number;
  description?: string;
  note?: string;
  quantity?: number;
  price?: number;
  total?: number;
  activity?: { id: number };
  bill?: { id: number; state?: string; number?: string };
}

export interface ActivityRouting {
  activity: any;
  bill: { id: number; state?: string; number?: string } | null;
  line_item: LineItemSummary | null;
}

const ACTIVITY_ROUTING_FIELDS =
  "id,date,note,price,quantity,rounded_quantity,billed,bill{id,state,number},matter{id,display_number},user{id,name}";

const LINE_ITEM_FIELDS =
  "id,description,note,quantity,price,total,activity{id},bill{id,state,number}";

// Resolve where an activity's edits should be written. If the activity is on
// a bill (draft or otherwise), Clio locks PATCH /activities/{id} with a 422
// "has been billed" error — the bill's line_item is the only editable surface.
export async function resolveActivityRouting(activityId: number): Promise<ActivityRouting> {
  const actResp = await rawGetSingle(`/activities/${activityId}`, { fields: ACTIVITY_ROUTING_FIELDS });
  const activity = actResp.data;
  if (!activity) {
    const err: any = new Error(`Activity ${activityId} not found`);
    err.response = { status: 404 };
    throw err;
  }

  const bill = activity.bill?.id
    ? { id: activity.bill.id, state: activity.bill.state, number: activity.bill.number }
    : null;

  if (!bill) return { activity, bill: null, line_item: null };

  const lineItems = await fetchAllPages<LineItemSummary>("/line_items", {
    fields: LINE_ITEM_FIELDS,
    bill_id: bill.id,
  });
  const line_item = lineItems.find((li) => li.activity?.id === activityId) ?? null;
  return { activity, bill, line_item };
}

export interface SmartPatch {
  note?: string;
  price?: number;
  hours?: number; // decimal hours; helper converts as needed per routing target
  date?: string;
  // When PATCHing /line_items/{id}, ask Clio to propagate the change back
  // to the underlying activity record (note, quantity, etc.). Default true
  // so internal time-entry records stay in sync with bill-line edits.
  // Ignored on the /activities path (no-op there).
  update_original_record?: boolean;
  // Override the per-entry 24h/day hours ceiling (see assertNewHoursSane).
  force?: boolean;
}

export interface SmartPatchResult {
  path: "activity" | "line_item";
  activity_id: number;
  line_item_id?: number;
  bill?: { id: number; state?: string; number?: string };
  before: any;
  after: any;
}

// Clio rejects PATCH bodies that include read-only or computed fields
// (notably rounded_quantity, total, billed, type). Construct the wire body
// from a strict whitelist so that callers passing in spread/typed-as-any
// objects can't accidentally leak extra keys onto the request.
//
// Per domain testing: /line_items PATCH accepts the same activity-shape
// fields (note, price, quantity, date), not the read-side `description`
// field. Read and write field names diverge on this endpoint.
//
// Critical unit difference (caught in production by overcharge guard):
// /activities expects `quantity` in SECONDS. /line_items expects
// `quantity` in HOURS. Sending hours×3600 to /line_items writes that
// value as hours, producing a catastrophic total (e.g. 0.6 hr × $450
// became 2160 hr × $450 = $972,000). The conversion lives in this
// helper, not in callers — callers always pass hours via SmartPatch.hours.
function buildActivityBody(patch: SmartPatch): Record<string, any> {
  const out: Record<string, any> = {};
  if (patch.note !== undefined) out.note = patch.note;
  if (patch.price !== undefined) out.price = patch.price;
  if (patch.hours !== undefined) out.quantity = Math.round(patch.hours * 3600);
  if (patch.date !== undefined) out.date = patch.date;
  return out;
}

function buildLineItemBody(patch: SmartPatch): Record<string, any> {
  const out: Record<string, any> = {};
  if (patch.note !== undefined) out.note = patch.note;
  if (patch.price !== undefined) out.price = patch.price;
  if (patch.hours !== undefined) out.quantity = patch.hours;
  if (patch.date !== undefined) out.date = patch.date;
  // Default true: keep underlying activity in sync with bill-line edits
  // unless the caller explicitly opts out.
  out.update_original_record = patch.update_original_record !== false;
  return out;
}

// Catastrophic-overcharge guard. If a line_item PATCH would write a total
// more than this multiple of the existing line total, refuse and roll back.
// The hours-vs-seconds bug we already fixed could have produced 1000x
// totals; this is a belt-and-suspenders check in case a future caller
// regresses the unit handling.
const MAX_TOTAL_INFLATION = 5;

// Per-entry sanity ceiling for hour edits. A single time entry is a day's
// work on one task — it cannot exceed 24 hours. The hour-change path PATCHes
// /activities directly, bypassing patchTimeEntrySmart's overcharge guard, so
// this is the only thing standing between a missing-decimal fat-finger
// (0.6h typed as "60", i.e. a 100x overcharge on a draft bill about to be
// issued) and the client's invoice. Chosen so it can NEVER reject a legitimate
// edit: nothing real exceeds 24h on one entry, and same-day hard-combines
// roll up to well under 24h too. Override with force for the rare exception.
export const MAX_ENTRY_HOURS_PER_DAY = 24;

// Sanity-check a requested new hours value for a single time entry. Throws
// (with an actionable message) when it exceeds the daily ceiling unless the
// caller explicitly forces it. Pure + exported so it is unit-testable and so
// every hour-writing path shares one rule.
export function assertNewHoursSane(
  newHours: number,
  ctx: { originalHours?: number; force?: boolean } = {},
): void {
  if (ctx.force) return;
  if (newHours > MAX_ENTRY_HOURS_PER_DAY) {
    throw new Error(
      `Refusing to set ${newHours}h on a single time entry — that exceeds the ${MAX_ENTRY_HOURS_PER_DAY}h/day sanity ceiling` +
        (ctx.originalHours != null ? ` (the line is currently ${ctx.originalHours}h)` : "") +
        `. This is almost always a missing-decimal fat-finger (e.g. 6.0 entered as 60), which would multiply the line's charge on the bill. Pass force=true if the value is genuinely correct.`,
    );
  }
}

// Reconcile a hard-combine's requested primary hours against what the roll-up
// arithmetic implies (original primary hours + the sum of the secondaries'
// hours). Pure + exported for unit testing. A mismatch means either an
// intentional total change (allowed via force) or a fat-finger (blocked).
export function reconcileHardCombineHours(
  originalPrimaryHours: number,
  secondaryHours: number[],
  requestedHours: number,
): { expected: number; requested: number; delta_hours: number; matches: boolean } {
  const expected =
    Math.round((originalPrimaryHours + secondaryHours.reduce((a, b) => a + b, 0)) * 1000) / 1000;
  const delta = Math.round((requestedHours - expected) * 1000) / 1000;
  return { expected, requested: requestedHours, delta_hours: delta, matches: Math.abs(delta) <= 0.005 };
}

// Dollar-conservation reconciliation for a hard-combine. Rolling a secondary's
// hours into the primary rebills those hours at the PRIMARY's rate — so when
// the secondaries carry a different rate, the billed total silently changes
// even though hours are conserved (verified live 2026-07: a 0.4h@$250 line
// combined into a 0.4h@$195 primary dropped the bill $22 with no warning).
// expected = primary$ + Σ secondary$ (what the lines were worth apart);
// resulting = new primary hours × primary rate (what the combined line bills).
// Pure + exported for unit testing.
export function reconcileHardCombineDollars(
  originalPrimary: { hours: number; rate: number },
  secondaries: Array<{ hours: number; rate: number }>,
  newPrimaryHours: number,
): {
  expected_dollars: number;
  resulting_dollars: number;
  delta_dollars: number;
  rates_uniform: boolean;
  matches: boolean;
} {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const expected = round2(
    originalPrimary.hours * originalPrimary.rate +
      secondaries.reduce((s, x) => s + x.hours * x.rate, 0),
  );
  const resulting = round2(newPrimaryHours * originalPrimary.rate);
  const delta = round2(resulting - expected);
  const ratesUniform = secondaries.every((s) => Math.abs(s.rate - originalPrimary.rate) < 0.005);
  return {
    expected_dollars: expected,
    resulting_dollars: resulting,
    delta_dollars: delta,
    rates_uniform: ratesUniform,
    matches: Math.abs(delta) <= 0.005,
  };
}

// The line total a discount SHOULD produce, computed against the UNDISCOUNTED
// base (price × quantity) — a new discount replaces any prior one, so the base,
// not the current (possibly already-discounted) total, is the reference. Pure +
// exported so the read-back verification in discountLineItem is unit-testable.
export function expectedDiscountedTotal(
  base: number,
  discount: { pct: number } | { amount: number },
): number {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  if ("pct" in discount) return round2(base * (1 - discount.pct / 100));
  return round2(base - discount.amount);
}

// PATCH a time entry, transparently routing through /line_items when the
// entry is on a bill. Returns before/after for both paths.
export async function patchTimeEntrySmart(
  activityId: number,
  patch: SmartPatch,
): Promise<SmartPatchResult> {
  if (
    patch.note === undefined &&
    patch.price === undefined &&
    patch.hours === undefined &&
    patch.date === undefined
  ) {
    throw new Error("patchTimeEntrySmart: provide at least one of note, price, hours, date");
  }

  // Absolute hours ceiling, enforced before any write. The inflation-ratio
  // guard on the /line_items path below is SKIPPED when the line's current
  // total is 0 (a zero-hour or zero-rate line), so a fat-fingered hours value
  // could slip through there; checking up front closes that hole on both the
  // /activities and /line_items paths.
  if (patch.hours !== undefined) assertNewHoursSane(patch.hours, { force: patch.force });

  const routing = await resolveActivityRouting(activityId);

  if (!routing.bill) {
    const before = {
      note: routing.activity.note,
      price: routing.activity.price,
      quantity: routing.activity.quantity,
      date: routing.activity.date,
    };
    const body = buildActivityBody(patch);
    try {
      await rawPatchSingle(`/activities/${activityId}`, { data: body });
    } catch (err: any) {
      console.error(`[patchTimeEntrySmart] PATCH /activities/${activityId} failed status=${err.response?.status} body=${JSON.stringify(body)} clio_error=${JSON.stringify(err.response?.data || {}).slice(0, 400)}`);
      if (err.response) err.response.request_body = body;
      throw err;
    }
    const afterResp = await rawGetSingle(`/activities/${activityId}`, {
      fields: "id,note,price,quantity,rounded_quantity,date",
    });
    return {
      path: "activity",
      activity_id: activityId,
      before,
      after: afterResp.data,
    };
  }

  if (!routing.line_item) {
    const err: any = new Error(
      `Activity ${activityId} is on bill ${routing.bill.id} (state=${routing.bill.state}) but no matching line_item was found.`,
    );
    err.response = { status: 409, data: { context: "no_line_item_for_billed_activity" } };
    throw err;
  }

  const lineItemId = routing.line_item.id;
  const before = {
    description: routing.line_item.description,
    note: routing.line_item.note,
    price: routing.line_item.price,
    quantity: routing.line_item.quantity,
    total: routing.line_item.total,
  };
  const body = buildLineItemBody(patch);
  if (Object.keys(body).length === 0) {
    const err: any = new Error(
      `patchTimeEntrySmart: nothing to write to line_item ${lineItemId} from patch ${JSON.stringify(patch)}.`,
    );
    err.response = { status: 400, data: { context: "no_writable_line_item_fields", original_patch: patch } };
    throw err;
  }

  try {
    await rawPatchSingle(`/line_items/${lineItemId}`, { data: body });
  } catch (err: any) {
    console.error(`[patchTimeEntrySmart] PATCH /line_items/${lineItemId} failed status=${err.response?.status} body=${JSON.stringify(body)} clio_error=${JSON.stringify(err.response?.data || {}).slice(0, 400)}`);
    if (err.response) err.response.request_body = body;
    throw err;
  }
  const afterResp = await rawGetSingle(`/line_items/${lineItemId}`, { fields: LINE_ITEM_FIELDS });
  const after = afterResp.data;

  if (
    typeof before.total === "number" &&
    before.total > 0 &&
    typeof after?.total === "number" &&
    after.total > before.total * MAX_TOTAL_INFLATION
  ) {
    // Roll back to original values, then surface a clear error. This catches
    // a regression of the hours/seconds unit bug before it persists.
    const rollback = buildLineItemBody({
      note: before.note as string | undefined,
      price: before.price as number | undefined,
      hours: before.quantity as number | undefined,
    });
    try {
      await rawPatchSingle(`/line_items/${lineItemId}`, { data: rollback });
    } catch (rbErr: any) {
      console.error(`[patchTimeEntrySmart] ROLLBACK FAILED on line_item ${lineItemId}: ${rbErr.message}. Manual fix needed.`);
    }
    const err: any = new Error(
      `Refused: PATCH /line_items/${lineItemId} would have inflated total from $${before.total} to $${after.total} (>${MAX_TOTAL_INFLATION}x). Rolled back. Sent body: ${JSON.stringify(body)}.`,
    );
    err.response = {
      status: 422,
      data: { context: "overcharge_guard_tripped", before_total: before.total, after_total: after.total, request_body: body },
      request_body: body,
    };
    throw err;
  }

  // Silent-noop guard. Clio's PATCH /line_items accepts the `quantity` field
  // in the request body for ActivityLineItem types but **silently ignores
  // it** — the line's quantity is sourced from the underlying activity, and
  // the activity is locked while billed (PATCH /activities/{id} returns 422).
  // Result: hour-change requests via this helper return 200 OK and look
  // successful but the line's quantity is unchanged. Detected empirically
  // 2026-05-04 via direct probe on bill 22263. Surfacing as a loud failure
  // here (so callers don't silently overcharge or under-bill) and rolling
  // back any sibling fields (note/price) that DID apply, so the line returns
  // to its pre-patch state.
  if (patch.hours !== undefined && typeof after?.quantity === "number") {
    const requested = patch.hours;
    const actual = after.quantity;
    if (Math.abs(actual - requested) > 0.005) {
      const noteChanged = patch.note !== undefined && after.note !== before.note;
      const priceChanged = patch.price !== undefined && after.price !== before.price;
      if (noteChanged || priceChanged) {
        const rollback = buildLineItemBody({
          note: noteChanged ? (before.note as string | undefined) : undefined,
          price: priceChanged ? (before.price as number | undefined) : undefined,
        });
        try {
          await rawPatchSingle(`/line_items/${lineItemId}`, { data: rollback });
        } catch (rbErr: any) {
          console.error(`[patchTimeEntrySmart] silent-noop rollback failed on line_item ${lineItemId}: ${rbErr.message}. Note/price may be partially applied; manual fix may be needed.`);
        }
      }
      const err: any = new Error(
        `Refused: PATCH /line_items/${lineItemId} appeared to succeed (HTTP 200) but Clio silently ignored the quantity change (requested ${requested}h, line is still ${actual}h). Clio's /line_items endpoint does not allow quantity edits for ActivityLineItem types — the quantity is sourced from the underlying activity, which is locked while billed. To change hours on a billed entry: (a) for the split workflow, use prepare_line_split (it deletes the original and creates new activities); (b) for ad-hoc hour fixes, remove_from_draft_bill first (which unbills the activity and unlocks /activities), then PATCH /activities, then regenerate the draft in Clio UI. Any sibling field changes (note/price) have been rolled back to keep the line atomic.`,
      );
      err.response = {
        status: 422,
        data: {
          context: "billed_quantity_silently_ignored",
          requested_hours: requested,
          actual_hours: actual,
          rolled_back_fields: { note: noteChanged, price: priceChanged },
          request_body: body,
        },
        request_body: body,
      };
      throw err;
    }
  }

  return {
    path: "line_item",
    activity_id: activityId,
    line_item_id: lineItemId,
    bill: routing.bill,
    before,
    after,
  };
}

export interface RemoveFromBillResult {
  line_item_id: number;
  activity_id?: number;
  bill: { id: number; state?: string; number?: string };
}

// Remove a line_item from a DRAFT bill. Refuses if the bill is in any other
// state (issued / awaiting_payment / paid / void) — those edits are
// considered destructive and require manual intervention. The underlying
// activity is preserved; only the bill association is removed.
export async function removeFromDraftBill(
  args: { line_item_id?: number; activity_id?: number },
): Promise<RemoveFromBillResult> {
  let lineItemId = args.line_item_id;
  let bill: { id: number; state?: string; number?: string } | null = null;
  let activityId = args.activity_id;

  if (lineItemId) {
    const liResp = await rawGetSingle(`/line_items/${lineItemId}`, { fields: LINE_ITEM_FIELDS });
    const li = liResp.data;
    if (!li) {
      const err: any = new Error(`Line item ${lineItemId} not found`);
      err.response = { status: 404 };
      throw err;
    }
    bill = li.bill ? { id: li.bill.id, state: li.bill.state, number: li.bill.number } : null;
    activityId = activityId ?? li.activity?.id;
  } else if (activityId) {
    const routing = await resolveActivityRouting(activityId);
    if (!routing.bill || !routing.line_item) {
      const err: any = new Error(`Activity ${activityId} is not on a bill — nothing to remove.`);
      err.response = { status: 409, data: { context: "activity_not_on_bill" } };
      throw err;
    }
    lineItemId = routing.line_item.id;
    bill = routing.bill;
  } else {
    throw new Error("removeFromDraftBill: provide line_item_id or activity_id");
  }

  if (!bill) {
    const err: any = new Error(`Line item ${lineItemId} has no bill association.`);
    err.response = { status: 409, data: { context: "no_bill_association" } };
    throw err;
  }

  if (bill.state !== "draft") {
    const err: any = new Error(
      `Refusing to remove line_item ${lineItemId} from bill ${bill.id}: bill state is "${bill.state}", not "draft". Removing line items from issued/finalized bills can corrupt accounting and is not supported here.`,
    );
    err.response = { status: 409, data: { context: "bill_not_draft", bill_state: bill.state } };
    throw err;
  }

  await rawDeleteSingle(`/line_items/${lineItemId}`);
  return { line_item_id: lineItemId, activity_id: activityId, bill };
}

export interface DeleteActivityResult {
  activity_id: number;
  removed_from_bill?: { line_item_id: number; bill: { id: number; state?: string; number?: string } };
  deleted_activity: true;
}

// Delete an activity. If the activity is on a DRAFT bill, automatically
// remove the line_item first (per user direction: "if the user asks to
// delete rather than remove, you can remove then delete without asking").
// Refuses if the activity is on a non-draft bill — touching issued bills
// can corrupt accounting.
export async function deleteActivity(activityId: number): Promise<DeleteActivityResult> {
  const routing = await resolveActivityRouting(activityId);

  let removedFromBill: DeleteActivityResult["removed_from_bill"] | undefined;
  if (routing.bill) {
    if (routing.bill.state !== "draft") {
      const err: any = new Error(
        `Refusing to delete activity ${activityId}: it is on bill ${routing.bill.id} (state="${routing.bill.state}"). Only entries on draft bills can be auto-unbilled and deleted via this tool.`,
      );
      err.response = { status: 409, data: { context: "activity_on_non_draft_bill", bill_state: routing.bill.state } };
      throw err;
    }
    if (!routing.line_item) {
      const err: any = new Error(
        `Activity ${activityId} is on bill ${routing.bill.id} but no matching line_item was found. Cannot auto-unbill.`,
      );
      err.response = { status: 409, data: { context: "no_line_item_for_billed_activity" } };
      throw err;
    }
    await rawDeleteSingle(`/line_items/${routing.line_item.id}`);
    removedFromBill = { line_item_id: routing.line_item.id, bill: routing.bill };
  }

  await rawDeleteSingle(`/activities/${activityId}`);
  return { activity_id: activityId, removed_from_bill: removedFromBill, deleted_activity: true };
}

export interface DiscountLineItemResult {
  line_item_id: number;
  activity_id?: number;
  bill: { id: number; state?: string; number?: string };
  before: { price?: number; quantity?: number; total?: number; discount?: any };
  after: any;
  discount_amount_applied: number;
  discount_pct_applied: number;
}

// Apply a discount to a line_item on a DRAFT bill. Preserves the original
// rate; reduces the line total via discount_total. Caller picks one of:
//   - discount_amount: dollars off the line
//   - discount_pct: percentage of current line total (e.g. 25 = 25%)
// Refuses if the bill is not in draft state.
export async function discountLineItem(args: {
  line_item_id?: number;
  activity_id?: number;
  discount_amount?: number;
  discount_pct?: number;
}): Promise<DiscountLineItemResult> {
  if ((args.discount_amount === undefined) === (args.discount_pct === undefined)) {
    throw new Error("discountLineItem: provide exactly one of discount_amount or discount_pct");
  }
  if (args.line_item_id === undefined && args.activity_id === undefined) {
    throw new Error("discountLineItem: provide line_item_id or activity_id");
  }

  let lineItemId = args.line_item_id;
  let bill: { id: number; state?: string; number?: string } | null = null;
  let activityId = args.activity_id;
  let beforeLineItem: any;

  if (lineItemId) {
    const liResp = await rawGetSingle(`/line_items/${lineItemId}`, { fields: LINE_ITEM_FIELDS + ",discount{rate,type}" });
    beforeLineItem = liResp.data;
    if (!beforeLineItem) {
      const err: any = new Error(`Line item ${lineItemId} not found`);
      err.response = { status: 404 };
      throw err;
    }
    bill = beforeLineItem.bill ? { id: beforeLineItem.bill.id, state: beforeLineItem.bill.state, number: beforeLineItem.bill.number } : null;
    activityId = activityId ?? beforeLineItem.activity?.id;
  } else if (activityId !== undefined) {
    const routing = await resolveActivityRouting(activityId);
    if (!routing.bill || !routing.line_item) {
      const err: any = new Error(`Activity ${activityId} is not on a bill — nothing to discount.`);
      err.response = { status: 409, data: { context: "activity_not_on_bill" } };
      throw err;
    }
    lineItemId = routing.line_item.id;
    bill = routing.bill;
    const liResp = await rawGetSingle(`/line_items/${lineItemId}`, { fields: LINE_ITEM_FIELDS + ",discount{rate,type}" });
    beforeLineItem = liResp.data;
  }

  if (!bill || bill.state !== "draft") {
    const err: any = new Error(
      `Refusing to discount line_item ${lineItemId}: bill state is "${bill?.state ?? "none"}", not "draft".`,
    );
    err.response = { status: 409, data: { context: "bill_not_draft", bill_state: bill?.state } };
    throw err;
  }

  const lineTotal = Number(beforeLineItem?.total ?? 0);
  let discountAmount: number;
  let discountPct: number;
  if (args.discount_amount !== undefined) {
    discountAmount = args.discount_amount;
    discountPct = lineTotal > 0 ? (discountAmount / lineTotal) * 100 : 0;
  } else {
    discountPct = args.discount_pct as number;
    discountAmount = Math.round(lineTotal * (discountPct / 100) * 100) / 100;
  }

  if (discountAmount < 0) {
    throw new Error(`discountLineItem: discount must be non-negative (got ${discountAmount}).`);
  }
  if (discountAmount > lineTotal) {
    throw new Error(
      `discountLineItem: discount $${discountAmount} exceeds line total $${lineTotal}. Cap at line total or use a 100% discount_pct.`,
    );
  }

  // Per Clio's OpenAPI spec (https://docs.developers.clio.com/openapi.json),
  // the PATCH /line_items.discount object is shaped as
  //   { rate: number, type: "percentage" | "money" }
  // — see the Discount_base schema. (The spec has a "type: boolean" typo on
  // the inner `type` field, but the description and the Discount_base schema
  // both confirm it's a string enum.) Clio computes the line-total reduction
  // itself from rate+type, so we send rate matching the caller's input mode
  // and don't compute a discount_total scalar client-side.
  const body =
    args.discount_pct !== undefined
      ? { discount: { rate: args.discount_pct, type: "percentage" } }
      : { discount: { rate: args.discount_amount as number, type: "money" } };
  try {
    await rawPatchSingle(`/line_items/${lineItemId}`, { data: body });
  } catch (err: any) {
    console.error(`[discountLineItem] PATCH /line_items/${lineItemId} failed status=${err.response?.status} body=${JSON.stringify(body)} clio_error=${JSON.stringify(err.response?.data || {}).slice(0, 400)}`);
    if (err.response) err.response.request_body = body;
    throw err;
  }
  const afterResp = await rawGetSingle(`/line_items/${lineItemId}`, { fields: LINE_ITEM_FIELDS + ",discount{rate,type}" });

  // Read-back verification: confirm Clio actually applied the discount. Some
  // /line_items writes return 200 but silently no-op (the quantity field does
  // exactly this for ActivityLineItem). Compare the resulting total to what the
  // requested discount implies against the undiscounted base (price × quantity).
  const base = Number(beforeLineItem?.price ?? 0) * Number(beforeLineItem?.quantity ?? 0);
  const expectedTotal =
    args.discount_pct !== undefined
      ? expectedDiscountedTotal(base, { pct: args.discount_pct })
      : expectedDiscountedTotal(base, { amount: args.discount_amount as number });
  const actualTotal = Number(afterResp.data?.total ?? NaN);
  if (base > 0 && !Number.isNaN(actualTotal) && Math.abs(actualTotal - expectedTotal) > 0.02) {
    const err: any = new Error(
      `Refused: the discount on line_item ${lineItemId} did not take effect — after the write the line total is $${actualTotal}, but the requested discount implies $${expectedTotal} (undiscounted base $${Math.round(base * 100) / 100}). Clio appears to have silently ignored it; re-check the line before issuing the bill.`,
    );
    err.response = {
      status: 422,
      data: { context: "discount_not_applied", expected_total: expectedTotal, actual_total: actualTotal, base: Math.round(base * 100) / 100 },
    };
    throw err;
  }

  return {
    line_item_id: lineItemId!,
    activity_id: activityId,
    bill,
    before: {
      price: beforeLineItem?.price,
      quantity: beforeLineItem?.quantity,
      total: beforeLineItem?.total,
      discount: beforeLineItem?.discount,
    },
    after: afterResp.data,
    discount_amount_applied: discountAmount,
    discount_pct_applied: Math.round(discountPct * 100) / 100,
  };
}

export interface LineSplit {
  hours: number;
  note: string;
}

export interface PrepareLineSplitResult {
  line_item_id: number;
  activity_id: number;
  bill: { id: number; state?: string; number?: string };
  matter: { id: number; display_number?: string };
  original: { hours: number; note: string; date: string; rate: number };
  edited_line: { hours: number; note: string };
  new_activities: Array<{ activity_id: number; hours: number; note: string }>;
  ui_instruction: string;
}

// Split a single line on a DRAFT bill into multiple sub-entries with
// allocated hours and distinct narratives.
//
// The hard constraint: Clio's API does NOT support adding line items to
// an existing bill (no POST /line_items, no POST /bills, no refresh
// endpoint — verified against Clio's full OpenAPI). So this helper does
// the API-side prep:
//   1. Edits the existing line to splits[0]'s hours+note (via
//      patchTimeEntrySmart, which routes through /line_items since the
//      activity is on a draft).
//   2. Creates new activities on the matter for splits[1..N] (POST
//      /activities), inheriting the original activity's date, user, and
//      rate. These new activities sit unbilled until the user clicks
//      "Regenerate Draft" in Clio UI for the matter.
//
// Strict-total contract: sum of split hours must equal the original
// line's hours (within 0.005h tolerance). Prevents accidental
// over/under-billing during a "split". Use update_billed_time_entry
// separately if you want to change the total billable hours.
//
// Rollback: if any new-activity create fails after earlier creates
// succeeded, deletes the partials before throwing. If the existing-line
// edit fails after all creates succeeded, deletes the new activities
// before throwing.
export async function prepareLineSplit(args: {
  line_item_id?: number;
  activity_id?: number;
  splits: LineSplit[];
}): Promise<PrepareLineSplitResult> {
  // --- Validate splits shape ---
  if (!Array.isArray(args.splits) || args.splits.length < 2) {
    throw new Error("prepareLineSplit: splits must be an array of at least 2 entries.");
  }
  for (const s of args.splits) {
    if (typeof s.hours !== "number" || !(s.hours > 0)) {
      throw new Error(
        `prepareLineSplit: each split must have hours > 0 (got ${JSON.stringify(s)}).`,
      );
    }
    if (typeof s.note !== "string" || s.note.trim().length === 0) {
      throw new Error(`prepareLineSplit: each split must have a non-empty note.`);
    }
  }

  // --- Resolve activity_id and line_item_id ---
  let activityId = args.activity_id;
  let lineItemId = args.line_item_id;
  if (!activityId && !lineItemId) {
    throw new Error("prepareLineSplit: provide line_item_id or activity_id.");
  }
  if (!activityId && lineItemId) {
    const liResp = await rawGetSingle(`/line_items/${lineItemId}`, {
      fields: LINE_ITEM_FIELDS,
    });
    if (!liResp.data) {
      const err: any = new Error(`Line item ${lineItemId} not found.`);
      err.response = { status: 404 };
      throw err;
    }
    activityId = liResp.data.activity?.id;
    if (!activityId) {
      throw new Error(`Line item ${lineItemId} has no associated activity.`);
    }
  }

  const routing = await resolveActivityRouting(activityId!);
  if (!routing.bill || !routing.line_item) {
    const err: any = new Error(
      `Activity ${activityId} is not on a bill — nothing to split.`,
    );
    err.response = { status: 409, data: { context: "activity_not_on_bill" } };
    throw err;
  }
  if (routing.bill.state !== "draft") {
    const err: any = new Error(
      `Refusing to split: bill state is "${routing.bill.state}", not "draft". Splits can only be performed on draft bills.`,
    );
    err.response = {
      status: 409,
      data: { context: "bill_not_draft", bill_state: routing.bill.state },
    };
    throw err;
  }

  const bill = routing.bill;
  const matter = routing.activity.matter;
  if (!matter?.id) {
    throw new Error(`Could not resolve matter for activity ${activityId}.`);
  }
  const userId = routing.activity.user?.id;
  if (!userId) {
    throw new Error(
      `Could not resolve timekeeper (user) for activity ${activityId}.`,
    );
  }
  const date = routing.activity.date;
  const rate = routing.activity.price;
  // Activity quantity is in seconds on /activities; convert to decimal hours
  // for the strict-total comparison.
  const originalHours =
    Math.round((routing.activity.quantity / 3600) * 1000) / 1000;
  const originalNote = routing.activity.note || "";

  lineItemId = routing.line_item.id;

  // --- Strict-total check ---
  const splitTotal =
    Math.round(args.splits.reduce((acc, s) => acc + s.hours, 0) * 1000) / 1000;
  if (Math.abs(splitTotal - originalHours) > 0.005) {
    throw new Error(
      `prepareLineSplit: split total ${splitTotal}h must equal original line hours ${originalHours}h. Use update_billed_time_entry separately if you want to change the total billable hours.`,
    );
  }

  // --- Step 1: Create new activities for ALL splits (splits[0..N-1]),
  // with rollback on failure. We do creates BEFORE deleting the original so
  // a partial failure here is recoverable (just delete the partials).
  const createdActivityIds: number[] = [];
  const newActivities: Array<{ activity_id: number; hours: number; note: string }> = [];
  try {
    for (let i = 0; i < args.splits.length; i++) {
      const split = args.splits[i];
      const body: any = {
        data: {
          type: "TimeEntry",
          date,
          quantity: Math.round(split.hours * 3600), // /activities expects seconds
          user: { id: userId },
          matter: { id: matter.id },
          note: split.note,
        },
      };
      if (rate !== undefined && rate !== null) body.data.price = rate;
      const resp = await rawPostSingle("/activities", body);
      const newId = resp.data?.id;
      if (!newId) {
        throw new Error(`Failed to create activity for split ${i + 1}: no ID returned.`);
      }
      createdActivityIds.push(newId);
      newActivities.push({ activity_id: newId, hours: split.hours, note: split.note });
    }
  } catch (err: any) {
    // Rollback any partial creates.
    for (const id of createdActivityIds) {
      try {
        await rawDeleteSingle(`/activities/${id}`);
      } catch (rbErr: any) {
        console.error(
          `[prepareLineSplit] rollback delete /activities/${id} failed: ${rbErr.message}`,
        );
      }
    }
    throw err;
  }

  // --- Step 2: Delete the ORIGINAL activity, which auto-removes its
  // line_item from the draft bill (per delete_activity semantics). We can't
  // edit the original line's quantity in place — Clio's PATCH /line_items
  // silently ignores quantity for ActivityLineItem (see patchTimeEntrySmart's
  // silent-noop guard), and PATCH /activities is locked while billed. The
  // delete approach bypasses both constraints. Audit trail: Clio retains a
  // deletion record for the original activity.
  try {
    await deleteActivity(activityId!);
  } catch (err: any) {
    // Best-effort rollback: delete the new activities so the matter is left
    // in its original state. If deleteActivity partially completed (line
    // removed but activity not deleted), the original is now an unbilled
    // activity on the matter; re-attaching to the draft via API is
    // impossible (Clio has no POST /line_items), so user must regenerate
    // the draft in Clio UI to recover. Surface the partial state in the
    // error so the user knows.
    for (const id of createdActivityIds) {
      try {
        await rawDeleteSingle(`/activities/${id}`);
      } catch (rbErr: any) {
        console.error(
          `[prepareLineSplit] rollback delete /activities/${id} failed: ${rbErr.message}`,
        );
      }
    }
    throw err;
  }

  return {
    line_item_id: lineItemId,
    activity_id: activityId!,
    bill,
    matter: { id: matter.id, display_number: matter.display_number },
    original: {
      hours: originalHours,
      note: originalNote,
      date,
      rate,
    },
    edited_line: {
      // The original line was deleted, not edited — surfacing the deletion
      // here so the response shape stays consistent with previous versions
      // while making the actual semantics clear.
      hours: 0,
      note: "(original line deleted; replaced by new_activities below)",
    },
    new_activities: newActivities,
    ui_instruction: `Original activity ${activityId} (line on bill ${bill.number}) has been deleted. ${newActivities.length} new activities have been created on matter ${matter.display_number || matter.id}, all currently unbilled. To finalize: option A — open Clio UI → bill ${bill.number} → click "Regenerate Draft" (varies by Clio plan; may be under a ⋯ menu, or labeled "Refresh"). Option B (if regenerate isn't available on your plan) — run delete_draft_bill(bill_id=${bill.id}) then in Clio UI on matter ${matter.display_number || matter.id} click "Generate Bill". Either way, the new draft will include all ${args.splits.length} sub-entries.`,
  };
}

export interface MergeLineItemsResult {
  bill: { id: number; state?: string; number?: string };
  primary: {
    line_item_id: number;
    activity_id: number;
    note_updated: boolean;
    new_note?: string;
  };
  secondaries: Array<{
    line_item_id: number;
    activity_id?: number;
    status: "discounted_100pct" | "failed";
    before_total?: number;
    error?: string;
  }>;
  summary: {
    secondaries_total: number;
    secondaries_succeeded: number;
    secondaries_failed: number;
  };
}

// Merge multiple secondary line items on a DRAFT bill into a primary line.
// Implements the firm's stated rule: "don't delete the secondary entries —
// discount them to 100% so they stay visible at $0." Result on the bill:
//   - Primary line keeps its hours and (optionally) gets a new merged note.
//   - Each secondary line stays visible but at $0 via 100% discount.
//   - Net billable equals the primary's hours × rate.
//
// Why no quantity-roll-up to the primary: Clio's PATCH /line_items
// silently ignores `quantity` for ActivityLineItem (see patchTimeEntrySmart's
// silent-noop guard). Hard-combining hours into one line isn't possible via
// API. Soft-combining (preserve hours, zero out secondaries) is the working
// pattern — and it's what the firm rule prefers anyway because the audit
// trail is preserved.
//
// Per-secondary errors are isolated: if discount on secondary B fails, A
// stays discounted, B is reported as failed, C is still attempted. The
// caller decides how to handle partial-success.
export async function mergeLineItems(args: {
  primary_line_item_id: number;
  secondary_line_item_ids: number[];
  new_note?: string;
}): Promise<MergeLineItemsResult> {
  // --- Validate ---
  if (!Number.isFinite(args.primary_line_item_id)) {
    throw new Error("mergeLineItems: primary_line_item_id is required.");
  }
  if (!Array.isArray(args.secondary_line_item_ids) || args.secondary_line_item_ids.length === 0) {
    throw new Error("mergeLineItems: secondary_line_item_ids must be a non-empty array.");
  }
  for (const sid of args.secondary_line_item_ids) {
    if (!Number.isFinite(sid)) {
      throw new Error(`mergeLineItems: invalid secondary_line_item_id: ${sid}`);
    }
    if (sid === args.primary_line_item_id) {
      throw new Error(
        `mergeLineItems: primary_line_item_id (${args.primary_line_item_id}) cannot also be a secondary.`,
      );
    }
  }
  // Dedupe secondaries (caller intent unclear if duplicates were sent).
  const dedupedSecondaries = Array.from(new Set(args.secondary_line_item_ids));
  if (dedupedSecondaries.length !== args.secondary_line_item_ids.length) {
    throw new Error(
      `mergeLineItems: duplicate IDs in secondary_line_item_ids. Dedupe before calling.`,
    );
  }

  // --- Read primary, verify on a draft bill ---
  const primaryResp = await rawGetSingle(`/line_items/${args.primary_line_item_id}`, {
    fields: LINE_ITEM_FIELDS,
  });
  const primary = primaryResp.data;
  if (!primary) {
    const err: any = new Error(`Primary line item ${args.primary_line_item_id} not found.`);
    err.response = { status: 404 };
    throw err;
  }
  if (!primary.bill || primary.bill.state !== "draft") {
    const err: any = new Error(
      `Refusing to merge: primary line item ${args.primary_line_item_id} is on bill state "${primary.bill?.state ?? "none"}", not "draft".`,
    );
    err.response = {
      status: 409,
      data: { context: "primary_not_on_draft", bill_state: primary.bill?.state },
    };
    throw err;
  }
  const billId = primary.bill.id;
  const primaryActivityId = primary.activity?.id;
  if (!primaryActivityId) {
    throw new Error(
      `Primary line item ${args.primary_line_item_id} has no associated activity.`,
    );
  }

  // --- Read each secondary, verify same bill ---
  const secondaryReads: Array<{ id: number; activity_id?: number; total: number }> = [];
  for (const sid of dedupedSecondaries) {
    const resp = await rawGetSingle(`/line_items/${sid}`, { fields: LINE_ITEM_FIELDS });
    const li = resp.data;
    if (!li) {
      const err: any = new Error(`Secondary line item ${sid} not found.`);
      err.response = { status: 404 };
      throw err;
    }
    if (li.bill?.id !== billId) {
      const err: any = new Error(
        `Secondary line item ${sid} is on bill ${li.bill?.id ?? "none"}, but primary is on bill ${billId}. All secondaries must be on the same bill as the primary.`,
      );
      err.response = {
        status: 409,
        data: {
          context: "cross_bill_merge",
          primary_bill: billId,
          secondary_line_item_id: sid,
          secondary_bill: li.bill?.id,
        },
      };
      throw err;
    }
    if (li.bill?.state !== "draft") {
      const err: any = new Error(
        `Secondary line item ${sid} is on bill state "${li.bill?.state ?? "none"}", not "draft".`,
      );
      err.response = {
        status: 409,
        data: { context: "secondary_not_on_draft", bill_state: li.bill?.state },
      };
      throw err;
    }
    secondaryReads.push({
      id: sid,
      activity_id: li.activity?.id,
      total: typeof li.total === "number" ? li.total : 0,
    });
  }

  // --- Step 1: Optionally update primary's note ---
  let noteUpdated = false;
  if (args.new_note !== undefined) {
    if (typeof args.new_note !== "string" || args.new_note.length === 0) {
      throw new Error("mergeLineItems: new_note must be a non-empty string when provided.");
    }
    // patchTimeEntrySmart routes through /line_items since the activity is
    // on a draft. Only updating note (no hours change), so the silent-noop
    // guard for quantity won't fire.
    await patchTimeEntrySmart(primaryActivityId, { note: args.new_note });
    noteUpdated = true;
  }

  // --- Step 2: 100%-discount each secondary, isolating per-item failures ---
  const secondaryResults: MergeLineItemsResult["secondaries"] = [];
  for (const sec of secondaryReads) {
    try {
      // Skip if total is already 0 (already discounted or empty); just record.
      if (sec.total === 0) {
        secondaryResults.push({
          line_item_id: sec.id,
          activity_id: sec.activity_id,
          status: "discounted_100pct",
          before_total: 0,
        });
        continue;
      }
      await discountLineItem({
        line_item_id: sec.id,
        discount_pct: 100,
      });
      secondaryResults.push({
        line_item_id: sec.id,
        activity_id: sec.activity_id,
        status: "discounted_100pct",
        before_total: sec.total,
      });
    } catch (err: any) {
      secondaryResults.push({
        line_item_id: sec.id,
        activity_id: sec.activity_id,
        status: "failed",
        before_total: sec.total,
        error: err.message,
      });
    }
  }

  const succeeded = secondaryResults.filter((r) => r.status === "discounted_100pct").length;
  const failed = secondaryResults.filter((r) => r.status === "failed").length;

  return {
    bill: { id: billId, state: primary.bill.state, number: primary.bill.number },
    primary: {
      line_item_id: args.primary_line_item_id,
      activity_id: primaryActivityId,
      note_updated: noteUpdated,
      new_note: args.new_note,
    },
    secondaries: secondaryResults,
    summary: {
      secondaries_total: secondaryResults.length,
      secondaries_succeeded: succeeded,
      secondaries_failed: failed,
    },
  };
}

export interface PrepareHourChangeResult {
  bill: { id: number; state?: string; number?: string };
  matter: { id: number; display_number?: string };
  activity_id: number;
  line_item_id: number;
  before: { hours: number; note: string };
  after: { hours: number; note: string };
  ui_instruction: string;
}

// Workaround for Clio's silent-noop on PATCH /line_items.quantity (see
// patchTimeEntrySmart's silent-noop guard). Sequence:
//   1. remove_from_draft_bill — unbills the activity, /activities is now editable
//   2. PATCH /activities/{id} — set new quantity (and optionally new note)
//   3. Caller clicks "Regenerate Draft" in Clio UI to put the activity back
//      on the bill at the new hours.
//
// Multiple prepareHourChange calls can be batched before a single regenerate-
// draft click; Clio's regenerate pulls in ALL unbilled activities for the
// matter at once. Use case: invoice review with several hour reductions
// across the same draft bill.
//
// Failure modes:
//   - Step 1 fails: nothing changed, throw.
//   - Step 2 fails after Step 1: activity is unbilled but un-edited. Surface
//     the partial state in the error so the caller knows. Recovery: click
//     Regenerate Draft (line returns at original hours), or retry.
export async function prepareHourChange(args: {
  line_item_id?: number;
  activity_id?: number;
  new_hours: number;
  new_note?: string;
  force?: boolean;
}): Promise<PrepareHourChangeResult> {
  if (typeof args.new_hours !== "number" || !(args.new_hours > 0)) {
    throw new Error(
      `prepareHourChange: new_hours must be a positive number (got ${args.new_hours}).`,
    );
  }
  // Catastrophic-overcharge guard. This path PATCHes /activities directly,
  // bypassing patchTimeEntrySmart's inflation guard, so enforce the per-entry
  // daily ceiling here before anything is mutated.
  assertNewHoursSane(args.new_hours, { force: args.force });
  if (args.line_item_id === undefined && args.activity_id === undefined) {
    throw new Error("prepareHourChange: provide line_item_id or activity_id.");
  }

  // Resolve activity_id from line_item_id if needed.
  let activityId = args.activity_id;
  let lineItemId = args.line_item_id;
  if (!activityId && lineItemId) {
    const liResp = await rawGetSingle(`/line_items/${lineItemId}`, {
      fields: LINE_ITEM_FIELDS,
    });
    if (!liResp.data) {
      const err: any = new Error(`Line item ${lineItemId} not found.`);
      err.response = { status: 404 };
      throw err;
    }
    activityId = liResp.data.activity?.id;
    if (!activityId) {
      throw new Error(`Line item ${lineItemId} has no associated activity.`);
    }
  }

  // Get full routing (activity, bill, line_item, matter) for a single source of truth.
  const routing = await resolveActivityRouting(activityId!);
  if (!routing.bill || !routing.line_item) {
    const err: any = new Error(
      `Activity ${activityId} is not on a bill — nothing to change.`,
    );
    err.response = { status: 409, data: { context: "activity_not_on_bill" } };
    throw err;
  }
  if (routing.bill.state !== "draft") {
    const err: any = new Error(
      `Refusing to change hours: bill state is "${routing.bill.state}", not "draft".`,
    );
    err.response = {
      status: 409,
      data: { context: "bill_not_draft", bill_state: routing.bill.state },
    };
    throw err;
  }

  const bill = routing.bill;
  const matter = routing.activity.matter;
  const originalHours =
    Math.round((routing.activity.quantity / 3600) * 1000) / 1000;
  const originalNote = routing.activity.note || "";
  lineItemId = routing.line_item.id;

  // --- Step 1: Remove from draft bill (unbills the activity) ---
  await removeFromDraftBill({ line_item_id: lineItemId });

  // --- Step 2: PATCH /activities/{id} with new quantity (and optional note) ---
  const patchBody: any = {
    data: {
      quantity: Math.round(args.new_hours * 3600), // /activities expects seconds
    },
  };
  if (args.new_note !== undefined) patchBody.data.note = args.new_note;

  try {
    await rawPatchSingle(`/activities/${activityId}`, patchBody);
  } catch (err: any) {
    // Activity is unbilled but un-edited. Recovery options for the caller:
    // (a) regenerate draft → original line returns at original hours;
    // (b) retry prepare_hour_change → unbilled state allows a second attempt.
    const richErr: any = new Error(
      `Step 2 failed: PATCH /activities/${activityId} returned ${err.response?.status ?? "unknown status"}. The line was already removed from bill ${bill.number} (Step 1), but the hour change didn't apply. To recover: click "Regenerate Draft" on bill ${bill.number} in Clio UI to restore the line at its original ${originalHours}h, OR retry prepare_hour_change with the desired hours. Underlying Clio error: ${err.message}`,
    );
    richErr.response = {
      status: err.response?.status || 500,
      data: {
        context: "step2_patch_failed_after_remove",
        bill_id: bill.id,
        bill_number: bill.number,
        activity_id: activityId,
        original_hours: originalHours,
        clio_error: err.response?.data,
      },
    };
    throw richErr;
  }

  // Read-back verification: confirm /activities actually took the new quantity.
  // The line was already removed from the bill in Step 1, so a silent no-op here
  // would otherwise return success while leaving the entry unbilled at the WRONG
  // hours. A read failure alone shouldn't mask a likely-successful write, so only
  // a confirmed mismatch throws.
  try {
    const verify = await rawGetSingle(`/activities/${activityId}`, { fields: "id,quantity" });
    const gotHours = Math.round(((verify.data?.quantity ?? 0) / 3600) * 1000) / 1000;
    if (Math.abs(gotHours - args.new_hours) > 0.005) {
      const err: any = new Error(
        `Step 2 verification failed: /activities/${activityId} shows ${gotHours}h after the edit, not the requested ${args.new_hours}h — Clio may have silently ignored the change. The line was removed from bill ${bill.number} in Step 1; click "Regenerate Draft" to restore it at ${gotHours}h, or retry prepare_hour_change.`,
      );
      err.response = { status: 409, data: { context: "hour_change_not_applied", requested: args.new_hours, actual: gotHours } };
      throw err;
    }
  } catch (e: any) {
    if (e?.response?.data?.context === "hour_change_not_applied") throw e;
    console.warn(`[prepareHourChange] post-write verify read failed for activity ${activityId}: ${e?.message ?? e}`);
  }

  return {
    bill,
    matter: { id: matter.id, display_number: matter.display_number },
    activity_id: activityId!,
    line_item_id: lineItemId,
    before: { hours: originalHours, note: originalNote },
    after: { hours: args.new_hours, note: args.new_note ?? originalNote },
    ui_instruction: `Activity ${activityId} has been removed from bill ${bill.number} and edited to ${args.new_hours}h${args.new_note !== undefined ? " with new note" : ""}. To pull it back at the new hours: option A — open Clio UI → bill ${bill.number} → click "Regenerate Draft" (varies by Clio plan; may be labeled "Refresh" or under a ⋯ menu). Option B (if regenerate isn't available on your plan) — run delete_draft_bill(bill_id=${bill.id}) then in Clio UI on matter ${matter.display_number || matter.id} click "Generate Bill". Multiple prepare_hour_change calls can be batched before a single regenerate-or-delete-and-recreate finalize step.`,
  };
}

export interface PrepareHardCombineResult {
  bill: { id: number; state?: string; number?: string };
  matter: { id: number; display_number?: string };
  primary: {
    activity_id: number;
    line_item_id: number;
    before: { hours: number; note: string };
    after: { hours: number; note: string };
  };
  secondaries: Array<{
    line_item_id: number;
    activity_id?: number;
    treatment: "deleted" | "discounted_100pct";
    status: "succeeded" | "failed";
    before_total?: number;
    error?: string;
  }>;
  summary: {
    secondaries_total: number;
    secondaries_succeeded: number;
    secondaries_failed: number;
  };
  hours_reconciliation: { expected: number; requested: number; delta_hours: number; matches: boolean };
  dollars_reconciliation: {
    expected_dollars: number;
    resulting_dollars: number;
    delta_dollars: number;
    rates_uniform: boolean;
    matches: boolean;
  };
  ui_instruction: string;
}

// Hard-combine: roll the hours from secondary lines into the primary, then
// delete (or 100%-discount) the secondaries. Used during invoice review to
// consolidate same-day work into a single line.
//
// Composition over existing primitives:
//   1. prepareHourChange on the primary (sets new hours, optional new note).
//   2. For each secondary: deleteActivity (default) or discountLineItem(100%)
//      per `secondary_treatment`. Per-item errors are isolated.
//
// Use merge_line_items instead when the firm rule prefers preserving the
// audit trail (don't delete; discount-100%); merge_line_items is the soft-
// combine path that doesn't try to roll up hours.
export async function prepareHardCombine(args: {
  primary_line_item_id: number;
  secondary_line_item_ids: number[];
  new_primary_hours: number;
  new_note?: string;
  secondary_treatment?: "delete" | "discount_100pct";
  force?: boolean;
}): Promise<PrepareHardCombineResult> {
  const treatment = args.secondary_treatment ?? "delete";

  if (typeof args.new_primary_hours !== "number" || !(args.new_primary_hours > 0)) {
    throw new Error(
      `prepareHardCombine: new_primary_hours must be a positive number (got ${args.new_primary_hours}).`,
    );
  }
  if (!Number.isFinite(args.primary_line_item_id)) {
    throw new Error("prepareHardCombine: primary_line_item_id is required.");
  }
  if (!Array.isArray(args.secondary_line_item_ids) || args.secondary_line_item_ids.length === 0) {
    throw new Error(
      "prepareHardCombine: secondary_line_item_ids must be a non-empty array.",
    );
  }
  for (const sid of args.secondary_line_item_ids) {
    if (!Number.isFinite(sid)) {
      throw new Error(`prepareHardCombine: invalid secondary_line_item_id: ${sid}`);
    }
    if (sid === args.primary_line_item_id) {
      throw new Error(
        `prepareHardCombine: primary cannot also be a secondary (id ${sid}).`,
      );
    }
  }
  const dedupedSecondaries = Array.from(new Set(args.secondary_line_item_ids));
  if (dedupedSecondaries.length !== args.secondary_line_item_ids.length) {
    throw new Error(
      "prepareHardCombine: duplicate IDs in secondary_line_item_ids. Dedupe before calling.",
    );
  }

  // Read primary, verify on a draft bill.
  const primaryResp = await rawGetSingle(`/line_items/${args.primary_line_item_id}`, {
    fields: LINE_ITEM_FIELDS,
  });
  const primary = primaryResp.data;
  if (!primary) {
    const err: any = new Error(`Primary line item ${args.primary_line_item_id} not found.`);
    err.response = { status: 404 };
    throw err;
  }
  if (!primary.bill || primary.bill.state !== "draft") {
    const err: any = new Error(
      `Refusing to combine: primary line on bill state "${primary.bill?.state ?? "none"}", not "draft".`,
    );
    err.response = {
      status: 409,
      data: { context: "primary_not_on_draft", bill_state: primary.bill?.state },
    };
    throw err;
  }
  const billId = primary.bill.id;

  // Read each secondary, verify same bill, draft state.
  const secondaryReads: Array<{ id: number; activity_id?: number; total: number; hours: number; rate: number }> = [];
  for (const sid of dedupedSecondaries) {
    const resp = await rawGetSingle(`/line_items/${sid}`, { fields: LINE_ITEM_FIELDS });
    const li = resp.data;
    if (!li) {
      const err: any = new Error(`Secondary line item ${sid} not found.`);
      err.response = { status: 404 };
      throw err;
    }
    if (li.bill?.id !== billId) {
      const err: any = new Error(
        `Secondary ${sid} is on bill ${li.bill?.id ?? "none"}, but primary is on bill ${billId}.`,
      );
      err.response = {
        status: 409,
        data: {
          context: "cross_bill_combine",
          primary_bill: billId,
          secondary_bill: li.bill?.id,
          secondary_line_item_id: sid,
        },
      };
      throw err;
    }
    if (li.bill?.state !== "draft") {
      const err: any = new Error(
        `Secondary ${sid} on bill state "${li.bill?.state ?? "none"}", not "draft".`,
      );
      err.response = {
        status: 409,
        data: { context: "secondary_not_on_draft", bill_state: li.bill?.state },
      };
      throw err;
    }
    secondaryReads.push({
      id: sid,
      activity_id: li.activity?.id,
      total: typeof li.total === "number" ? li.total : 0,
      hours: typeof li.quantity === "number" ? li.quantity : 0,
      rate: typeof li.price === "number" ? li.price : 0,
    });
  }

  // Hours-conservation reconciliation: a hard-combine's new primary hours
  // should equal the original primary hours plus the secondaries' hours being
  // rolled in. A mismatch is either an intentional total change (force) or a
  // fat-finger — block it by default so a mistyped total can't silently
  // over/under-bill. (The 24h/entry ceiling in prepareHourChange applies too.)
  const originalPrimaryHours = typeof primary.quantity === "number" ? primary.quantity : 0;
  const primaryRate = typeof primary.price === "number" ? primary.price : 0;
  const hoursReconciliation = reconcileHardCombineHours(
    originalPrimaryHours,
    secondaryReads.map((s) => s.hours),
    args.new_primary_hours,
  );
  if (!hoursReconciliation.matches && !args.force) {
    const err: any = new Error(
      `Refusing to hard-combine: new_primary_hours=${args.new_primary_hours}h, but original primary (${originalPrimaryHours}h) + secondaries (${secondaryReads.map((s) => s.hours).join("+") || 0}h) = ${hoursReconciliation.expected}h. ` +
        `If you also intend to change the total billed hours, pass force=true; otherwise set new_primary_hours to ${hoursReconciliation.expected}.`,
    );
    err.response = { status: 409, data: { context: "hard_combine_hours_mismatch", ...hoursReconciliation } };
    throw err;
  }

  // Dollar-conservation reconciliation: rolling the secondaries' hours into the
  // primary rebills them at the PRIMARY's rate. When the secondaries carry a
  // different rate, the billed total silently changes even though hours are
  // conserved. Refuse by default so a rate-mixed combine can't quietly
  // over/under-bill the client; the reviewer confirms with force.
  const dollarsReconciliation = reconcileHardCombineDollars(
    { hours: originalPrimaryHours, rate: primaryRate },
    secondaryReads.map((s) => ({ hours: s.hours, rate: s.rate })),
    args.new_primary_hours,
  );
  if (!dollarsReconciliation.matches && !args.force) {
    const err: any = new Error(
      `Refusing to hard-combine: this would change the billed total from $${dollarsReconciliation.expected_dollars} to $${dollarsReconciliation.resulting_dollars} (Δ$${dollarsReconciliation.delta_dollars})` +
        (!dollarsReconciliation.rates_uniform
          ? ` because a secondary line's rate differs from the primary's $${primaryRate}/hr — its hours get rebilled at the primary's rate.`
          : `.`) +
        ` If the change is intended (e.g. a write-down while combining), pass force=true.`,
    );
    err.response = { status: 409, data: { context: "hard_combine_dollars_mismatch", ...dollarsReconciliation } };
    throw err;
  }

  // --- Step 1: prepareHourChange on primary ---
  const primaryResult = await prepareHourChange({
    line_item_id: args.primary_line_item_id,
    new_hours: args.new_primary_hours,
    new_note: args.new_note,
    force: args.force,
  });

  // --- Step 2: handle secondaries (per-item isolation) ---
  const secondaryResults: PrepareHardCombineResult["secondaries"] = [];
  for (const sec of secondaryReads) {
    if (treatment === "delete") {
      try {
        if (!sec.activity_id) {
          throw new Error(`Secondary ${sec.id} has no activity_id; cannot delete.`);
        }
        await deleteActivity(sec.activity_id);
        secondaryResults.push({
          line_item_id: sec.id,
          activity_id: sec.activity_id,
          treatment: "deleted",
          status: "succeeded",
          before_total: sec.total,
        });
      } catch (err: any) {
        secondaryResults.push({
          line_item_id: sec.id,
          activity_id: sec.activity_id,
          treatment: "deleted",
          status: "failed",
          before_total: sec.total,
          error: err.message,
        });
      }
    } else {
      // discount_100pct
      try {
        if (sec.total === 0) {
          // Already at $0; record as success without re-discounting.
          secondaryResults.push({
            line_item_id: sec.id,
            activity_id: sec.activity_id,
            treatment: "discounted_100pct",
            status: "succeeded",
            before_total: 0,
          });
          continue;
        }
        await discountLineItem({
          line_item_id: sec.id,
          discount_pct: 100,
        });
        secondaryResults.push({
          line_item_id: sec.id,
          activity_id: sec.activity_id,
          treatment: "discounted_100pct",
          status: "succeeded",
          before_total: sec.total,
        });
      } catch (err: any) {
        secondaryResults.push({
          line_item_id: sec.id,
          activity_id: sec.activity_id,
          treatment: "discounted_100pct",
          status: "failed",
          before_total: sec.total,
          error: err.message,
        });
      }
    }
  }

  const succeeded = secondaryResults.filter((r) => r.status === "succeeded").length;
  const failed = secondaryResults.filter((r) => r.status === "failed").length;

  return {
    bill: primaryResult.bill,
    matter: primaryResult.matter,
    primary: {
      activity_id: primaryResult.activity_id,
      line_item_id: primaryResult.line_item_id,
      before: primaryResult.before,
      after: primaryResult.after,
    },
    secondaries: secondaryResults,
    summary: {
      secondaries_total: secondaryResults.length,
      secondaries_succeeded: succeeded,
      secondaries_failed: failed,
    },
    hours_reconciliation: hoursReconciliation,
    dollars_reconciliation: dollarsReconciliation,
    ui_instruction: `Hard-combine prep complete on bill ${primaryResult.bill.number}. Primary activity ${primaryResult.activity_id} unbilled and re-edited to ${args.new_primary_hours}h${args.new_note !== undefined ? " with new note" : ""}. ${succeeded} ${treatment === "delete" ? "secondary activit" + (succeeded === 1 ? "y was" : "ies were") + " deleted" : "secondary line" + (succeeded === 1 ? " was" : "s were") + " discounted to 100%"}${failed > 0 ? ` (${failed} failed — see secondaries[] for details)` : ""}. To finalize: option A — open Clio UI → bill ${primaryResult.bill.number} → click "Regenerate Draft" (varies by Clio plan). Option B (if regenerate isn't available on your plan) — run delete_draft_bill(bill_id=${primaryResult.bill.id}) then in Clio UI on matter ${primaryResult.matter.display_number || primaryResult.matter.id} click "Generate Bill". Primary returns to bill at new hours, secondaries are ${treatment === "delete" ? "gone" : "still on the bill at $0"}.`,
  };
}

