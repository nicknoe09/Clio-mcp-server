import { describe, it, expect, vi, beforeEach } from "vitest";

// patchTimeEntrySmart is the single write path behind update_billed_time_entry
// and apply_entry_revision, and it is the place where two separate billing
// incidents live:
//
//   1. The hours/seconds unit bug. /activities takes `quantity` in SECONDS,
//      /line_items takes it in HOURS. Sending hours*3600 to /line_items wrote
//      that number as hours — 0.6 hr became 2160 hr, $270 became $972,000.
//      The conversion now lives in the two wire-body builders, one per
//      endpoint, and these tests assert the split directly off the request
//      body so a caller-side "fix" can't reintroduce it.
//   2. Clio's silent no-op on /line_items.quantity for ActivityLineItem types.
//      Clio returns 200 and does not apply the change, so an hour reduction
//      looked applied and wasn't. The read-back guard turns that into a loud
//      422 and rolls back any sibling note/price write. Without a test, a
//      refactor that drops the read-back restores a bill that silently keeps
//      its original hours while the run reports a reduction.
//
// Both are asserted here against a mocked Clio, since neither can be
// reproduced on a live bill without writing to a client's invoice.
vi.mock("../src/clio/pagination", () => ({
  fetchAllPages: vi.fn(),
  rawGetSingle: vi.fn(),
  rawPatchSingle: vi.fn(),
  rawPostSingle: vi.fn(),
  rawDeleteSingle: vi.fn(),
}));

import { fetchAllPages, rawGetSingle, rawPatchSingle } from "../src/clio/pagination";
import {
  patchTimeEntrySmart,
  snapHoursToIncrement,
  resetBillingIncrementCache,
  FALLBACK_BILLING_INCREMENT_HOURS,
} from "../src/clio/lineItems";

const ACTIVITY_ID = 111;
const LINE_ITEM_ID = 222;

interface Scenario {
  activity: Record<string, any>;
  lineItem?: Record<string, any>;
  /** What the post-PATCH read-back of the line item reports. */
  lineItemAfter?: Record<string, any>;
  /** What GET /settings/billing reports (rounding is in MINUTES). */
  billingSettings?: Record<string, any>;
  billingSettingsError?: boolean;
}

/** Wire up the mocked Clio and return the PATCH bodies it received, in order. */
function wire(sc: Scenario) {
  const patches: { path: string; body: any }[] = [];
  vi.mocked(rawPatchSingle).mockImplementation(async (path: string, payload?: any) => {
    patches.push({ path, body: payload?.data });
    return { data: {} } as any;
  });
  vi.mocked(rawGetSingle).mockImplementation(async (path: string) => {
    if (path === `/activities/${ACTIVITY_ID}`) return { data: sc.activity } as any;
    if (path === `/line_items/${LINE_ITEM_ID}`) return { data: sc.lineItemAfter } as any;
    if (path === "/settings/billing") {
      if (sc.billingSettingsError) throw new Error("boom");
      // Live 2026-09-03: this firm reports rounding=12 minutes (0.2h).
      return { data: sc.billingSettings ?? { id: 92911, rounding: 12 } } as any;
    }
    throw new Error(`unexpected GET ${path}`);
  });
  vi.mocked(fetchAllPages).mockImplementation(async () => (sc.lineItem ? [sc.lineItem] : []) as any);
  return patches;
}

const unbilled = (): Scenario => ({
  activity: { id: ACTIVITY_ID, note: "original", price: 450, quantity: 3600, date: "2026-04-14" },
});

