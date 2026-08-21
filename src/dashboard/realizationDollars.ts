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
// The workflow metric is kept, unchanged, on its own tab. This one sits beside it.
//
// It is a NEW sheet, not extra columns on the Realization tab: that sheet's
// dimension is A1:O156 with column H absent entirely and I1 holding its How-To
// note (I..O styled down to row 14), so there is exactly one free column before
// the instructions block. surgicalWriteXlsx registers an unknown sheet name
// automatically, so returning this under a new key is all that is required.
//
// LAYOUT — one block PER TIMEKEEPER with MONTHS ACROSS, not the month-blocked
// shape the other rate tabs use. Deliberate: these figures MATURE for roughly 90
// days after a month closes (unbilled work drains into billed/discounted), so the
// primary read is one person's trend over time, which a single row makes obvious
// and a stack of month blocks hides. A FIRM TOTAL block leads, since that is the
// figure partners actually ask for. Each block is a small financial statement:
//
//              JAN     FEB     ...     YTD
//   Standard Value   $   $              $      <- all billable work at its rate
//   Billed           $   $              $
//   Discounted       $   $              $      <- reduced at issuance
//   Credited         $   $              $      <- credit notes, applied later
//   Unbilled         $   $              $
//   Collected        $   $              $
//   Outstanding      $   $              $
//   Gross Billing    %   %              %
//   Net Economic     %   %              %      <- headline
//   Collection       %   %              %
//   Total Value      %   %              %      <- headline
//
// Rates are FORMULAS over the dollar rows in their own column, so they are
// auditable and cannot disagree with the figures above them. The YTD rate is
// computed from YTD dollars, never as an average of monthly rates — averaging
// rates overweights low-volume months (the same error that was corrected on the
// Realization tab's firm-average row).
//
// TWO IDENTITIES hold by construction, both verified against live firm-wide Clio
// reports, and the key states them so a reader can check the sheet:
//   Standard Value == Billed + Discounted + Unbilled
//   Billed - Credited == Collected + Outstanding
// ============================================================
import {
  xmlCell, xmlRow, STYLE_BOLD, STYLE_CUR, STYLE_PCT, STYLE_GEN,
  STYLE_CURB, STYLE_PCTB, STYLE_HDR,
} from "../utils/xlsx";
import { MONTH_NAMES_SHORT } from "../domain/roster";
import type { RealizDollarsAgg } from "../clio/reportCsv";

export type DollarsByMonth = Record<number, Record<number, RealizDollarsAgg>>;

/** Sheet name. surgicalWriteXlsx registers an unknown name as a new worksheet, so
 *  changing this string creates a SECOND tab rather than renaming the first. */
export const REALIZATION_DOLLARS_TAB = "Realization ($)";

type Member = { initials: string; user_id: number; name?: string };

/** Column letter for the Nth data column. Data starts at B because column A holds
 *  the row labels, so n=0 -> "B" (Excel column 2). */
