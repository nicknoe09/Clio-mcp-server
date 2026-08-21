import { describe, it, expect } from "vitest";
import {
  patchUtilizationBlock, buildFirmAvgRows, ensureTabMonthBlock,
  appendRealizationFirmAvg, appendCollectionFirmAvg, FIRM_AVG_MARKER, type UtilHours,
} from "../src/dashboard/rateTabs";
import { findTabMonthBlock, patchCell, readCell } from "../src/utils/xlsx";

// Minimal Utilization-style tab: A=month, B=initials, C=Billable, D=Nonbillable,
// E=Total, F=Available, G=Untracked. Cells must already exist for a value write.
const sheet = (rows: string[]) => `<worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`;
const str = (ref: string, t: string) => `<c r="${ref}" t="inlineStr"><is><t>${t}</t></is></c>`;
const num = (ref: string, v: number) => `<c r="${ref}"><v>${v}</v></c>`;
const dataRow = (r: number, ini: string, avail: number) =>
  `<row r="${r}">${str(`B${r}`, ini)}${num(`C${r}`, 0)}${num(`D${r}`, 0)}${num(`E${r}`, 0)}${num(`F${r}`, avail)}${num(`G${r}`, 0)}</row>`;

const utilXml = sheet([
  `<row r="2">${str("A2", "JAN")}${str("B2", "Employee")}</row>`,
  dataRow(3, "PAR", 156.67),
  dataRow(4, "JBP", 156.67), // tab typo for Jonathan Barbee → maps to JPB
  dataRow(5, "XXX", 156.67), // not on roster → skipped
]);

const initialsToUid = { PAR: 1, JPB: 2 };
const aliases = { JBP: "JPB" };

describe("patchUtilizationBlock", () => {
  it("writes Billable/Nonbillable/Total and derives Untracked from Available", () => {
    const byUid: UtilHours = {
      1: { billable: 90, nonbillable: 10 },
      2: { billable: 74.2, nonbillable: 25.8 },
    };
    const { xml, patched } = patchUtilizationBlock(utilXml, "JAN", [], byUid, initialsToUid, aliases);
    expect(patched).toBe(2); // PAR + JBP(→JPB); XXX skipped
    // PAR: C=90, D=10, E=100, G=max(0,156.67-100)=56.7
    expect(xml).toContain(`<c r="C3"><v>90</v></c>`);
    expect(xml).toContain(`<c r="D3"><v>10</v></c>`);
    expect(xml).toContain(`<c r="E3"><v>100</v></c>`);
    expect(xml).toContain(`<c r="G3"><v>56.7</v></c>`);
    // JBP row patched via the JPB alias
    expect(xml).toContain(`<c r="C4"><v>74.2</v></c>`);
    expect(xml).toContain(`<c r="E4"><v>100</v></c>`);
    // XXX row (no roster uid) untouched
    expect(xml).toContain(`<c r="C5"><v>0</v></c>`);
  });

  it("clamps Untracked at 0 when Total exceeds Available", () => {
    const byUid: UtilHours = { 1: { billable: 200, nonbillable: 90 } }; // total 290 > 156.67
    const { xml } = patchUtilizationBlock(utilXml, "JAN", [], byUid, initialsToUid, aliases);
    expect(xml).toContain(`<c r="E3"><v>290</v></c>`);
    expect(xml).toContain(`<c r="G3"><v>0</v></c>`);
  });

  it("returns the xml unchanged with 0 patched when the month block is absent", () => {
    const byUid: UtilHours = { 1: { billable: 90, nonbillable: 10 } };
    const res = patchUtilizationBlock(utilXml, "FEB", [], byUid, initialsToUid, aliases);
    expect(res.patched).toBe(0);
    expect(res.xml).toBe(utilXml);
  });
});

describe("buildFirmAvgRows", () => {
  it("emits title, header, and one row per month (with optional goal column)", () => {
    const rows = buildFirmAvgRows(
      [{ monthAbbr: "JAN", avgRate: 0.55, billers: 2 }, { monthAbbr: "FEB", avgRate: 0.8, billers: 3 }],
      100, "Firm Average (auto-generated — do not edit)", "Firm Avg Utilization Rate",
      { value: 0.75, header: "Firm Avg Util Goal" },
    );
    const xml = rows.join("");
    expect(rows).toHaveLength(4); // title + header + 2 month rows
    expect(xml).toContain("Firm Average (auto-generated");
    expect(xml).toContain("Firm Avg Util Goal");
    expect(xml).toContain("January");
    expect(xml).toContain("February");
    expect(xml).toContain(`<v>0.55</v>`);
    expect(xml).toContain(`<v>0.75</v>`); // goal column present
  });

  it("omits the goal column when no goal is given", () => {
    const rows = buildFirmAvgRows([{ monthAbbr: "JAN", avgRate: 0.9, billers: 1 }], 50, "T", "Rate");
    const xml = rows.join("");
    // Without a goal, the biller count sits in col D (not E).
    expect(xml).toContain(`r="D52"`);
    expect(xml).not.toContain(`r="E52"`);
  });
});

