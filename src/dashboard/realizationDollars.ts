// ============================================================
// "Realization ($)" tab — economic realization, in dollars.
//
// WHY A SEPARATE TAB. The existing Realization tab implements the firm's accepted
// definition: (billed hours - discounted hours) / billable hours worked. That is a
// faithful BILLING-WORKFLOW measure — it answers how much recorded time moved
// through billing without being coded as discounted. It cannot answer how much
// money the firm kept, and no repair to an hours column can make it: a 5% courtesy
// discount and a 100% write-off move the same hours. Worse, the two ways the firm
// disposes of uncollectible time land in OPPOSITE places in an hours metric — a
// discount at issuance shows up as discounted hours, while a bill-then-credit
// leaves the hours reading "billed nondiscounted", i.e. fully realized. In dollars
// both are visible, so this measure cannot be moved by a bookkeeping choice.
//
// The workflow metric is kept, unchanged, on its own tab. This one is added
// beside it rather than replacing it.
//
// It is a NEW sheet, not extra columns on the Realization tab: that sheet's
// dimension is A1:O156 with column H absent entirely and I1 holding its How-To
// note (I..O styled down to row 14), so there is exactly one free column before
// the instructions block. surgicalWriteXlsx registers an unknown sheet name
// automatically, so returning this under a new key is all that is required.
//
// LAYOUT — month-blocked in the same shape as the other rate tabs (col A month
// label, col B initials), so findTabMonthBlock/ensureTabMonthBlock would work on
// it if a later change needs to patch rather than rebuild:
//
//   C Standard value   D Billed $   E Discounted $   F Credited $
//   G Collected $      H Outstanding $              I Unbilled $
//   J Gross billing    K Net economic   L Collection   M Total value
//
// TWO IDENTITIES hold by construction (both verified against live Clio reports),
// and the Total row writes them as live formulas so the sheet checks itself:
//   C == D + E + I          standard value = billed + discounted + not yet billed
//   D - F == G + H          billed net of credits = collected + outstanding
// ============================================================
import { xmlCell, xmlRow, STYLE_BOLD, STYLE_CUR, STYLE_PCT, STYLE_GEN } from "../utils/xlsx";
import { MONTH_NAMES_FULL } from "../domain/roster";
import type { RealizDollarsAgg } from "../clio/reportCsv";

export type DollarsByMonth = Record<number, Record<number, RealizDollarsAgg>>;

/** Sheet name. surgicalWriteXlsx registers an unknown name as a new worksheet, so
 *  changing this string creates a SECOND tab rather than renaming the first. */
export const REALIZATION_DOLLARS_TAB = "Realization ($)";

const HEADERS: Array<[string, string]> = [
  ["B", "Employee"],
  ["C", "Standard Value"],
  ["D", "Billed $"],
  ["E", "Discounted $"],
  ["F", "Credited $"],
  ["G", "Collected $"],
  ["H", "Outstanding $"],
  ["I", "Unbilled $"],
  ["J", "Gross Billing"],
  ["K", "Net Economic"],
  ["L", "Collection"],
  ["M", "Total Value"],
];

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Build the complete "Realization ($)" sheet XML from per-month, per-user dollar
 * aggregates. Rebuilt in full each run rather than patched — the tab is derived
 * entirely from Clio and carries no hand-entered cells, so there is nothing to
 * preserve, and a full rebuild cannot leave a stale month behind.
 *
 * `roster` fixes the row order within every month block. A timekeeper with no
 * billable activity in a month is skipped, so an empty month yields no rows and
 * an inactive biller does not dilute the Total row.
 */
