import { describe, it, expect } from "vitest";
import { buildCustomRatePayload } from "../src/clio/matterRate";

describe("buildCustomRatePayload", () => {
  it("returns null when no rate input is given", () => {
    expect(buildCustomRatePayload({})).toBeNull();
    expect(buildCustomRatePayload({ rate_type: "hourly" })).toBeNull();
    expect(buildCustomRatePayload({ user_rates: [] })).toBeNull();
  });

  it("builds a matter-wide hourly rate (no user) by default", () => {
    expect(buildCustomRatePayload({ matter_rate: 300 })).toEqual({
      type: "HourlyRate",
      rates: [{ rate: 300 }],
    });
  });

  it("maps rate_type 'flat' to FlatRate", () => {
    expect(buildCustomRatePayload({ rate_type: "flat", matter_rate: 5000 })).toEqual({
      type: "FlatRate",
      rates: [{ rate: 5000 }],
    });
  });

  it("builds per-user rates", () => {
    expect(
      buildCustomRatePayload({
        user_rates: [
          { user_id: 123, rate: 300 },
          { user_id: 456, rate: 250 },
        ],
      }),
    ).toEqual({
      type: "HourlyRate",
      rates: [
        { user: { id: 123 }, rate: 300 },
        { user: { id: 456 }, rate: 250 },
      ],
    });
  });

  it("combines a matter-wide rate with per-user overrides (matter-wide first)", () => {
    expect(
      buildCustomRatePayload({
        matter_rate: 275,
        user_rates: [{ user_id: 789, rate: 350 }],
      }),
    ).toEqual({
      type: "HourlyRate",
      rates: [{ rate: 275 }, { user: { id: 789 }, rate: 350 }],
    });
  });

  it("treats matter_rate of 0 as a real value (not skipped)", () => {
    expect(buildCustomRatePayload({ matter_rate: 0 })).toEqual({
      type: "HourlyRate",
      rates: [{ rate: 0 }],
    });
  });
});