const onDraftBill = (afterQuantity: number, afterNote = "original"): Scenario => ({
  activity: {
    id: ACTIVITY_ID,
    note: "original",
    price: 450,
    quantity: 3600,
    date: "2026-04-14",
    billed: true,
    bill: { id: 22263, state: "draft", number: "22263" },
  },
  lineItem: {
    id: LINE_ITEM_ID,
    activity: { id: ACTIVITY_ID },
    note: "original",
    price: 450,
    quantity: 1.0,
    total: 450,
    bill: { id: 22263, state: "draft" },
  },
  lineItemAfter: {
    id: LINE_ITEM_ID,
    activity: { id: ACTIVITY_ID },
    note: afterNote,
    price: 450,
    quantity: afterQuantity,
    total: 450 * afterQuantity,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetBillingIncrementCache();
});

describe("hours unit conversion is per endpoint", () => {
  it("sends SECONDS to /activities for an unbilled entry", async () => {
    const patches = wire(unbilled());
    await patchTimeEntrySmart(ACTIVITY_ID, { hours: 0.6 });
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe(`/activities/${ACTIVITY_ID}`);
    expect(patches[0].body.quantity).toBe(2160); // 0.6 * 3600
  });

  it("sends HOURS to /line_items for a billed entry — never hours*3600", async () => {
    const patches = wire(onDraftBill(0.6));
    await patchTimeEntrySmart(ACTIVITY_ID, { hours: 0.6 });
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe(`/line_items/${LINE_ITEM_ID}`);
    expect(patches[0].body.quantity).toBe(0.6);
    // The exact value that produced the $972,000 line.
    expect(patches[0].body.quantity).not.toBe(2160);
  });

  it("refuses an out-of-range hours value before any write reaches Clio", async () => {
    const patches = wire(onDraftBill(60));
    await expect(patchTimeEntrySmart(ACTIVITY_ID, { hours: 60 })).rejects.toThrow(
      /24h\/day sanity ceiling/,
    );
    expect(patches).toHaveLength(0);
    expect(rawGetSingle).not.toHaveBeenCalled();
  });
});

describe("silent-noop guard on /line_items.quantity", () => {
  it("throws billed_quantity_silently_ignored when the line keeps its original hours", async () => {
    wire(onDraftBill(1.0)); // Clio returned 200 but the line is still 1.0h
    const err = await patchTimeEntrySmart(ACTIVITY_ID, { hours: 0.4 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.response.status).toBe(422);
    expect(err.response.data.context).toBe("billed_quantity_silently_ignored");
    expect(err.response.data.requested_hours).toBe(0.4);
    expect(err.response.data.actual_hours).toBe(1.0);
  });

  it("rolls the note back so a refused hour edit leaves the line untouched", async () => {
    // The dangerous shape: the note edit applies, the hour edit doesn't. A
    // half-applied line would show a rewritten narrative at the original hours.
    const patches = wire(onDraftBill(1.0, "rewritten"));
    await expect(
      patchTimeEntrySmart(ACTIVITY_ID, { hours: 0.4, note: "rewritten" }),
    ).rejects.toThrow(/did not reach the expected quantity/);
    expect(patches).toHaveLength(2);
    expect(patches[1].path).toBe(`/line_items/${LINE_ITEM_ID}`);
    expect(patches[1].body.note).toBe("original");
    expect(patches[1].body.quantity).toBeUndefined();
  });

  it("accepts the write when Clio does apply the new quantity", async () => {
    wire(onDraftBill(0.4));
    const result = await patchTimeEntrySmart(ACTIVITY_ID, { hours: 0.4 });
    expect(result.path).toBe("line_item");
    expect(result.after.quantity).toBe(0.4);
  });

  it("does not fire on the /activities path, where hours do apply", async () => {
    // after.quantity on /activities is in seconds; comparing it to decimal
    // hours would make every unbilled hour edit look like a silent no-op.
    const sc = unbilled();
    sc.activity = { ...sc.activity, quantity: 1440 }; // read-back after 0.4h
    wire(sc);
    const result = await patchTimeEntrySmart(ACTIVITY_ID, { hours: 0.4 });
    expect(result.path).toBe("activity");
  });
});

describe("billing-increment snapping (KES 2026-09-03: 422 reported after the write landed)", () => {
  it("snaps hours up to the increment before the write and reports the rounding", async () => {
    // The incident: a 0.25h request on a 0.2h grid. Clio stored 0.4h and the
    // old guard compared 0.25 against 0.4, called it a silent no-op, and
    // returned 422 — after the change had already persisted to the draft bill.
    const patches = wire(onDraftBill(0.4));
    const result = await patchTimeEntrySmart(ACTIVITY_ID, { hours: 0.25 });
    expect(patches).toHaveLength(1);
    expect(patches[0].body.quantity).toBe(0.4); // snapped, not 0.25
    expect(result.quantity_rounding).toEqual({
      requested_hours: 0.25,
      applied_hours: 0.4,
      increment_hours: 0.2,
      increment_source: "billing_settings",
      rounded: true,
    });
  });

  it("never returns 422 for an off-increment request whose write persisted", async () => {
    wire(onDraftBill(0.4));
    // Not just "does not throw": specifically not the guard that told the
    // caller nothing happened while the bill's sum_hours moved 0.8 -> 1.0.
    const err = await patchTimeEntrySmart(ACTIVITY_ID, { hours: 0.25 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(Error);
    expect((err as any).after.quantity).toBe(0.4);
  });

  it("reads the increment from /settings/billing, not a hardcoded 0.2", async () => {
    const sc = onDraftBill(0.5);
    sc.billingSettings = { id: 1, rounding: 6 }; // 6 min = 0.1h grid
    const patches = wire(sc);
    const result = await patchTimeEntrySmart(ACTIVITY_ID, { hours: 0.45 });
    expect(patches[0].body.quantity).toBe(0.5);
    expect(result.quantity_rounding?.increment_hours).toBe(0.1);
  });

  it("falls back to the named firm-specific constant when settings are unreadable", async () => {
    const sc = onDraftBill(0.4);
    sc.billingSettingsError = true;
    const patches = wire(sc);
    const result = await patchTimeEntrySmart(ACTIVITY_ID, { hours: 0.25 });
    expect(result.quantity_rounding?.increment_source).toBe("fallback");
    expect(result.quantity_rounding?.increment_hours).toBe(FALLBACK_BILLING_INCREMENT_HOURS);
    expect(patches[0].body.quantity).toBe(0.4);
  });

  it("leaves an on-increment request alone, and note + rate in the same call survive", async () => {
    // The live control case: 0.6h on the 0.2h grid, with a new note and rate.
    const sc = onDraftBill(0.6, "rewritten");
    sc.lineItemAfter = { ...sc.lineItemAfter, price: 250, total: 150 };
    const patches = wire(sc);
    const result = await patchTimeEntrySmart(ACTIVITY_ID, {
      hours: 0.6,
      note: "rewritten",
      price: 250,
    });
    expect(patches).toHaveLength(1); // no rollback write
    expect(patches[0].body).toMatchObject({ quantity: 0.6, note: "rewritten", price: 250 });
    expect(result.after.quantity).toBe(0.6);
    expect(result.after.note).toBe("rewritten");
    expect(result.after.price).toBe(250);
    expect(result.quantity_rounding?.rounded).toBe(false);
  });

  it("still fires 422 on a genuine no-op, and the message claims no rollback that did not happen", async () => {
    const patches = wire(onDraftBill(1.0)); // Clio kept the original 1.0h
    const err = await patchTimeEntrySmart(ACTIVITY_ID, { hours: 0.25 }).catch((e) => e);
    expect(err.response.status).toBe(422);
    expect(err.response.data.context).toBe("billed_quantity_silently_ignored");
    expect(err.response.data.expected_hours).toBe(0.4);
    expect(err.response.data.actual_hours).toBe(1.0);
    expect(err.response.data.quantity_persisted).toBe(false);
    expect(err.message).toMatch(/did not move: it is still 1h/);
    expect(err.message).toMatch(/No sibling fields \(note\/price\) were changed/);
    expect(patches).toHaveLength(1); // nothing rolled back, because nothing applied
  });

  it("on a genuine no-op with a note, the rollback is real and is what the message reports", async () => {
    const patches = wire(onDraftBill(1.0, "rewritten"));
    const err = await patchTimeEntrySmart(ACTIVITY_ID, {
      hours: 0.4,
      note: "rewritten",
    }).catch((e) => e);
    expect(err.response.status).toBe(422);
    expect(patches).toHaveLength(2);
    expect(patches[1].body.note).toBe("original");
    expect(patches[1].body.quantity).toBeUndefined();
    expect(err.response.data.rolled_back_fields).toEqual({ note: true, price: false });
    expect(err.message).toMatch(/were rolled back to their prior values/);
  });

  it("reports a persisted quantity instead of asserting a rollback that never happens", async () => {
    // Quantity moved, but not to the snapped value (Clio landed somewhere
    // else). The guard must say the write persisted - it never rewrites
    // quantity, so claiming atomicity here would be a lie.
    const patches = wire(onDraftBill(0.6));
    const err = await patchTimeEntrySmart(ACTIVITY_ID, { hours: 0.25 }).catch((e) => e);
    expect(err.response.status).toBe(422);
    expect(err.response.data.quantity_persisted).toBe(true);
    expect(err.message).toMatch(/PERSISTED/);
    expect(err.message).not.toMatch(/rolled back to keep the line atomic/);
    expect(patches).toHaveLength(1);
  });
});

describe("snapHoursToIncrement", () => {
  it("rounds up to the grid the way Clio does", () => {
    expect(snapHoursToIncrement(0.25, 0.2)).toBe(0.4);
    expect(snapHoursToIncrement(0.05, 0.2)).toBe(0.2);
    expect(snapHoursToIncrement(0.21, 0.2)).toBe(0.4);
  });

  it("leaves on-grid values exactly alone despite float error", () => {
    for (const h of [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 3.0, 7.4]) {
      expect(snapHoursToIncrement(h, 0.2)).toBe(h);
    }
  });

  it("passes through when there is no grid", () => {
    expect(snapHoursToIncrement(0.25, 0)).toBe(0.25);
  });
});
