import { describe, it, expect } from "vitest";
import {
  practiceAreaKey,
  resolvePracticeAreaByName,
  buildPracticeAreaPatch,
  isAlreadySet,
  type PracticeAreaLite,
} from "../src/clio/practiceArea";

const AREAS: PracticeAreaLite[] = [
  { id: 1, name: "Probate" },
  { id: 2, name: "Estate Planning" },
  { id: 3, name: "Dependent Administration" },
  { id: 4, name: "Estate Litigation" },
  { id: 5, name: "Trust Administration" },
];

describe("practiceAreaKey", () => {
  it("folds case and collapses whitespace", () => {
    expect(practiceAreaKey("  Dependent   Administration ")).toBe("dependent administration");
    expect(practiceAreaKey("PROBATE")).toBe("probate");
  });
});

describe("resolvePracticeAreaByName", () => {
  it("resolves an exact name to its id", () => {
    expect(resolvePracticeAreaByName("Dependent Administration", AREAS)).toEqual({
      ok: true,
      id: 3,
      name: "Dependent Administration",
    });
  });

  it("ignores case and surrounding/inner whitespace", () => {
    expect(resolvePracticeAreaByName("  dependent   administration  ", AREAS)).toEqual({
      ok: true,
      id: 3,
      name: "Dependent Administration",
    });
  });

  it("refuses a partial or abbreviated name rather than guessing", () => {
    expect(resolvePracticeAreaByName("Dependent Admin", AREAS)).toEqual({ ok: false, reason: "not_found" });
    expect(resolvePracticeAreaByName("Dependent", AREAS)).toEqual({ ok: false, reason: "not_found" });
    expect(resolvePracticeAreaByName("Estate", AREAS)).toEqual({ ok: false, reason: "not_found" });
  });

  it("does not resolve a name that only exists as a near neighbour", () => {
    // 'Trust Matter' was used in the audit; Clio only has 'Trust Administration'.
    expect(resolvePracticeAreaByName("Trust Matter", AREAS)).toEqual({ ok: false, reason: "not_found" });
  });

  it("treats an empty or whitespace-only name as not found", () => {
    expect(resolvePracticeAreaByName("", AREAS)).toEqual({ ok: false, reason: "not_found" });
    expect(resolvePracticeAreaByName("   ", AREAS)).toEqual({ ok: false, reason: "not_found" });
  });

  it("reports ambiguity instead of picking the first duplicate", () => {
    const dupes: PracticeAreaLite[] = [
      { id: 7, name: "Probate" },
      { id: 8, name: "probate" },
    ];
    const res = resolvePracticeAreaByName("Probate", dupes);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: "ambiguous" });
    if (!res.ok && res.reason === "ambiguous") {
      expect(res.matches.map((m) => m.id)).toEqual([7, 8]);
    }
  });

  it("tolerates rows with a missing name", () => {
    const messy = [{ id: 9 } as unknown as PracticeAreaLite, ...AREAS];
    expect(resolvePracticeAreaByName("Probate", messy)).toEqual({ ok: true, id: 1, name: "Probate" });
  });

  it("returns not_found against an empty list", () => {
    expect(resolvePracticeAreaByName("Probate", [])).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("buildPracticeAreaPatch", () => {
  it("wraps the id as an association object under data", () => {
    expect(buildPracticeAreaPatch(3)).toEqual({ data: { practice_area: { id: 3 } } });
  });

  it("sends only the practice area, so no other matter field is touched", () => {
    expect(Object.keys(buildPracticeAreaPatch(3).data)).toEqual(["practice_area"]);
  });
});

describe("isAlreadySet", () => {
  it("is true only when the matter already carries the target id", () => {
    expect(isAlreadySet({ id: 3 }, 3)).toBe(true);
    expect(isAlreadySet({ id: 1 }, 3)).toBe(false);
  });

  it("is false when the matter has no practice area", () => {
    expect(isAlreadySet(null, 3)).toBe(false);
    expect(isAlreadySet(undefined, 3)).toBe(false);
    expect(isAlreadySet({ id: null }, 3)).toBe(false);
  });
});
