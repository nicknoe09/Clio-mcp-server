import { fetchAllPages, rawGetSingle, rawPatchSingle } from "./pagination";

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
    await rawPatchSingle(`/activities/${activityId}`, { data: patch });
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
    note: routing.line_item.note,
    description: routing.line_item.description,
    price: routing.line_item.price,
    quantity: routing.line_item.quantity,
    total: routing.line_item.total,
  };
  await rawPatchSingle(`/line_items/${lineItemId}`, { data: patch });
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
