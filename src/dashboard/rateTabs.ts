// ============================================================
// Rate-tab (Utilization / Realization / Collection) patch helpers.
// Pure XML transforms extracted from download_dashboard_update so the full
// dashboard build and the lighter rate-tabs-only refresh share one
// implementation. Each tab is month-blocked (col A = 3-letter month label,
// col B = initials); these patch one month's block in place.
// ============================================================
import {
  findTabMonthBlock, patchCell, readCell, MONTH_ABBRS,
  firmAvgRateByMonth, maxRowNumber, appendRowsBeforeSheetClose, stripRowsFromMarker,
  xmlCell, xmlRow, STYLE_BOLD, STYLE_PCT, STYLE_GEN,
} from "../utils/xlsx";
import { MONTH_NAMES_FULL } from "../domain/roster";
import { round1 } from "../utils/num";

// Per-user hours for the Utilization tab: user_id -> { billable, nonbillable }.
export type UtilHours = Record<number, { billable: number; nonbillable: number }>;

/**
 * Patch one month's block on the Utilization tab from per-user hours.
 * Writes C=Billable, D=Nonbillable, E=Total (=Billable+Nonbillable), and
 * G=Untracked (=max(0, Available − Total), reading the row's existing
 * Available in col F). The Utilization Rate (col H) is the template's own
 * =Billable/Available formula and is left untouched.
 *
 * `initialsToUid` maps the tab's col-B initials (uppercased) to user_id;
 * `aliases` remaps a known tab typo (JBP→JPB) before that lookup.
 */
export function patchUtilizationBlock(
  xml: string,
  monthAbbr: string,
  sharedStrings: string[],
  byUid: UtilHours,
  initialsToUid: Record<string, number>,
  aliases: Record<string, string>,
): { xml: string; patched: number } {
  let patched = 0;
  const block = findTabMonthBlock(xml, monthAbbr, sharedStrings, ["C", "D"]);
  if (!block) return { xml, patched };
  for (const { row, ini } of block.attorneys) {
    const uid = initialsToUid[aliases[ini] ?? ini];
    if (!uid) continue;
    const h = byUid[uid];
    if (!h) continue;
    const total = round1(h.billable + h.nonbillable);
    xml = patchCell(xml, `C${row}`, round1(h.billable));    // worked billable (= 26 Compare col I)
    xml = patchCell(xml, `D${row}`, round1(h.nonbillable)); // admin nonbillable (= 26 Compare col H)
    xml = patchCell(xml, `E${row}`, total);                 // Total = Billable + Nonbillable
    const avail = parseFloat(readCell(xml, `F${row}`, sharedStrings));
    if (Number.isFinite(avail)) xml = patchCell(xml, `G${row}`, round1(Math.max(0, avail - total))); // Untracked
    patched++;
  }
  return { xml, patched };
}

// Marker on the auto-generated "Firm Average" summary table appended to the
// bottom of the Utilization / Realization tabs, so it can be stripped and
// refreshed in place each run.
export const FIRM_AVG_MARKER = "Firm Average (auto-generated";
const monthFull = (abbr: string) => MONTH_NAMES_FULL[MONTH_ABBRS.indexOf(abbr)] ?? abbr;

/**
 * Build the rows of a "Firm Average" summary table: a bold title row (col A
 * only, so a later block scan treats it as a terminator), a header row, and one
 * row per month carrying the month NAME in col B (col A blank, so the rows are
 * never mistaken for new month-block headers). An optional goal column sits
 * between the actual rate and the biller count.
 */
export function buildFirmAvgRows(
  summary: Array<{ monthAbbr: string; avgRate: number; billers: number }>,
  startRow: number,
  title: string,
  rateHeader: string,
  goal?: { value: number; header: string },
): string[] {
  const out: string[] = [];
  out.push(xmlRow(startRow, [xmlCell(`A${startRow}`, title, { style: STYLE_BOLD })]));
  const hr = startRow + 1;
  const billersCol = goal ? "E" : "D";
  const header = [
    xmlCell(`B${hr}`, "Month", { style: STYLE_BOLD }),
    xmlCell(`C${hr}`, rateHeader, { style: STYLE_BOLD }),
  ];
  if (goal) header.push(xmlCell(`D${hr}`, goal.header, { style: STYLE_BOLD }));
  header.push(xmlCell(`${billersCol}${hr}`, "# Billers", { style: STYLE_BOLD }));
  out.push(xmlRow(hr, header));
  summary.forEach((s, i) => {
    const r = hr + 1 + i;
    const cells = [
      xmlCell(`B${r}`, monthFull(s.monthAbbr), { style: STYLE_BOLD }),
      xmlCell(`C${r}`, Math.round(s.avgRate * 10000) / 10000, { style: STYLE_PCT }),
    ];
    if (goal) cells.push(xmlCell(`D${r}`, Math.round(goal.value * 10000) / 10000, { style: STYLE_PCT }));
    cells.push(xmlCell(`${billersCol}${r}`, s.billers, { style: STYLE_GEN }));
    out.push(xmlRow(r, cells));
  });
  return out;
}

/**
 * Refresh the Utilization tab's bottom "Firm Average" summary in place: strip
 * the prior auto-generated block, recompute the per-month firm-mean utilization
 * (Billable C / Available F over active billers, C+D>0), and re-append.
 * `firmUtilGoal` > 0 adds the goal column. Returns the stripped XML unchanged
 * when no active month is found.
 */
export function appendUtilizationFirmAvg(xml: string, sharedStrings: string[], firmUtilGoal: number): string {
  const base = stripRowsFromMarker(xml, FIRM_AVG_MARKER, sharedStrings);
  const summary = firmAvgRateByMonth(base, sharedStrings, ["C", "D", "F"],
    (v) => (v.C + v.D > 0 && v.F > 0 ? v.C / v.F : null));
  if (!summary.length) return base;
  return appendRowsBeforeSheetClose(base, buildFirmAvgRows(
    summary, maxRowNumber(base) + 2,
    `${FIRM_AVG_MARKER} — do not edit) — mean of listed billers' utilization rate vs goal`,
    "Firm Avg Utilization Rate",
    firmUtilGoal > 0 ? { value: firmUtilGoal, header: "Firm Avg Util Goal" } : undefined));
}

/**
 * Refresh the Realization tab's bottom "Firm Average" summary: per-month firm
 * mean realization (Billed-Nondiscounted D / Total Billed (D+E) over billers
 * with D+E>0).
 */
export function appendRealizationFirmAvg(xml: string, sharedStrings: string[]): string {
  const base = stripRowsFromMarker(xml, FIRM_AVG_MARKER, sharedStrings);
  const summary = firmAvgRateByMonth(base, sharedStrings, ["D", "E"],
    (v) => (v.D + v.E > 0 ? v.D / (v.D + v.E) : null));
  if (!summary.length) return base;
  return appendRowsBeforeSheetClose(base, buildFirmAvgRows(
    summary, maxRowNumber(base) + 2,
    `${FIRM_AVG_MARKER} — do not edit) — mean of listed billers' realization rate`,
    "Firm Avg Realization Rate"));
}
