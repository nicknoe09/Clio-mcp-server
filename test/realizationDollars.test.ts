import { describe, it, expect } from "vitest";
import { aggregateRealizationDollars, isUnbilledRealizStatus } from "../src/clio/reportCsv";
import { buildRealizationDollarsSheet, REALIZATION_DOLLARS_TAB } from "../src/dashboard/realizationDollars";

const roster = [
  { initials: "NRN", name: "Nicholas Noe", user_id: 348755029 },
  { initials: "TBS", name: "Tzipora Simmons", user_id: 359711375 },
];
const nameToUid = new Map<string, number>(roster.map((r) => [r.name.toLowerCase(), r.user_id]));
const NRN = 348755029;

// Column names and value shapes below mirror a live Clio Realization report.
const row = (o: Record<string, string>) => ({
  User: "Nicholas Noe", "Time Entry Type": "Hourly", "Invoice Status": "Billed",
  Quantity: "0", "Original Billable Total": "0", "Billed Time Amount": "0",
  "Amount Discounted": "0", "Adjusted Amount": "0", "Billed Time Credited": "0",
  "Billed Time Collected": "0", "Billed Time Outstanding": "0", ...o,
});

describe("isUnbilledRealizStatus — live Clio status values", () => {
  it("recognises the literal 'Unbilled' status", () => {
    // Regression: this was missing, so those rows only reached col F through the
    // caller's anomaly fallback, logging a spurious warning every run.
    expect(isUnbilledRealizStatus("Unbilled")).toBe(true);
  });
  it("covers the other not-yet-billed forms", () => {
    for (const st of ["", "-", " - ", "Draft", "draft bill", undefined]) {
      expect(isUnbilledRealizStatus(st)).toBe(true);
    }
  });
  it("leaves affirmatively-billed statuses on the billed branch", () => {
    for (const st of ["Billed", "Paid", "Awaiting Payment"]) {
      expect(isUnbilledRealizStatus(st)).toBe(false);
    }
  });
});

describe("aggregateRealizationDollars", () => {
  it("holds identity 1: standardValue == billed + discounted + unbilled", () => {
    const a = aggregateRealizationDollars([
      row({ "Original Billable Total": "1000", "Billed Time Amount": "1000" }),
      row({ "Original Billable Total": "500", "Billed Time Amount": "200", "Amount Discounted": "-300" }),
      row({ "Invoice Status": "Unbilled", "Original Billable Total": "250" }),
    ], nameToUid)[NRN];
    expect(a.standardValue).toBeCloseTo(1750, 6);
    expect(a.billed + a.discounted + a.unbilled).toBeCloseTo(a.standardValue, 6);
    expect(a.unbilled).toBeCloseTo(250, 6);
  });

  it("holds identity 2: billed - credited == collected + outstanding", () => {
    const a = aggregateRealizationDollars([
      row({ "Original Billable Total": "1000", "Billed Time Amount": "1000",
            "Billed Time Credited": "400", "Billed Time Collected": "500", "Billed Time Outstanding": "100" }),
    ], nameToUid)[NRN];
    expect(a.billed - a.credited).toBeCloseTo(a.collected + a.outstanding, 6);
  });

  it("folds Adjusted Amount into discounted, matching the hours side", () => {
    const a = aggregateRealizationDollars([
      row({ "Original Billable Total": "110", "Billed Time Amount": "78", "Adjusted Amount": "-32" }),
    ], nameToUid)[NRN];
    expect(a.discounted).toBeCloseTo(32, 6);
    expect(a.billed + a.discounted).toBeCloseTo(a.standardValue, 6);
  });

  it("keeps credits OUT of discounted — they are a distinct channel", () => {
    // A credit note leaves the invoice at full value; only 'credited' moves.
    const a = aggregateRealizationDollars([
      row({ "Original Billable Total": "108946.14", "Billed Time Amount": "108946.14",
            "Billed Time Credited": "108946.14" }),
    ], nameToUid)[NRN];
    expect(a.discounted).toBeCloseTo(0, 6);
    expect(a.credited).toBeCloseTo(108946.14, 6);
    expect(a.billed - a.credited).toBeCloseTo(0, 6);
  });

  it("excludes nonbillable time and non-roster users", () => {
    const a = aggregateRealizationDollars([
      row({ "Time Entry Type": "Non-billable", "Invoice Status": "-", "Original Billable Total": "9999" }),
      { ...row({ "Original Billable Total": "500" }), User: "Stranger, Sam" },
      row({ "Original Billable Total": "100", "Billed Time Amount": "100" }),
    ], nameToUid);
    expect(Object.keys(a)).toEqual([String(NRN)]);
    expect(a[NRN].standardValue).toBeCloseTo(100, 6);
  });
});

describe("buildRealizationDollarsSheet", () => {
  const agg = (o: Partial<Record<string, number>> = {}) => ({
    standardValue: 1000, billed: 600, discounted: 300, credited: 200,
    collected: 350, outstanding: 50, unbilled: 100, ...o,
  } as any);

  it("emits a month block, a Total row of SUMs, and a self-check row", () => {
    const xml = buildRealizationDollarsSheet({ 1: { [NRN]: agg() } }, [1], roster, "2026-08-21");
    expect(xml).toContain("JANUARY");
    expect(xml).toContain("NRN");
    expect(xml).toContain("Total");
    expect(xml).toContain("Check");
    expect(xml).toContain("data as of 2026-08-21".replace("data", "Data"));
    // rates are live formulas, not baked numbers
    expect(xml).toMatch(/<f>IF\(C\d+=0,&quot;&quot;,D\d+\/C\d+\)<\/f>/);
    // Total row sums the single data row
    expect(xml).toMatch(/<f>SUM\(C\d+:C\d+\)<\/f>/);
  });

  it("skips timekeepers with no activity and months with nobody active", () => {
    const xml = buildRealizationDollarsSheet(
      { 1: { [NRN]: agg() }, 2: {} }, [1, 2], roster, undefined);
    expect(xml).toContain("JANUARY");
    expect(xml).not.toContain("FEBRUARY");
    expect(xml).not.toContain("TBS");   // no data for TBS in January
  });

  it("returns empty string when there is nothing to report", () => {
    expect(buildRealizationDollarsSheet({}, [1, 2, 3], roster)).toBe("");
  });

  it("names the tab stably (renaming would create a second sheet)", () => {
    expect(REALIZATION_DOLLARS_TAB).toBe("Realization ($)");
  });

  it("produces well-formed sheet XML with balanced tags", () => {
    const xml = buildRealizationDollarsSheet({ 1: { [NRN]: agg() } }, [1], roster);
    expect(xml.startsWith("<?xml")).toBe(true);
    expect((xml.match(/<row /g) || []).length).toBe((xml.match(/<\/row>/g) || []).length);
    expect((xml.match(/<c /g) || []).length).toBe(
      (xml.match(/<\/c>/g) || []).length + (xml.match(/<c [^>]*\/>/g) || []).length);
    expect(xml).toContain("</sheetData></worksheet>");
    // no unsubstituted style placeholder should ever reach a real workbook, but
    // the builder emits them by design for the caller to swap
    expect(xml).toContain("__CUR__");
  });
});
