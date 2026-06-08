import { describe, it, expect } from "vitest";
import { applyTieredSplit } from "../src/domain/vd";

describe("applyTieredSplit (V&D tiers 82.5/80/77.5 at 250k/500k)", () => {
  it("all within tier 1", () => {
    expect(applyTieredSplit(100000, 0)).toEqual({ vd: 82500, firm: 17500, ytdAfter: 100000 });
  });
  it("spans tier 1 -> 2", () => {
    // 250k @82.5% + 50k @80%
    expect(applyTieredSplit(300000, 0)).toEqual({ vd: 246250, firm: 53750, ytdAfter: 300000 });
  });
  it("respects prior YTD (starts mid tier 1)", () => {
    // ytd 240k: 10k @82.5% + 90k @80%
    expect(applyTieredSplit(100000, 240000)).toEqual({ vd: 80250, firm: 19750, ytdAfter: 340000 });
  });
  it("spans tier 2 -> 3", () => {
    // ytd 450k: 50k @80% + 50k @77.5%
    expect(applyTieredSplit(100000, 450000)).toEqual({ vd: 78750, firm: 21250, ytdAfter: 550000 });
  });
  it("zero amount is a no-op", () => {
    expect(applyTieredSplit(0, 123456)).toEqual({ vd: 0, firm: 0, ytdAfter: 123456 });
  });
});
