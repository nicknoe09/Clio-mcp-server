// ============================================================
// Bonus computation (extracted from download_dashboard_update).
// Pure bracket math — given each month's per-initials collections and the bonus
// config, computes per-attorney YTD/bracket/bonus-earned. No workbook access, so
// it's unit-testable and type-checked.
// ============================================================
import { round2 } from "../utils/num";
import { MONTH_NAMES_FULL } from "../domain/roster";

export type BonusAttorney = {
  ini: string; salary: number; associate: string; paralegal: string;
  paraSalary: number; legalAsst: number; payroll: number;
};
export type BonusBracket = { width: number; rate: number };
export type BonusRow = {
  month: string; collections: number; ytd: number; bracket: string;
  toNext: number; bonusEarned: number; cumBonus: number;
};
export type BonusData = Record<string, { baseTarget: number; rows: BonusRow[] }>;

// Sum collections for a (possibly multi-initial) associate/paralegal field.
// Accepts a single initial ("AFL") or a comma/plus/slash list ("SAB,AFL").
function sumByInitials(mc: Record<string, number>, field: string | undefined): number {
  if (!field) return 0;
  return field
    .split(/[,+/]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .reduce((sum, ini) => sum + (mc[ini] || 0), 0);
}

/**
 * Reconcile the Bonus Config read from the workbook sheet against the code
 * defaults (the firm's comp decisions).
 *
 * WHY: download_dashboard_update reads the "Bonus Config" sheet and then
 * REWRITES it from what it read, so a stale sheet silently self-perpetuates —
 * that is exactly how the firm's associate-credit fixes (PR #200/#201: PAR's
 * associate is NAF, KES gets JPB's post-termination tail, KES's paralegal
 * credit is "SAB,AFL" so Anna's ongoing collections keep crediting KES until
 * they stop, and JPB has no standalone bonus row) never took effect: the sheet
 * still carried the pre-decision mappings and overrode the corrected defaults
 * on every run.
 *
 * RULES:
 * - The ROSTER (which attorneys have bonus rows) and the ATTRIBUTION fields
 *   (associate / paralegal credit lists) come from the code defaults.
 * - The COMP numbers (salary, paraSalary, legalAsst, payroll) stay
 *   sheet-editable: a positive sheet value wins over the default; blank/zero
 *   falls back to the default (so a half-filled row can't zero out a salary).
 * - Sheet rows for attorneys not in the defaults are dropped (e.g. JPB's
 *   stale standalone row); every divergence is reported in `notes`.
 */
export function reconcileBonusConfig(
  sheetRows: BonusAttorney[],
  defaults: BonusAttorney[],
): { attorneys: BonusAttorney[]; notes: string[] } {
  const notes: string[] = [];
  const byIni = new Map(sheetRows.map((r) => [r.ini.toUpperCase(), r]));
  const attorneys = defaults.map((def) => {
    const s = byIni.get(def.ini.toUpperCase());
    if (!s) {
      notes.push(`${def.ini}: no sheet row — using code defaults`);
      return { ...def };
    }
    const norm = (f: string) => f.split(/[,+/]/).map((x) => x.trim().toUpperCase()).filter(Boolean).join(",");
    if (norm(s.associate) !== norm(def.associate)) {
      notes.push(`${def.ini}: sheet associate "${s.associate || "(none)"}" overridden by firm config "${def.associate || "(none)"}"`);
    }
    if (norm(s.paralegal) !== norm(def.paralegal)) {
      notes.push(`${def.ini}: sheet paralegal "${s.paralegal || "(none)"}" overridden by firm config "${def.paralegal || "(none)"}"`);
    }
    return {
      ...def,
      salary: s.salary > 0 ? s.salary : def.salary,
      paraSalary: s.paraSalary > 0 ? s.paraSalary : def.paraSalary,
      legalAsst: s.legalAsst > 0 ? s.legalAsst : def.legalAsst,
      payroll: s.payroll > 0 ? s.payroll : def.payroll,
    };
  });
  const dropped = sheetRows.filter((r) => !defaults.some((d) => d.ini.toUpperCase() === r.ini.toUpperCase()));
  for (const r of dropped) notes.push(`${r.ini}: stale sheet row dropped (not in the firm bonus roster)`);
  return { attorneys, notes };
}

/**
 * Compute per-attorney bonus rows from monthly collections.
 * @param monthCollections monthName -> initials -> collected $ (individual, col N)
 * @param configAttorneys  bonus config (salary/associate/paralegal/etc.)
 * @param opts.firmOverhead/numAttorneys  overhead split inputs
 * @param opts.brackets    incremental bonus brackets (width + marginal rate)
 * @param opts.mnhSplitAmong initials that share MNH's collections equally
 */
export function computeBonusData(
  monthCollections: Record<string, Record<string, number>>,
  configAttorneys: BonusAttorney[],
  opts: { firmOverhead: number; numAttorneys: number; brackets: BonusBracket[]; mnhSplitAmong: string[] },
): BonusData {
  const { firmOverhead, numAttorneys, brackets, mnhSplitAmong } = opts;
  const overheadShare = firmOverhead / numAttorneys;
  const bonusData: BonusData = {};

  for (const atty of configAttorneys) {
    const baseTarget = atty.salary + atty.paraSalary + atty.legalAsst + (atty.payroll * (atty.salary + atty.paraSalary)) + overheadShare;
    const bracketCeilings = [baseTarget, baseTarget + brackets[1].width, baseTarget + brackets[1].width + brackets[2].width];
    const rows: BonusRow[] = [];
    let ytd = 0;
    let cumBonus = 0;

    for (let mi = 0; mi < 12; mi++) {
      const mn = MONTH_NAMES_FULL[mi];
      const mc = monthCollections[mn];
      if (!mc) { rows.push({ month: mn, collections: 0, ytd, bracket: "-", toNext: 0, bonusEarned: 0, cumBonus }); continue; }

      // Attributed collections = own + associate(s) + paralegal(s) + MNH split.
      // associate/paralegal may list MULTIPLE initials (comma/plus/slash separated) —
      // e.g. an attorney who keeps crediting a former paralegal's ongoing collections
      // in addition to their current one (KES = "SAB,AFL").
      let collections = mc[atty.ini] || 0;
      collections += sumByInitials(mc, atty.associate);
      collections += sumByInitials(mc, atty.paralegal);
      if (mnhSplitAmong.includes(atty.ini)) {
        collections += (mc["MNH"] || 0) / mnhSplitAmong.length;
      }
      collections = round2(collections);

      const prevYtd = ytd;
      ytd = round2(ytd + collections);

      // Bracket label
      let bracket = "Bracket 1";
      if (ytd > bracketCeilings[2]) bracket = "Bracket 4";
      else if (ytd > bracketCeilings[1]) bracket = "Bracket 3";
      else if (ytd > bracketCeilings[0]) bracket = "Bracket 2";

      // To next bracket
      let toNext = 0;
      if (ytd <= bracketCeilings[0]) toNext = round2(bracketCeilings[0] - ytd + 0.01);
      else if (ytd <= bracketCeilings[1]) toNext = round2(bracketCeilings[1] - ytd + 0.01);
      else if (ytd <= bracketCeilings[2]) toNext = round2(bracketCeilings[2] - ytd + 0.01);

      // Bonus earned this month (incremental bracket calculation)
      let bonusEarned = 0;
      let remaining = collections;
      let cursor = prevYtd;
      for (let bi = 0; bi < brackets.length && remaining > 0; bi++) {
        const ceil = bi < bracketCeilings.length ? bracketCeilings[bi] : Infinity;
        const space = Math.max(0, ceil - cursor);
        const inBracket = Math.min(remaining, space);
        bonusEarned += inBracket * brackets[bi].rate;
        cursor += inBracket;
        remaining -= inBracket;
      }
      if (remaining > 0) bonusEarned += remaining * brackets[brackets.length - 1].rate;
      bonusEarned = round2(bonusEarned);
      cumBonus = round2(cumBonus + bonusEarned);

      rows.push({ month: mn, collections, ytd, bracket, toNext, bonusEarned, cumBonus });
    }
    bonusData[atty.ini] = { baseTarget: round2(baseTarget), rows };
  }
  return bonusData;
}
