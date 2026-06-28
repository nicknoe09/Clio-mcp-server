import { describe, it, expect } from "vitest";
import { buildCustomRatePayload } from "../src/clio/matterRate";

describe("buildCustomRatePayload", () => {
  it("returns null when no user rates are given", () => {
    expect(buildCustomRatePayload({})).toBeNull();
    expect(buildCustomRatePayload({ rate_type: "hourly" })).toBeNull();
    expect(buildCustomRatePayload({ user_rates: [] })).toBeNull();
  });

  it("builds a single per-user hourly rate by default", () => {
    expect(buildCustomRatePayload({ user_rates: [{ user_id: 123, rate: 300 }] })).toEqual({
      type: "HourlyRate",
      rates: [{ user: { id: 123 }, rate: 300 }],
    });
  });

  it("maps rate_type 'flat' to FlatRate", () => {
    expect(
      buildCustomRatePayload({ rate_type: "flat", user_rates: [{ user_id: 1, rate: 5000 }] }),
    ).toEqual({
      type: "FlatRate",
      rates: [{ user: { id: 1 }, rate: 5000 }],
    });
  });

  it("builds multiple per-user rates in order", () => {
    expect(
      buildCustomRatePayload({
        user_rates: [
          { user_id: 344134017, rate: 300 },
          { user_id: 348755029, rate: 250 },
        ],
      }),
    ).toEqual({
      type: "HourlyRate",
      rates: [
        { user: { id: 344134017 }, rate: 300 },
        { user: { id: 348755029 }, rate: 250 },
      ],
    });
  });

  it("keeps a rate of 0 (not skipped)", () => {
    expect(buildCustomRatePayload({ user_rates: [{ user_id: 9, rate: 0 }] })).toEqual({
      type: "HourlyRate",
      rates: [{ user: { id: 9 }, rate: 0 }],
    });
  });
});
