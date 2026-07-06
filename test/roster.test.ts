import { describe, it, expect } from "vitest";
import { FIRM_ROSTER, SCORECARD_ROSTER, INITIALS_BY_USER_ID, MONTH_NAMES_FULL, MONTH_NAMES_SHORT } from "../src/domain/roster";

describe("roster", () => {
  it("FIRM_ROSTER has 13 unique members (incl. Stacy/SAB)", () => {
    expect(FIRM_ROSTER).toHaveLength(13);
    expect(new Set(FIRM_ROSTER.map(r => r.user_id)).size).toBe(13);
    expect(new Set(FIRM_ROSTER.map(r => r.initials)).size).toBe(13);
    expect(FIRM_ROSTER.some(r => r.initials === "SAB")).toBe(true);
  });
  it("SAB has her real Clio user_id (no placeholders in the roster)", () => {
    expect(FIRM_ROSTER.find(r => r.initials === "SAB")?.user_id).toBe(360383465);
    // 999xxxxxxx was the pre-onboarding placeholder convention — none should remain.
    for (const r of FIRM_ROSTER) expect(r.user_id).toBeLessThan(999000000);
  });
  it("SCORECARD_ROSTER is FIRM minus Of-Counsel (KGV/CTD)", () => {
    expect(SCORECARD_ROSTER).toHaveLength(FIRM_ROSTER.length - 2);
    const ini = SCORECARD_ROSTER.map(r => r.initials);
    expect(ini).not.toContain("KGV");
    expect(ini).not.toContain("CTD");
    expect(ini).toEqual(FIRM_ROSTER.filter(r => r.initials !== "KGV" && r.initials !== "CTD").map(r => r.initials));
  });
  it("INITIALS_BY_USER_ID covers the full roster", () => {
    expect(Object.keys(INITIALS_BY_USER_ID)).toHaveLength(FIRM_ROSTER.length);
    for (const r of FIRM_ROSTER) expect(INITIALS_BY_USER_ID[r.user_id]).toBe(r.initials);
  });
  it("month name arrays", () => {
    expect(MONTH_NAMES_FULL).toHaveLength(12);
    expect(MONTH_NAMES_FULL[0]).toBe("January");
    expect(MONTH_NAMES_SHORT).toHaveLength(12);
    expect(MONTH_NAMES_SHORT[4]).toBe("May");
  });
});
