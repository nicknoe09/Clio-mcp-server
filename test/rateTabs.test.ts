import { describe, it, expect } from "vitest";
import { patchUtilizationBlock, buildFirmAvgRows, type UtilHours } from "../src/dashboard/rateTabs";

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
