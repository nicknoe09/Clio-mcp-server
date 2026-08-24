import { describe, it, expect } from "vitest";
import { aggregateRealizationDollars, isUnbilledRealizStatus } from "../src/clio/reportCsv";
import { buildRealizationDollarsSheet, REALIZATION_DOLLARS_TAB, dataCol } from "../src/dashboard/realizationDollars";

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

  it("subtracts an UPWARD Adjusted Amount, keeping identity 1 on a bill above standard", () => {
    // Regression, from the live April row on matter "03357-Young, Joyce M. -
    // Estate of": 2.0 hrs at $450 standard, billed at $1,170. Math.abs treated
    // the +$270 adjustment as a reduction, so the firm's Jan-Jul identity missed
    // by twice the adjustment ($540 of the observed $540.04 gap; the rest is
    // rounding).
    const a = aggregateRealizationDollars([
      row({ "Original Billable Total": "900.00", "Billed Time Amount": "1170.00",
            "Adjusted Amount": "270.00" }),
    ], nameToUid)[NRN];
    expect(a.discounted).toBeCloseTo(-270, 6);
    expect(a.billed + a.discounted + a.unbilled).toBeCloseTo(a.standardValue, 6);
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
  const agg = (o: any = {}) => ({ standardValue: 1000, billed: 600, discounted: 300, credited: 200,
    collected: 350, outstanding: 50, unbilled: 100, ...o });
  const rosterN = [{ initials: "NRN", user_id: NRN, name: "Nicholas Noe" },
                   { initials: "TBS", user_id: 359711375, name: "Tzipora Simmons" }];

  it("leads with a FIRM TOTAL block, then one block per active timekeeper", () => {
    const xml = buildRealizationDollarsSheet(
      { 1: { [NRN]: agg(), 359711375: agg({ standardValue: 500 }) } }, [1], rosterN, "2026-08-21");
    expect(xml.indexOf("FIRM TOTAL")).toBeGreaterThan(-1);
    expect(xml.indexOf("FIRM TOTAL")).toBeLessThan(xml.indexOf("Nicholas Noe"));
    expect(xml).toContain("Nicholas Noe (NRN)");
    expect(xml).toContain("Tzipora Simmons (TBS)");
  });

  it("puts months across with a YTD column", () => {
    const xml = buildRealizationDollarsSheet(
      { 1: { [NRN]: agg() }, 2: { [NRN]: agg() }, 3: { [NRN]: agg() } }, [1, 2, 3], rosterN);
    expect(xml).toContain("Jan"); expect(xml).toContain("Feb"); expect(xml).toContain("Mar");
    expect(xml).toContain("YTD");
    // 3 months -> B,C,D are months and E is YTD
    expect(xml).toMatch(/<f>SUM\(B\d+:D\d+\)<\/f>/);
  });

  it("computes the YTD rate from YTD dollars, not a mean of monthly rates", () => {
    const xml = buildRealizationDollarsSheet(
      { 1: { [NRN]: agg() }, 2: { [NRN]: agg() } }, [1, 2], rosterN);
    // YTD col for 2 months is D; the Net Economic YTD formula must reference D rows
    expect(xml).toMatch(/<f>IF\(D\d+=0,&quot;&quot;,\(D\d+-D\d+\)\/D\d+\)<\/f>/);
  });

  it("carries a key defining every rate and term", () => {
    const xml = buildRealizationDollarsSheet({ 1: { [NRN]: agg() } }, [1], rosterN);
    expect(xml).toContain("HOW TO READ THIS");
    expect(xml).toContain("WHAT THE LINES MEAN");
    for (const t of ["Gross Billing", "Net Economic", "Collection", "Total Value",
                     "Standard Value", "Discounted", "Credited", "Unbilled"]) {
      expect(xml).toContain(t);
    }
    // the credit-note line is the reason the tab exists; keep it stated
    expect(xml).toContain("cannot see these");
  });

  it("emits a per-column Check formula covering BOTH identities", () => {
    const xml = buildRealizationDollarsSheet({ 1: { [NRN]: agg() } }, [1], rosterN);
    expect(xml).toContain("Check (expect 0)");
    expect(xml).toMatch(/<f>\(B\d+-\(B\d+\+B\d+\+B\d+\)\)\+\(\(B\d+-B\d+\)-\(B\d+\+B\d+\)\)<\/f>/);
  });

  it("freezes the label column and sets column widths", () => {
    const xml = buildRealizationDollarsSheet({ 1: { [NRN]: agg() } }, [1], rosterN);
    expect(xml).toContain('state="frozen"');
    expect(xml).toContain('<col min="1" max="1" width="26"');
  });

  it("omits a timekeeper with no activity in any listed month", () => {
    const xml = buildRealizationDollarsSheet({ 1: { [NRN]: agg() } }, [1], rosterN);
    expect(xml).toContain("Nicholas Noe");
    expect(xml).not.toContain("Tzipora Simmons");
  });

  it("returns empty string when nobody is active", () => {
    expect(buildRealizationDollarsSheet({}, [1, 2, 3], rosterN)).toBe("");
  });

  it("names the tab stably (renaming would create a second sheet)", () => {
    expect(REALIZATION_DOLLARS_TAB).toBe("Realization ($)");
  });

  it("produces well-formed sheet XML", () => {
    const xml = buildRealizationDollarsSheet({ 1: { [NRN]: agg() } }, [1], rosterN);
    expect(xml.startsWith("<?xml")).toBe(true);
    expect((xml.match(/<row /g) || []).length).toBe((xml.match(/<\/row>/g) || []).length);
    expect(xml).toContain("</sheetData></worksheet>");
  });
});

describe("dataCol", () => {
  it("maps 0 to the first month column and walks past Z", () => {
    expect(dataCol(0)).toBe("B");
    expect(dataCol(11)).toBe("M");
    expect(dataCol(24)).toBe("Z");
    expect(dataCol(25)).toBe("AA");
  });
});