export function dataCol(n: number): string {
  let s = "", i = n + 2; // +1 for 1-based Excel, +1 to skip the label column A
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Dollar rows, in display order: [label, field]
const MONEY_ROWS: Array<[string, keyof RealizDollarsAgg]> = [
  ["Standard Value", "standardValue"],
  ["Billed", "billed"],
  ["Discounted", "discounted"],
  ["Credited", "credited"],
  ["Unbilled", "unbilled"],
  ["Collected", "collected"],
  ["Outstanding", "outstanding"],
];

// Rate rows: [label, formula from row refs, isHeadline]
type RateSpec = [string, (r: Record<string, number>, c: string) => string, boolean];
const RATE_ROWS: RateSpec[] = [
  ["Gross Billing", (r, c) => `IF(${c}${r.std}=0,"",${c}${r.billed}/${c}${r.std})`, false],
  ["Net Economic", (r, c) => `IF(${c}${r.std}=0,"",(${c}${r.billed}-${c}${r.cred})/${c}${r.std})`, true],
  ["Collection", (r, c) => `IF((${c}${r.billed}-${c}${r.cred})=0,"",${c}${r.coll}/(${c}${r.billed}-${c}${r.cred}))`, false],
  ["Total Value", (r, c) => `IF(${c}${r.std}=0,"",${c}${r.coll}/${c}${r.std})`, true],
];

const KEY_METRICS: Array<[string, string, string]> = [
  ["Gross Billing", "Billed ÷ Standard Value", "Of the value of the work we did, how much reached a bill at all."],
  ["Net Economic", "(Billed − Credited) ÷ Standard Value", "…and survived credit notes. The value we kept a claim on. THE HEADLINE."],
  ["Collection", "Collected ÷ (Billed − Credited)", "Of what we kept a claim on, how much turned into cash."],
  ["Total Value", "Collected ÷ Standard Value", "Of the value of the work we did, how much became cash. THE HEADLINE."],
];

const KEY_TERMS: Array<[string, string]> = [
  ["Standard Value", "Every billable hour worked that month, valued at the rate it was recorded at — billed, discounted and not-yet-billed alike."],
  ["Discounted", "Reduced on the invoice when it was issued. Includes a bill written down to $0, which is how a full write-off appears."],
  ["Credited", "Credit notes applied AFTER the invoice was issued. The hours-based Realization tab cannot see these at all — it is the main reason this tab exists."],
  ["Unbilled", "Worked but not yet on a bill. Drains into Billed and Discounted over roughly 90 days, which is why a recent month always reads low."],
  ["Check rows", "Standard Value = Billed + Discounted + Unbilled, and Billed − Credited = Collected + Outstanding. Both should be zero; a few cents is rounding, dollars means something is wrong."],
];

/**
 * Build the complete "Realization ($)" sheet XML. Rebuilt in full each run rather
 * than patched — the tab is derived entirely from Clio and holds no hand-entered
 * cells, so there is nothing to preserve and a rebuild cannot leave a stale month
 * behind.
 *
 * A timekeeper with no billable activity in any listed month is omitted entirely
 * rather than shown as a block of zeros.
 */
export function buildRealizationDollarsSheet(
  byMonth: DollarsByMonth,
  months: number[],
  roster: Member[],
  asOf?: string,
): string {
  const active = roster.filter((k) =>
    months.some((m) => {
      const d = byMonth[m]?.[k.user_id];
      return d && (d.standardValue !== 0 || d.billed !== 0 || d.unbilled !== 0);
    }));
  if (!active.length) return "";

  const ytdCol = dataCol(months.length);
  const lastMonthCol = dataCol(months.length - 1);
  const rows: string[] = [];
  let r = 1;

  // ---- title ----
  rows.push(xmlRow(r++, [xmlCell(`A1`, "ECONOMIC REALIZATION — IN DOLLARS", { style: STYLE_HDR })]));
  rows.push(xmlRow(r++, [xmlCell(`A2`,
    "Auto-generated — do not edit. Activity-date basis: each month covers the work DONE that month, wherever it was later billed." +
    (asOf ? `  Data as of ${asOf}.` : ""), { style: STYLE_GEN })]));
  r++;

  // ---- key: the four rates ----
  rows.push(xmlRow(r, [
    xmlCell(`A${r}`, "HOW TO READ THIS", { style: STYLE_HDR }),
    xmlCell(`B${r}`, "Formula", { style: STYLE_HDR }),
    xmlCell(`C${r}`, "What it answers", { style: STYLE_HDR }),
  ]));
  r++;
  for (const [name, formula, meaning] of KEY_METRICS) {
    rows.push(xmlRow(r, [
      xmlCell(`A${r}`, name, { style: STYLE_BOLD }),
      xmlCell(`B${r}`, formula, { style: STYLE_GEN }),
      xmlCell(`C${r}`, meaning, { style: STYLE_GEN }),
    ]));
    r++;
  }
  r++;

  // ---- key: the terms ----
  rows.push(xmlRow(r, [
    xmlCell(`A${r}`, "WHAT THE LINES MEAN", { style: STYLE_HDR }),
    xmlCell(`B${r}`, "", { style: STYLE_HDR }),
    xmlCell(`C${r}`, "", { style: STYLE_HDR }),
  ]));
  r++;
  for (const [term, meaning] of KEY_TERMS) {
    rows.push(xmlRow(r, [
      xmlCell(`A${r}`, term, { style: STYLE_BOLD }),
      xmlCell(`B${r}`, meaning, { style: STYLE_GEN }),
    ]));
    r++;
  }
  r += 2;

  // ---- one block per timekeeper, firm total first ----
  const blocks: Array<{ label: string; get: (m: number) => RealizDollarsAgg | undefined }> = [
    {
      label: "FIRM TOTAL (listed timekeepers)",
      get: (m) => {
        const by = byMonth[m];
        if (!by) return undefined;
        const t: RealizDollarsAgg = {
          standardValue: 0, billed: 0, discounted: 0, credited: 0, collected: 0, outstanding: 0, unbilled: 0,
        };
        let any = false;
        for (const k of active) {
          const d = by[k.user_id];
          if (!d) continue;
          any = true;
          t.standardValue += d.standardValue; t.billed += d.billed; t.discounted += d.discounted;
          t.credited += d.credited; t.collected += d.collected; t.outstanding += d.outstanding;
          t.unbilled += d.unbilled;
        }
        return any ? t : undefined;
      },
    },
    ...active.map((k) => ({
      label: k.name ? `${k.name} (${k.initials})` : k.initials,
      get: (m: number) => byMonth[m]?.[k.user_id],
    })),
  ];

  for (const block of blocks) {
    const hdr = r;
    // Block title + month column headings on one row, so the title is never
    // orphaned from its columns when a reader scrolls.
    rows.push(xmlRow(hdr, [
      xmlCell(`A${hdr}`, block.label, { style: STYLE_HDR }),
      ...months.map((m, i) => xmlCell(`${dataCol(i)}${hdr}`, MONTH_NAMES_SHORT[m - 1] ?? String(m), { style: STYLE_HDR })),
      xmlCell(`${ytdCol}${hdr}`, "YTD", { style: STYLE_HDR }),
    ]));
    r++;

    const first = r;
    for (const [label, field] of MONEY_ROWS) {
      const cells = [xmlCell(`A${r}`, label, { style: STYLE_GEN })];
      months.forEach((m, i) => {
        const d = block.get(m);
        cells.push(xmlCell(`${dataCol(i)}${r}`, d ? round2(d[field] as number) : 0, { style: STYLE_CUR }));
      });
      cells.push(xmlCell(`${ytdCol}${r}`, null, {
        style: STYLE_CURB, formula: `SUM(${dataCol(0)}${r}:${lastMonthCol}${r})`,
      }));
      rows.push(xmlRow(r, cells));
      r++;
    }
    // Row numbers the rate formulas point at.
    const ref = {
      std: first, billed: first + 1, disc: first + 2, cred: first + 3,
      unb: first + 4, coll: first + 5, outs: first + 6,
    };

    for (const [label, mkFormula, headline] of RATE_ROWS) {
      const cells = [xmlCell(`A${r}`, label, { style: headline ? STYLE_BOLD : STYLE_GEN })];
      for (let i = 0; i < months.length; i++) {
        cells.push(xmlCell(`${dataCol(i)}${r}`, null, {
          style: headline ? STYLE_PCTB : STYLE_PCT, formula: mkFormula(ref, dataCol(i)),
        }));
      }
      // YTD rate from YTD dollars, not a mean of the monthly rates.
      cells.push(xmlCell(`${ytdCol}${r}`, null, {
        style: headline ? STYLE_PCTB : STYLE_PCT, formula: mkFormula(ref, ytdCol),
      }));
      rows.push(xmlRow(r, cells));
      r++;
    }

    // Identity checks, one row, both expressions.
    rows.push(xmlRow(r, [
      xmlCell(`A${r}`, "Check (expect 0)", { style: STYLE_GEN }),
      ...months.map((_m, i) => {
        const c = dataCol(i);
        return xmlCell(`${c}${r}`, null, {
          style: STYLE_CUR,
          formula: `(${c}${ref.std}-(${c}${ref.billed}+${c}${ref.disc}+${c}${ref.unb}))+((${c}${ref.billed}-${c}${ref.cred})-(${c}${ref.coll}+${c}${ref.outs}))`,
        });
      }),
      xmlCell(`${ytdCol}${r}`, null, {
        style: STYLE_CUR,
        formula: `(${ytdCol}${ref.std}-(${ytdCol}${ref.billed}+${ytdCol}${ref.disc}+${ytdCol}${ref.unb}))+((${ytdCol}${ref.billed}-${ytdCol}${ref.cred})-(${ytdCol}${ref.coll}+${ytdCol}${ref.outs}))`,
      }),
    ]));
    r += 2;
  }

  // Freeze col A and the header band so labels stay visible when scrolling, and
  // give the label column room for the key text.
  const widths = `<cols><col min="1" max="1" width="26" customWidth="1"/>` +
    `<col min="2" max="${months.length + 1}" width="13" customWidth="1"/>` +
    `<col min="${months.length + 2}" max="${months.length + 2}" width="14" customWidth="1"/></cols>`;
  const views = `<sheetViews><sheetView workbookViewId="0">` +
    `<pane xSplit="1" topLeftCell="B1" activePane="topRight" state="frozen"/></sheetView></sheetViews>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    views + widths +
    `<sheetData>${rows.filter(Boolean).join("")}</sheetData></worksheet>`;
}
