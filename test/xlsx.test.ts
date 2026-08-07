import { describe, it, expect } from "vitest";
import { colToNum, patchCell, readCell, translateFormulaRefs, expandSharedFormulas } from "../src/utils/xlsx";

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

  it("INSERTS an absent cell at the end of its row (found live: KES's V cells didn't exist, so his originating collections were silently dropped)", () => {
    // Row ends at T (col 20); patching V (col 22) must create the cell, not no-op.
    const xml = `<row r="6"><c r="N6" s="173"><v>1</v></c><c r="T6" s="172"><v>2</v></c></row>`;
    const out = patchCell(xml, "V6", 105220.58);
    expect(out).toBe(`<row r="6"><c r="N6" s="173"><v>1</v></c><c r="T6" s="172"><v>2</v></c><c r="V6"><v>105220.58</v></c></row>`);
  });

  it("inserts an absent cell in COLUMN ORDER between existing cells", () => {
    const xml = `<row r="6"><c r="N6"><v>1</v></c><c r="V6"><v>3</v></c></row>`;
    const out = patchCell(xml, "S6", 2);
    expect(out).toBe(`<row r="6"><c r="N6"><v>1</v></c><c r="S6"><v>2</v></c><c r="V6"><v>3</v></c></row>`);
  });

  it("borrows the style of the nearest same-column cell when inserting", () => {
    const xml =
      `<row r="5"><c r="S5" s="176"><v>9</v></c></row>` +
      `<row r="6"><c r="N6" s="173"><v>1</v></c></row>`;
    const out = patchCell(xml, "S6", 42);
    expect(out).toContain(`<c r="S6" s="176"><v>42</v></c>`);
  });

  it("gives a self-closing empty row a body holding the inserted cell", () => {
    const xml = `<row r="7" spans="1:23"/>`;
    expect(patchCell(xml, "S7", 5)).toBe(`<row r="7" spans="1:23"><c r="S7"><v>5</v></c></row>`);
  });

  it("leaves the XML unchanged when the whole ROW is absent (block creation owns new rows)", () => {
    const xml = `<row r="5"><c r="C5"><v>1</v></c></row>`;
    expect(patchCell(xml, "Z9", 9)).toBe(xml);
  });

  it("does not misread row r=\"6\" when patching into row 60", () => {
    const xml = `<row r="6"><c r="S6"><v>1</v></c></row><row r="60"><c r="N60"><v>7</v></c></row>`;
    const out = patchCell(xml, "S60", 8);
    expect(out).toContain(`<c r="S6"><v>1</v></c>`);       // row 6 untouched
    expect(out).toContain(`<c r="N60"><v>7</v></c><c r="S60"`); // inserted into row 60
  });

  it("keeps follower formulas alive when patching a shared-formula MASTER", () => {
    // E5 masters shared group si=2 covering E5:E7. Writing a value into E5 used
    // to strip the master's <f> and orphan E6/E7 (Excel: "Removed Records:
    // Shared formula"). Followers must come out as self-contained formulas.
    const xml =
      `<row r="5"><c r="E5"><f t="shared" ref="E5:E7" si="2">C5+D5</f><v>10</v></c></row>` +
      `<row r="6"><c r="E6"><f t="shared" si="2"/><v>11</v></c></row>` +
      `<row r="7"><c r="E7"><f t="shared" si="2"/><v>12</v></c></row>`;
    const out = patchCell(xml, "E5", 99);
    expect(out).not.toContain('t="shared"');
    expect(out).toContain(`<c r="E5"><v>99</v></c>`);
    expect(out).toContain(`<c r="E6"><f>C6+D6</f><v>11</v></c>`);
    expect(out).toContain(`<c r="E7"><f>C7+D7</f><v>12</v></c>`);
  });
});

describe("translateFormulaRefs", () => {
  it("shifts relative refs and honors $ anchors", () => {
    expect(translateFormulaRefs("C5+D5", 1, 0)).toBe("C6+D6");
    expect(translateFormulaRefs("SUM(A1:B2)", 2, 1)).toBe("SUM(B3:C4)");
    expect(translateFormulaRefs("$A5+A$5+$A$5", 1, 1)).toBe("$A6+B$5+$A$5");
  });

  it("leaves string literals, quoted sheet names, and function names alone", () => {
    expect(translateFormulaRefs(`IF(A1="A1","A1",LOG10(A1))`, 1, 0)).toBe(`IF(A2="A1","A1",LOG10(A2))`);
    expect(translateFormulaRefs(`'Rate Sheet'!B2+Util!C3`, 1, 1)).toBe(`'Rate Sheet'!C3+Util!D4`);
  });

  it("turns off-sheet shifts into #REF!", () => {
    expect(translateFormulaRefs("A1", -1, 0)).toBe("#REF!");
  });
});

describe("expandSharedFormulas", () => {
  const sheet =
    `<row r="5"><c r="E5"><f t="shared" ref="E5:E7" si="0">$B$1*C5</f><v>10</v></c></row>` +
    `<row r="6"><c r="E6" s="3"><f t="shared" si="0"/><v>11</v></c></row>` +
    `<row r="7"><c r="E7"><f t="shared" si="0"/><v>12</v></c></row>`;

  it("materializes followers with shifted refs and unshares the master", () => {
    const out = expandSharedFormulas(sheet);
    expect(out).not.toContain('t="shared"');
    expect(out).toContain(`<c r="E5"><f>$B$1*C5</f><v>10</v></c>`);
    expect(out).toContain(`<c r="E6" s="3"><f>$B$1*C6</f><v>11</v></c>`);
    expect(out).toContain(`<c r="E7"><f>$B$1*C7</f><v>12</v></c>`);
  });

  it("drops orphaned followers (master already stripped) but keeps their cached values", () => {
    const orphaned =
      `<row r="5"><c r="E5"><v>99</v></c></row>` +
      `<row r="6"><c r="E6"><f t="shared" si="0"/><v>11</v></c></row>`;
    const out = expandSharedFormulas(orphaned);
    expect(out).not.toContain("<f");
    expect(out).toContain(`<c r="E6"><v>11</v></c>`);
  });

  it("orphansOnly heals orphans without rewriting intact groups", () => {
    const mixed = sheet + `<row r="9"><c r="F9"><f t="shared" si="8"/><v>7</v></c></row>`;
    const out = expandSharedFormulas(mixed, { orphansOnly: true });
    expect(out).toContain(`<f t="shared" ref="E5:E7" si="0">$B$1*C5</f>`); // intact group untouched
    expect(out).toContain(`<f t="shared" si="0"/>`);
    expect(out).toContain(`<c r="F9"><v>7</v></c>`); // orphan healed
  });

  it("does not fuse a self-closing cell with the next cell's formula", () => {
    const xml = `<row r="5"><c r="D5" s="1"/><c r="E5"><f t="shared" ref="E5:E5" si="0">C5</f><v>1</v></c></row>`;
    const out = expandSharedFormulas(xml);
    expect(out).toContain(`<c r="D5" s="1"/>`);
    expect(out).toContain(`<c r="E5"><f>C5</f><v>1</v></c>`);
  });

  it("keeps plain (non-shared) formulas untouched", () => {
    const xml = `<row r="5"><c r="E5"><f>C5+D5</f><v>1</v></c><c r="F5"><f t="shared" si="0">A5</f><v>2</v></c></row>`;
    const out = expandSharedFormulas(xml);
    expect(out).toContain(`<c r="E5"><f>C5+D5</f><v>1</v></c>`);
    expect(out).toContain(`<c r="F5"><f>A5</f><v>2</v></c>`);
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
