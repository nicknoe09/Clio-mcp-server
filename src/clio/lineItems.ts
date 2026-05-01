import { fetchAllPages, rawGetSingle, rawPatchSingle, rawDeleteSingle, rawPostSingle } from "./pagination";

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
  return out;
}

// Catastrophic-overcharge guard. If a line_item PATCH would write a total
// more than this multiple of the existing line total, refuse and roll back.
// The hours-vs-seconds bug we already fixed could have produced 1000x
// totals; this is a belt-and-suspenders check in case a future caller
// regresses the unit handling.
const MAX_TOTAL_INFLATION = 5;

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
  before: { price?: number; quantity?: number; total?: number; discount_total?: number };
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
    const liResp = await rawGetSingle(`/line_items/${lineItemId}`, { fields: LINE_ITEM_FIELDS + ",discount_total" });
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
    const liResp = await rawGetSingle(`/line_items/${lineItemId}`, { fields: LINE_ITEM_FIELDS + ",discount_total" });
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

  const body = { discount_total: discountAmount };
  try {
    await rawPatchSingle(`/line_items/${lineItemId}`, { data: body });
  } catch (err: any) {
    console.error(`[discountLineItem] PATCH /line_items/${lineItemId} failed status=${err.response?.status} body=${JSON.stringify(body)} clio_error=${JSON.stringify(err.response?.data || {}).slice(0, 400)}`);
    if (err.response) err.response.request_body = body;
    throw err;
  }
  const afterResp = await rawGetSingle(`/line_items/${lineItemId}`, { fields: LINE_ITEM_FIELDS + ",discount_total" });

  return {
    line_item_id: lineItemId!,
    activity_id: activityId,
    bill,
    before: {
      price: beforeLineItem?.price,
      quantity: beforeLineItem?.quantity,
      total: beforeLineItem?.total,
      discount_total: beforeLineItem?.discount_total,
    },
    after: afterResp.data,
    discount_amount_applied: discountAmount,
    discount_pct_applied: Math.round(discountPct * 100) / 100,
  };
}

export interface AddToDraftBillResult {
  line_item_id: number;
  activity_id: number;
  bill: { id: number; state?: string; number?: string };
  already_on_bill: boolean;
}

// Add an existing activity to a DRAFT bill by creating a line_item that
// references both. Used after delete-and-recreate workflows (e.g.
// changing an entry's date) where the new activity is unbilled and needs
// to be reattached to a draft bill that was already mid-edit.
//
// Refuses if:
//   - the bill is not in draft state (touching issued bills can corrupt
//     accounting)
//   - the activity is already attached to a different bill (caller must
//     unbill first via remove_from_draft_bill)
// Idempotent: if the activity is already on the requested bill, returns
// the existing line_item with already_on_bill=true.
export async function addToDraftBill(args: {
  activity_id: number;
  bill_id: number;
}): Promise<AddToDraftBillResult> {
  const billResp = await rawGetSingle(`/bills/${args.bill_id}`, { fields: "id,number,state" });
  const bill = billResp.data;
  if (!bill) {
    const err: any = new Error(`Bill ${args.bill_id} not found.`);
    err.response = { status: 404 };
    throw err;
  }
  if (bill.state !== "draft") {
    const err: any = new Error(
      `Refusing to add line_item to bill ${args.bill_id}: state is "${bill.state}", not "draft".`,
    );
    err.response = { status: 409, data: { context: "bill_not_draft", bill_state: bill.state } };
    throw err;
  }

  const routing = await resolveActivityRouting(args.activity_id);
  if (routing.bill && routing.bill.id !== args.bill_id) {
    const err: any = new Error(
      `Activity ${args.activity_id} is already on bill ${routing.bill.id} (state="${routing.bill.state}"). Remove it from that bill first via remove_from_draft_bill, then re-attempt.`,
    );
    err.response = { status: 409, data: { context: "activity_on_other_bill", current_bill: routing.bill } };
    throw err;
  }
  if (routing.bill && routing.bill.id === args.bill_id && routing.line_item) {
    return {
      line_item_id: routing.line_item.id,
      activity_id: args.activity_id,
      bill: { id: args.bill_id, state: bill.state, number: bill.number },
      already_on_bill: true,
    };
  }

  const matterId = routing.activity?.matter?.id;
  if (!matterId) {
    const err: any = new Error(
      `Activity ${args.activity_id} has no matter — cannot attach to a bill.`,
    );
    err.response = { status: 400, data: { context: "activity_has_no_matter" } };
    throw err;
  }

  // Clio's POST /line_items rejected the minimal {bill, activity} body with
  // "The matter is invalid." (verified live, 04/2026). Including matter as
  // a top-level association is the documented convention used elsewhere in
  // Clio's v4 API; the line_item record is denormalized rather than a thin
  // join table. If Clio names additional missing fields in a future 422,
  // add them here based on request_body + clio_error in the log.
  const body = {
    data: {
      bill: { id: args.bill_id },
      activity: { id: args.activity_id },
      matter: { id: matterId },
    },
  };
  let resp: any;
  try {
    resp = await rawPostSingle("/line_items", body);
  } catch (err: any) {
    console.error(`[addToDraftBill] POST /line_items failed status=${err.response?.status} body=${JSON.stringify(body)} clio_error=${JSON.stringify(err.response?.data || {}).slice(0, 400)}`);
    if (err.response) err.response.request_body = body;
    throw err;
  }
  const lineItem = resp.data;
  return {
    line_item_id: lineItem.id,
    activity_id: args.activity_id,
    bill: { id: args.bill_id, state: bill.state, number: bill.number },
    already_on_bill: false,
  };
}
