import { describe, it, expect } from "vitest";
import { decideAttributedUser, AttributionError } from "../src/clio/actingUser";

const ACTING = 100;

describe("decideAttributedUser — cross-user attribution guard", () => {
  it("defaults to the acting user when no id is requested", () => {
    expect(decideAttributedUser(undefined, ACTING, false)).toBe(ACTING);
  });

  it("allows the acting user's own id (no flag needed)", () => {
    expect(decideAttributedUser(ACTING, ACTING, false)).toBe(ACTING);
  });

  it("rejects a different user id without on_behalf_of", () => {
    expect(() => decideAttributedUser(200, ACTING, false)).toThrow(AttributionError);
  });

  it("allows a different user id when on_behalf_of is set", () => {
    expect(decideAttributedUser(200, ACTING, true)).toBe(200);
  });

  it("the rejection names both the requested and acting users", () => {
    try {
      decideAttributedUser(200, ACTING, false);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AttributionError);
      expect((e as AttributionError).requested).toBe(200);
      expect((e as AttributionError).acting).toBe(ACTING);
      expect((e as Error).message).toMatch(/200/);
      expect((e as Error).message).toMatch(/100/);
    }
  });
});
