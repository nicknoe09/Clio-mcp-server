import { describe, it, expect } from "vitest";
import { colToNum, patchCell, readCell } from "../src/utils/xlsx";

describe("colToNum", () => {
  it("maps Excel column letters to 1-based numbers", () => {
    expect(colToNum("A")).toBe(1);
    expect(colToNum("Z")).toBe(26);
    expect(colToNum("AA")).toBe(27);
    expect(colToNum("N")).toBe(14);
    expect(colToNum("S")).toBe(19);
  });
});

describe("patchCell", () => {
  it("replaces the value in a plain numeric cell", () => {
    const xml = `<row r="5"><c r="C5" s="7"><v>92.2</v></c></row>`;
    expect(patchCell(xml, "C5", 252.8)).toBe(`<row r="5"><c r="C5" s="7"><v>252.8</v></c></row>`);
  });

  it("fills a self-closing empty cell, preserving its style", () => {
    const xml = `<row r="5"><c r="D5" s="62"/></row>`;
    expect(patchCell(xml, "D5", 70.6)).toBe(`<row r="5"><c r="D5" s="62"><v>70.6</v></c></row>`);
  });

  it("drops a t=\"s\" string flag so the number is not read as a shared-string index", () => {
    const xml = `<row r="5"><c r="C5" s="7" t="s"><v>3</v></c></row>`;
    expect(patchCell(xml, "C5", 100)).toBe(`<row r="5"><c r="C5" s="7"><v>100</v></c></row>`);
  });

  it("strips a stale formula so a recalc can't override the written value", () => {
    // A 'Total' cell that used to be a formula; writing a value must remove <f>.
    const xml = `<row r="5"><c r="E5" s="7"><f>C5+D5</f><v>282</v></c></row>`;
    const out = patchCell(xml, "E5", 323.4);
    expect(out).not.toContain("<f>");
    expect(out).toBe(`<row r="5"><c r="E5" s="7"><v>323.4</v></c></row>`);
  });

  it("strips a self-closing shared formula reference too", () => {
    const xml = `<row r="5"><c r="E5" s="7"><f t="shared" si="2"/><v>282</v></c></row>`;
    const out = patchCell(xml, "E5", 323.4);
    expect(out).not.toContain("<f");
    expect(out).toContain("<v>323.4</v>");
  });

  it("leaves the XML unchanged when the cell is absent", () => {
    const xml = `<row r="5"><c r="C5"><v>1</v></c></row>`;
    expect(patchCell(xml, "Z5", 9)).toBe(xml);
  });
});

describe("readCell", () => {
  const ss = ["", "Employee", "PAR"];
  it("reads an inline numeric value", () => {
    expect(readCell(`<c r="F5"><v>156.67</v></c>`, "F5", ss)).toBe("156.67");
  });
  it("reads the cached value of a formula cell", () => {
    expect(readCell(`<c r="F5"><f>A5*12</f><v>156.67</v></c>`, "F5", ss)).toBe("156.67");
  });
  it("resolves a shared-string cell through the table", () => {
    expect(readCell(`<c r="B5" t="s"><v>2</v></c>`, "B5", ss)).toBe("PAR");
  });
  it("returns empty string for an absent cell", () => {
    expect(readCell(`<c r="B5"><v>0</v></c>`, "Z9", ss)).toBe("");
  });
});
