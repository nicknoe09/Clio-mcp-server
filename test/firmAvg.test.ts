import { describe, it, expect } from "vitest";
import {
  firmAvgRateByMonth,
  maxRowNumber,
  appendRowsBeforeSheetClose,
  stripRowsFromMarker,
  findTabMonthBlock,
  xmlCell,
  xmlRow,
} from "../src/utils/xlsx";

// Minimal worksheet wrapper.
const sheet = (rows: string[]) => `<worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`;
const str = (ref: string, t: string) => `<c r="${ref}" t="inlineStr"><is><t>${t}</t></is></c>`;
const num = (ref: string, v: number) => `<c r="${ref}"><v>${v}</v></c>`;

// A two-month Utilization-style tab: A=month, B=Employee/initials, C=Billable,
// D=Nonbillable, F=Available. JBP is an inactive (zero) row that must be excluded.
const utilXml = sheet([
  `<row r="1">${str("A1", "Utilization")}</row>`,
  `<row r="2">${str("A2", "JAN")}${str("B2", "Employee")}${str("C2", "Billable")}${str("D2", "Nonbillable")}${str("F2", "Available Hours")}</row>`,
  `<row r="3">${str("B3", "PAR")}${num("C3", 90)}${num("D3", 10)}${num("F3", 150)}</row>`,
  `<row r="4">${str("B4", "KES")}${num("C4", 75)}${num("D4", 25)}${num("F4", 150)}</row>`,
  `<row r="5">${str("B5", "JBP")}${num("C5", 0)}${num("D5", 0)}${num("F5", 150)}</row>`,
  `<row r="6">${str("A6", "FEB")}${str("B6", "Employee")}</row>`,
  `<row r="7">${str("B7", "PAR")}${num("C7", 120)}${num("D7", 0)}${num("F7", 150)}</row>`,
]);
const utilRate = (v: Record<string, number>) => (v.C + v.D > 0 && v.F > 0 ? v.C / v.F : null);

// A Realization-style tab with a per-month "Total" terminator row; rate =
// nondiscounted / (nondiscounted + discounted). JPB row is a #DIV/0! (exclude).
const realizXml = sheet([
  `<row r="1">${str("A1", "Realization")}</row>`,
  `<row r="2">${str("A2", "JAN")}${str("B2", "Employee")}</row>`,
  `<row r="3">${str("B3", "PAR")}${num("D3", 80)}${num("E3", 20)}</row>`,
  `<row r="4">${str("B4", "KES")}${num("D4", 45)}${num("E4", 5)}</row>`,
  `<row r="5">${str("B5", "JPB")}${num("D5", 0)}${num("E5", 0)}</row>`,
  `<row r="6">${str("B6", "Total")}${num("D6", 125)}${num("E6", 25)}</row>`,
]);
const realizRate = (v: Record<string, number>) => (v.D + v.E > 0 ? v.D / (v.D + v.E) : null);

describe("firmAvgRateByMonth", () => {
  it("averages utilization rate over active billers, excluding zero rows", () => {
    const out = firmAvgRateByMonth(utilXml, [], ["C", "D", "F"], utilRate);
    expect(out).toEqual([
      { monthAbbr: "JAN", avgRate: (90 / 150 + 75 / 150) / 2, billers: 2 }, // 0.55
      { monthAbbr: "FEB", avgRate: 120 / 150, billers: 1 }, // 0.8
    ]);
  });

  it("averages realization rate and treats the Total row as a terminator", () => {
    const out = firmAvgRateByMonth(realizXml, [], ["D", "E"], realizRate);
    expect(out).toEqual([
      { monthAbbr: "JAN", avgRate: (80 / 100 + 45 / 50) / 2, billers: 2 }, // 0.85
    ]);
  });

  it("returns no rows when every biller is excluded", () => {
    const allZero = sheet([
      `<row r="2">${str("A2", "JAN")}${str("B2", "Employee")}</row>`,
      `<row r="3">${str("B3", "JBP")}${num("C3", 0)}${num("D3", 0)}${num("F3", 150)}</row>`,
    ]);
    expect(firmAvgRateByMonth(allZero, [], ["C", "D", "F"], utilRate)).toEqual([]);
  });
});