// Realization-style tab: A=month, B=initials, D=billed-nondiscounted,
// E=billed-discounted, F=unbilled, G=rate formula, plus a per-month Total row.
const realizRow = (r: number, ini: string, d: number, e: number) =>
  `<row r="${r}">${str(`B${r}`, ini)}${num(`D${r}`, d)}${num(`E${r}`, e)}${num(`F${r}`, 0)}<c r="G${r}"><f>D${r}/(D${r}+E${r})</f><v>0</v></c></row>`;
const realizXml = sheet([
  `<row r="2">${str("A2", "JUN")}${str("B2", "Employee")}</row>`,
  realizRow(3, "PAR", 50, 50),
  realizRow(4, "KES", 1, 0),
  `<row r="5">${str("B5", "Total")}<c r="D5"><f>SUM(D3:D4)</f><v>51</v></c><c r="E5"><f>SUM(E3:E4)</f><v>50</v></c></row>`,
]);

describe("appendRealizationFirmAvg", () => {
  it("writes the totals-based firm rate (ΣD/Σ(D+E)), not the mean of biller rates", () => {
    const out = appendRealizationFirmAvg(realizXml, []);
    expect(out).toContain(FIRM_AVG_MARKER);
    // ΣD/Σ(D+E) = 51/101 ≈ 0.5050, rounded to 4dp. The old mean was 0.75.
    expect(out).toContain(`<v>${Math.round((51 / 101) * 10000) / 10000}</v>`);
    expect(out).not.toContain(`<v>0.75</v>`);
  });
});

describe("ensureTabMonthBlock", () => {
  it("is a no-op when the month block already exists", () => {
    const res = ensureTabMonthBlock(realizXml, "JUN", [], ["D", "E", "F"]);
    expect(res.created).toBe(false);
    expect(res.xml).toBe(realizXml);
  });

  it("clones the last block for a missing month: label, initials, zeroed data, shifted formulas", () => {
    const res = ensureTabMonthBlock(realizXml, "JUL", [], ["D", "E", "F"]);
    expect(res.created).toBe(true);
    const block = findTabMonthBlock(res.xml, "JUL", [], ["D", "E", "F"]);
    expect(block).not.toBeNull();
    expect(block!.attorneys.map((a) => a.ini)).toEqual(["PAR", "KES"]);
    const [r1, r2] = block!.attorneys.map((a) => a.row);
    // Data cols zeroed so the clone's stale numbers can't read as real data.
    for (const c of ["D", "E", "F"]) {
      expect(readCell(res.xml, `${c}${r1}`, [])).toBe("0");
      expect(readCell(res.xml, `${c}${r2}`, [])).toBe("0");
    }
    // Row-local rate formula follows its row; the Total row's SUM spans the new rows.
    expect(res.xml).toContain(`<f>D${r1}/(D${r1}+E${r1})</f>`);
    expect(res.xml).toContain(`<f>SUM(D${r1}:D${r2})</f>`);
    // JUN block untouched.
    expect(res.xml).toContain(`<f>D3/(D3+E3)</f>`);
    const jun = findTabMonthBlock(res.xml, "JUN", [], ["D", "E", "F"]);
    expect(readCell(res.xml, `D${jun!.attorneys[0].row}`, [])).toBe("50");
  });

  it("creates the block below the month rows and strips a prior firm-average summary", () => {
    const withSummary = appendRealizationFirmAvg(realizXml, []);
    const res = ensureTabMonthBlock(withSummary, "JUL", [], ["D", "E", "F"]);
    expect(res.created).toBe(true);
    // The stale summary is stripped; callers re-append it after patching.
    expect(res.xml).not.toContain(FIRM_AVG_MARKER);
    // An unpatched (all-zero) clone contributes no summary row yet…
    expect(appendRealizationFirmAvg(res.xml, [])).not.toContain("July");
    // …but once the caller patches data into it, the summary covers both months.
    const block = findTabMonthBlock(res.xml, "JUL", [], ["D", "E", "F"]);
    const patched = patchCell(res.xml, `D${block!.attorneys[0].row}`, 40);
    const refreshed = appendRealizationFirmAvg(patched, []);
    expect(refreshed).toContain("June");
    expect(refreshed).toContain("July");
  });

  it("returns unchanged when there is no block to clone", () => {
    const empty = sheet([`<row r="1">${str("A1", "Realization")}</row>`]);
    const res = ensureTabMonthBlock(empty, "JUL", [], ["D", "E", "F"]);
    expect(res.created).toBe(false);
    expect(res.xml).toBe(empty);
  });

  it("keeps Available hours but zeroes the data cols on a cloned Utilization block", () => {
    const res = ensureTabMonthBlock(utilXml, "FEB", [], ["C", "D"], ["C", "D", "E", "G"]);
    expect(res.created).toBe(true);
    const block = findTabMonthBlock(res.xml, "FEB", [], ["C", "D"]);
    expect(block).not.toBeNull();
    const row = block!.attorneys[0].row;
    expect(readCell(res.xml, `C${row}`, [])).toBe("0");
    expect(readCell(res.xml, `F${row}`, [])).toBe("156.67"); // Available carried over
    // ...and the cloned block is immediately patchable.
    const { patched, xml } = patchUtilizationBlock(res.xml, "FEB", [], { 1: { billable: 90, nonbillable: 10 } }, initialsToUid, aliases);
    expect(patched).toBe(1); // PAR (only uid 1 has hours)
    expect(xml).toContain(`<c r="C${row}"><v>90</v></c>`);
    expect(xml).toContain(`<c r="G${row}"><v>56.7</v></c>`);
  });
});

