import { describe, it, expect } from "vitest";
import {
  classifyTrack,
  effectiveTrack,
  GATED_PRACTICE_AREAS,
  SEMI_GATED_PRACTICE_AREAS,
} from "../src/tools/ar";

// The Gated/Non-Gated mapping is a firm policy choice. These tests lock it in so
// it can only change deliberately (with a corresponding partner decision).
describe("classifyTrack", () => {
  it("classifies every gated practice area as gated", () => {
    for (const pa of GATED_PRACTICE_AREAS) {
      expect(classifyTrack(pa)).toBe("gated");
    }
  });

  it("classifies Probate as semi_gated", () => {
    for (const pa of SEMI_GATED_PRACTICE_AREAS) {
      expect(classifyTrack(pa)).toBe("semi_gated");
    }
    expect(classifyTrack("Probate")).toBe("semi_gated");
  });

  it("classifies any other known practice area as non_gated (client-pay)", () => {
    expect(classifyTrack("Family Law")).toBe("non_gated");
    expect(classifyTrack("Estate Planning")).toBe("non_gated");
    expect(classifyTrack("Litigation")).toBe("non_gated");
  });

  it("treats null / blank / undefined practice area as unclassified, never bucketed", () => {
    expect(classifyTrack(null)).toBe("unclassified");
    expect(classifyTrack(undefined)).toBe("unclassified");
    expect(classifyTrack("")).toBe("unclassified");
    expect(classifyTrack("   ")).toBe("unclassified");
  });

  it("is exact-match (trimmed) and case-sensitive to the firm taxonomy", () => {
    expect(classifyTrack("  Guardianship  ")).toBe("gated"); // trimmed
    expect(classifyTrack("guardianship")).toBe("non_gated"); // wrong case → not gated
  });
});

describe("effectiveTrack (probate_treatment)", () => {
  it("keeps Probate as its own bucket when treatment is 'separate'", () => {
    expect(effectiveTrack("semi_gated", "separate")).toBe("semi_gated");
  });

  it("folds Probate into gated when treatment is 'gated'", () => {
    expect(effectiveTrack("semi_gated", "gated")).toBe("gated");
  });

  it("folds Probate into non_gated when treatment is 'non_gated'", () => {
    expect(effectiveTrack("semi_gated", "non_gated")).toBe("non_gated");
  });

  it("never reassigns non-probate tracks regardless of treatment", () => {
    for (const t of ["separate", "gated", "non_gated"] as const) {
      expect(effectiveTrack("gated", t)).toBe("gated");
      expect(effectiveTrack("non_gated", t)).toBe("non_gated");
      expect(effectiveTrack("unclassified", t)).toBe("unclassified");
    }
  });
});