describe("maxRowNumber", () => {
  it("finds the highest row number", () => {
    expect(maxRowNumber(utilXml)).toBe(7);
    expect(maxRowNumber("<worksheet><sheetData></sheetData></worksheet>")).toBe(0);
  });
});

describe("appendRowsBeforeSheetClose / stripRowsFromMarker round-trip", () => {
  const MARKER = "Firm Average (auto-generated";
  const summaryRows = [
    xmlRow(100, [xmlCell("A100", `${MARKER} — do not edit)`, { style: "__BOLD__" })]),
    xmlRow(101, [xmlCell("B101", "Month", { style: "__BOLD__" }), xmlCell("C101", "Rate", { style: "__BOLD__" })]),
    xmlRow(102, [xmlCell("B102", "January", { style: "__BOLD__" }), xmlCell("C102", 0.55, { style: "__PCT__" })]),
  ];

  it("appends rows and strips them back out idempotently", () => {
    const withSummary = appendRowsBeforeSheetClose(utilXml, summaryRows);
    expect(withSummary).toContain(MARKER);
    expect(maxRowNumber(withSummary)).toBe(102);

    const stripped = stripRowsFromMarker(withSummary, MARKER, []);
    expect(stripped).not.toContain(MARKER);
    expect(stripped).toBe(utilXml); // back to exactly the original
  });

  it("strip is a no-op when the marker is absent", () => {
    expect(stripRowsFromMarker(utilXml, MARKER, [])).toBe(utilXml);
  });

  it("finds the marker even when stored as a shared string", () => {
    // Simulate Excel having moved the title text into the shared-string table.
    const ssRows = [
      `<row r="100"><c r="A100" t="s"><v>7</v></c></row>`,
      `<row r="101"><c r="B101"><v>0</v></c></row>`,
    ];
    const withSS = appendRowsBeforeSheetClose(utilXml, ssRows);
    const sharedStrings = ["a", "b", "c", "d", "e", "f", "g", `${MARKER} — do not edit)`];
    const stripped = stripRowsFromMarker(withSS, MARKER, sharedStrings);
    expect(stripped).toBe(utilXml);
  });
});

describe("appended summary does not corrupt the block scanner", () => {
  const MARKER = "Firm Average (auto-generated";
  // Title row uses col A only (col B absent) so it terminates the prior block;
  // data rows put month NAMES in col B (col A absent) so they are never seen as
  // new month headers.
  const summaryRows = [
    xmlRow(100, [xmlCell("A100", `${MARKER} — do not edit)`, { style: "__BOLD__" })]),
    xmlRow(101, [xmlCell("B101", "Month", { style: "__BOLD__" }), xmlCell("C101", "Firm Avg", { style: "__BOLD__" })]),
    xmlRow(102, [xmlCell("B102", "January", { style: "__BOLD__" }), xmlCell("C102", 0.55, { style: "__PCT__" })]),
    xmlRow(103, [xmlCell("B103", "February", { style: "__BOLD__" }), xmlCell("C103", 0.8, { style: "__PCT__" })]),
  ];
  const withSummary = appendRowsBeforeSheetClose(utilXml, summaryRows);

  it("still finds the JAN block with its 3 attorney rows", () => {
    const blk = findTabMonthBlock(withSummary, "JAN", [], ["C", "D"]);
    expect(blk?.attorneys.map((a) => a.ini)).toEqual(["PAR", "KES", "JBP"]);
  });

  it("does not let the FEB block absorb the summary rows", () => {
    const blk = findTabMonthBlock(withSummary, "FEB", [], ["C", "D"]);
    expect(blk?.attorneys.map((a) => a.ini)).toEqual(["PAR"]);
  });
});
