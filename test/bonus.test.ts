import { describe, it, expect } from "vitest";
import { computeBonusData, type BonusBracket, type BonusAttorney } from "../src/dashboard/bonus";

const BRACKETS: BonusBracket[] = [
  { width: 0, rate: 0 },           // base target at 0%
  { width: 50000, rate: 0.05 },
  { width: 50000, rate: 0.10 },
  { width: Infinity, rate: 0.15 },
];

describe("computeBonusData", () => {
  it("brackets: base 100k @0%, then 5%/10% on the next 50k/50k", () => {
    const atty: BonusAttorney = { ini: "ATT", salary: 100000, associate: "", paralegal: "", paraSalary: 0, legalAsst: 0, payroll: 0 };
    const data = computeBonusData(
      { January: { ATT: 100000 }, February: { ATT: 60000 } },
      [atty],
      { firmOverhead: 0, numAttorneys: 1, brackets: BRACKETS, mnhSplitAmong: [] },
    );
    expect(data.ATT.baseTarget).toBe(100000);
    const jan = data.ATT.rows[0], feb = data.ATT.rows[1], mar = data.ATT.rows[2];
    expect(jan).toMatchObject({ month: "January", collections: 100000, ytd: 100000, bracket: "Bracket 1", bonusEarned: 0, cumBonus: 0 });
    // Feb 60k spans 150k (50k@5%=2500) + 10k@10%=1000 => 3500
    expect(feb).toMatchObject({ month: "February", collections: 60000, ytd: 160000, bracket: "Bracket 3", bonusEarned: 3500, cumBonus: 3500 });
    // months with no collections carry YTD + cumBonus, label "-"
    expect(mar).toMatchObject({ month: "March", collections: 0, ytd: 160000, bracket: "-", bonusEarned: 0, cumBonus: 3500 });
  });

  it("baseTarget includes paraSalary, payroll on (salary+para), and overhead share", () => {
    const atty: BonusAttorney = { ini: "X", salary: 100000, associate: "", paralegal: "", paraSalary: 50000, legalAsst: 0, payroll: 0.17 };
    const data = computeBonusData({}, [atty], { firmOverhead: 500000, numAttorneys: 5, brackets: BRACKETS, mnhSplitAmong: [] });
    // 100000 + 50000 + 0 + 0.17*(150000) + 500000/5 = 100000+50000+25500+100000 = 275500
    expect(data.X.baseTarget).toBe(275500);
  });

  it("credits a multi-initial paralegal field (e.g. KES keeps Anna + Stacy)", () => {
    const kes: BonusAttorney = { ini: "KES", salary: 0, associate: "TBS", paralegal: "SAB,AFL", paraSalary: 0, legalAsst: 0, payroll: 0 };
    const data = computeBonusData(
      { January: { KES: 1000, TBS: 500, SAB: 200, AFL: 300 } },
      [kes],
      { firmOverhead: 0, numAttorneys: 1, brackets: BRACKETS, mnhSplitAmong: [] },
    );
    // own 1000 + associate TBS 500 + paralegals SAB 200 + AFL 300 = 2000
    expect(data.KES.rows[0].collections).toBe(2000);
  });

  it("MNH collections split equally among the configured initials", () => {
    const par: BonusAttorney = { ini: "PAR", salary: 100000, associate: "", paralegal: "", paraSalary: 0, legalAsst: 0, payroll: 0 };
    const data = computeBonusData(
      { January: { PAR: 0, MNH: 30000 } },
      [par],
      { firmOverhead: 0, numAttorneys: 1, brackets: BRACKETS, mnhSplitAmong: ["PAR", "KES", "NRN"] },
    );
    expect(data.PAR.rows[0].collections).toBe(10000); // 30000 / 3
  });
});
