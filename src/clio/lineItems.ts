import { fetchAllPages, rawGetSingle, rawPatchSingle, rawDeleteSingle } from "./pagination";

export interface LineItemSummary {
  id: number;
  description?: string;
  note?: string;
  quantity?: number;
  rounded_quantity?: number;
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
  "id,description,note,quantity,rounded_quantity,price,total,activity{id},bill{id,state,number}";

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
  quantity?: number; // seconds, matches Clio's storage
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
const ACTIVITY_PATCH_FIELDS = ["note", "price", "quantity", "date"] as const;
const LINE_ITEM_PATCH_FIELDS = ["note", "price", "quantity", "date"] as const;

function pickActivityPatch(patch: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of ACTIVITY_PATCH_FIELDS) {
    if (patch[k] !== undefined) out[k] = patch[k];
  }
  return out;
}

function pickLineItemPatch(patch: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of LINE_ITEM_PATCH_FIELDS) {
    if (patch[k] !== undefined) out[k] = patch[k];
  }
  return out;
}

// PATCH a time entry, transparently routing through /line_items when the
// entry is on a bill. Returns before/after for both paths.
export async function patchTimeEntrySmart(
  activityId: number,
  patch: SmartPatch,
): Promise<SmartPatchResult> {
  if (patch.note === undefined && patch.price === undefined && patch.quantity === undefined) {
    throw new Error("patchTimeEntrySmart: provide at least one of note, price, quantity");
  }

  const routing = await resolveActivityRouting(activityId);

  if (!routing.bill) {
    const before = {
      note: routing.activity.note,
      price: routing.activity.price,
      quantity: routing.activity.quantity,
    };
    const body = pickActivityPatch(patch as Record<string, any>);
    try {
      await rawPatchSingle(`/activities/${activityId}`, { data: body });
    } catch (err: any) {
      console.error(`[patchTimeEntrySmart] PATCH /activities/${activityId} failed status=${err.response?.status} body=${JSON.stringify(body)} clio_error=${JSON.stringify(err.response?.data || {}).slice(0, 400)}`);
      if (err.response) err.response.request_body = body;
      throw err;
    }
    const afterResp = await rawGetSingle(`/activities/${activityId}`, {
      fields: "id,note,price,quantity,rounded_quantity",
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
  const body = pickLineItemPatch(patch as Record<string, any>);
  if (Object.keys(body).length === 0) {
    const err: any = new Error(
      `patchTimeEntrySmart: nothing to write to line_item ${lineItemId} from patch ${JSON.stringify(patch)}. Allowed fields: ${LINE_ITEM_PATCH_FIELDS.join(", ")}.`,
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
  return {
    path: "line_item",
    activity_id: activityId,
    line_item_id: lineItemId,
    bill: routing.bill,
    before,
    after: afterResp.data,
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