export function buildRealizationDollarsSheet(
  byMonth: DollarsByMonth,
  months: number[],
  roster: Array<{ initials: string; user_id: number }>,
  asOf?: string,
): string {
  const rows: string[] = [];
  let r = 1;

  rows.push(xmlRow(r, [
    xmlCell(`A${r}`, "Economic realization, in dollars (auto-generated — do not edit)", { style: STYLE_BOLD }),
  ]));
  r++;
  rows.push(xmlRow(r, [
    xmlCell(`A${r}`,
      "Gross Billing = Billed ÷ Standard Value. Net Economic = (Billed − Credited) ÷ Standard Value. " +
      "Collection = Collected ÷ (Billed − Credited). Total Value = Collected ÷ Standard Value." +
      (asOf ? `  Data as of ${asOf}.` : ""),
      { style: STYLE_GEN }),
  ]));
  r += 2;

  for (const m of months) {
    const byUid = byMonth[m];
    const present = roster.filter((k) => {
      const d = byUid?.[k.user_id];
      return d && (d.standardValue !== 0 || d.billed !== 0 || d.unbilled !== 0);
    });
    if (!present.length) continue;

    // Month header: label in col A (what a block scan keys on) + column headings.
    rows.push(xmlRow(r, [
      xmlCell(`A${r}`, (MONTH_NAMES_FULL[m - 1] ?? String(m)).toUpperCase(), { style: STYLE_BOLD }),
      ...HEADERS.map(([col, text]) => xmlCell(`${col}${r}`, text, { style: STYLE_BOLD })),
    ]));
    const first = r + 1;
    r++;

    for (const k of present) {
      const d = byUid[k.user_id];
      const net = `(D${r}-F${r})`;
      rows.push(xmlRow(r, [
        xmlCell(`B${r}`, k.initials, { style: STYLE_GEN }),
        xmlCell(`C${r}`, round2(d.standardValue), { style: STYLE_CUR }),
        xmlCell(`D${r}`, round2(d.billed), { style: STYLE_CUR }),
        xmlCell(`E${r}`, round2(d.discounted), { style: STYLE_CUR }),
        xmlCell(`F${r}`, round2(d.credited), { style: STYLE_CUR }),
        xmlCell(`G${r}`, round2(d.collected), { style: STYLE_CUR }),
        xmlCell(`H${r}`, round2(d.outstanding), { style: STYLE_CUR }),
        xmlCell(`I${r}`, round2(d.unbilled), { style: STYLE_CUR }),
        // Rates are formulas, not baked values, so an analyst can audit them and
        // Excel recalculates if a figure is ever corrected by hand.
        xmlCell(`J${r}`, null, { style: STYLE_PCT, formula: `IF(C${r}=0,"",D${r}/C${r})` }),
        xmlCell(`K${r}`, null, { style: STYLE_PCT, formula: `IF(C${r}=0,"",${net}/C${r})` }),
        xmlCell(`L${r}`, null, { style: STYLE_PCT, formula: `IF(${net}=0,"",G${r}/${net})` }),
        xmlCell(`M${r}`, null, { style: STYLE_PCT, formula: `IF(C${r}=0,"",G${r}/C${r})` }),
      ]));
      r++;
    }

    const last = r - 1;
    const netT = `(D${r}-F${r})`;
    rows.push(xmlRow(r, [
      xmlCell(`B${r}`, "Total", { style: STYLE_BOLD }),
      ...["C", "D", "E", "F", "G", "H", "I"].map((c) =>
        xmlCell(`${c}${r}`, null, { style: STYLE_CUR, formula: `SUM(${c}${first}:${c}${last})` })),
      xmlCell(`J${r}`, null, { style: STYLE_PCT, formula: `IF(C${r}=0,"",D${r}/C${r})` }),
      xmlCell(`K${r}`, null, { style: STYLE_PCT, formula: `IF(C${r}=0,"",${netT}/C${r})` }),
      xmlCell(`L${r}`, null, { style: STYLE_PCT, formula: `IF(${netT}=0,"",G${r}/${netT})` }),
      xmlCell(`M${r}`, null, { style: STYLE_PCT, formula: `IF(C${r}=0,"",G${r}/C${r})` }),
    ]));
    r++;

    // Self-check row. Expect 0 to within a few cents — each figure above is
    // rounded to 2dp before it is written, so summing hundreds of them leaves
    // rounding noise (measured: $0.04 across a 3,327-row firm-wide month). A
    // difference in DOLLARS means the report's columns no longer reconcile and
    // the tab should not be trusted until that is explained.
    rows.push(xmlRow(r, [
      xmlCell(`B${r}`, "Check", { style: STYLE_GEN }),
      xmlCell(`C${r}`, null, { style: STYLE_CUR, formula: `C${r - 1}-(D${r - 1}+E${r - 1}+I${r - 1})` }),
      xmlCell(`D${r}`, "Std − (Billed+Disc+Unbilled) — expect 0 (cents = rounding)", { style: STYLE_GEN }),
      xmlCell(`G${r}`, null, { style: STYLE_CUR, formula: `(D${r - 1}-F${r - 1})-(G${r - 1}+H${r - 1})` }),
      xmlCell(`H${r}`, "(Billed−Credited) − (Collected+Outstanding) — expect 0 (cents = rounding)", { style: STYLE_GEN }),
    ]));
    r += 2;
  }

  if (rows.filter(Boolean).length <= 2) return "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rows.filter(Boolean).join("")}</sheetData></worksheet>`;
}