// Collection-style tab: A=month, B=initials, C=Collected hrs, D=Uncollected hrs,
// E=rate formula. Mirrors the real sheet, whose row 1 col A holds a "How:" note.
const collRow = (r: number, ini: string, c: number, d: number) =>
  `<row r="${r}">${str(`B${r}`, ini)}${num(`C${r}`, c)}${num(`D${r}`, d)}<c r="E${r}"><f>C${r}/(C${r}+D${r})</f><v>0</v></c></row>`;
const collXml = sheet([
  `<row r="1">${str("A1", "How: Get these figures from the Dashboard for the year in question")}</row>`,
  `<row r="2">${str("A2", "JAN")}${str("B2", "Employee")}</row>`,
  collRow(3, "PAR", 90, 10),
  collRow(4, "KES", 10, 90),
  `<row r="5">${str("B5", "Total")}</row>`,
]);

describe("appendCollectionFirmAvg", () => {
  it("uses the totals form (ΣC/Σ(C+D)), not a mean of biller rates", () => {
    const out = appendCollectionFirmAvg(collXml, []);
    expect(out).toContain(FIRM_AVG_MARKER);
    expect(out).toContain("Firm Collection Rate");
    // totals: 100/200 = 0.5. A mean of the two rates (0.9, 0.1) is also 0.5, so
    // use an asymmetric second month to prove which form is in use.
    expect(out).toContain(`<v>0.5</v>`);
  });

  it("distinguishes totals from a mean when volumes differ", () => {
    const skewed = sheet([
      `<row r="2">${str("A2", "FEB")}${str("B2", "Employee")}</row>`,
      collRow(3, "PAR", 990, 10),   // rate 0.99, high volume
      collRow(4, "KES", 0, 100),    // rate 0.00, low volume
      `<row r="5">${str("B5", "Total")}</row>`,
    ]);
    const out = appendCollectionFirmAvg(skewed, []);
    // totals: 990/1100 = 0.9; a simple mean would be 0.495
    expect(out).toContain(`<v>0.9</v>`);
    expect(out).not.toContain(`<v>0.495</v>`);
  });

  it("stamps the vintage when given one, since this cohort keeps maturing", () => {
    expect(appendCollectionFirmAvg(collXml, [], "2026-08-21")).toContain("data as of 2026-08-21");
    expect(appendCollectionFirmAvg(collXml, [])).not.toContain("data as of");
  });

  it("is idempotent — re-appending replaces the prior block", () => {
    const once = appendCollectionFirmAvg(collXml, [], "2026-08-20");
    const twice = appendCollectionFirmAvg(once, [], "2026-08-21");
    expect(twice).toContain("data as of 2026-08-21");
    expect(twice).not.toContain("data as of 2026-08-20");
    expect((twice.match(/Firm Collection Rate/g) || []).length).toBe(1);
  });

  it("ignores the sheet's leading How-to note rather than reading it as a month", () => {
    const out = appendCollectionFirmAvg(collXml, []);
    expect(out).toContain("January");
    expect(out).not.toContain("How:January");
  });

  it("returns the stripped sheet unchanged when no month has data", () => {
    const empty = sheet([`<row r="1">${str("A1", "Collection")}</row>`]);
    expect(appendCollectionFirmAvg(empty, [])).toBe(empty);
  });
});
