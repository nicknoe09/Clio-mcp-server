import { describe, it, expect } from "vitest";
import { computeBonusData, reconcileBonusConfig, type BonusBracket, type BonusAttorney } from "../src/dashboard/bonus";

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

describe("reconcileBonusConfig", () => {
  const defaults: BonusAttorney[] = [
    { ini: "PAR", salary: 332340, associate: "NAF", paralegal: "ACA",     paraSalary: 80000, legalAsst: 0, payroll: 0.17 },
    { ini: "KES", salary: 332340, associate: "JPB", paralegal: "SAB,AFL", paraSalary: 75000, legalAsst: 0, payroll: 0.17 },
    { ini: "TBS", salary: 167500, associate: "",    paralegal: "",        paraSalary: 0,     legalAsst: 0, payroll: 0.17 },
  ];
  const sheetRow = (o: Partial<BonusAttorney> & { ini: string }): BonusAttorney => ({
    salary: 0, associate: "", paralegal: "", paraSalary: 0, legalAsst: 0, payroll: 0.17, ...o,
  });

  it("attribution (associate/paralegal) comes from the code defaults, not a stale sheet", () => {
    // The exact stale state found live (2026-08): PAR credited JPB, KES credited
    // TBS (double-count — TBS has his own row) and lost AFL's tail.
    const sheet = [
      sheetRow({ ini: "PAR", salary: 332340, associate: "JPB", paralegal: "ACA", paraSalary: 80000 }),
      sheetRow({ ini: "KES", salary: 332340, associate: "TBS", paralegal: "SAB", paraSalary: 75000 }),
      sheetRow({ ini: "TBS", salary: 167500 }),
    ];
    const { attorneys, notes } = reconcileBonusConfig(sheet, defaults);
    const par = attorneys.find((a) => a.ini === "PAR")!;
    const kes = attorneys.find((a) => a.ini === "KES")!;
    expect(par.associate).toBe("NAF");
    expect(kes.associate).toBe("JPB");
    expect(kes.paralegal).toBe("SAB,AFL"); // AFL's tail keeps crediting KES until it stops
    expect(notes.length).toBeGreaterThanOrEqual(3); // PAR assoc, KES assoc, KES para all overridden
  });

  it("comp numbers stay sheet-editable; blank/zero falls back to defaults", () => {
    const sheet = [
      sheetRow({ ini: "PAR", salary: 350000, associate: "NAF", paralegal: "ACA", paraSalary: 82000, payroll: 0.2 }),
      sheetRow({ ini: "KES", salary: 0, associate: "JPB", paralegal: "SAB,AFL", paraSalary: 0 }), // blanks
    ];
    const { attorneys } = reconcileBonusConfig(sheet, defaults);
    const par = attorneys.find((a) => a.ini === "PAR")!;
    const kes = attorneys.find((a) => a.ini === "KES")!;
    expect(par.salary).toBe(350000);   // sheet edit honored
    expect(par.paraSalary).toBe(82000);
    expect(par.payroll).toBe(0.2);
    expect(kes.salary).toBe(332340);   // blank → default
    expect(kes.paraSalary).toBe(75000);
  });

  it("drops stale sheet rows not in the roster (JPB standalone) and keeps roster order", () => {
    const sheet = [
      sheetRow({ ini: "JPB", salary: 110000 }), // terminated — no own bonus row
      sheetRow({ ini: "KES", salary: 332340, associate: "JPB", paralegal: "SAB,AFL", paraSalary: 75000 }),
    ];
    const { attorneys, notes } = reconcileBonusConfig(sheet, defaults);
    expect(attorneys.map((a) => a.ini)).toEqual(["PAR", "KES", "TBS"]);
    expect(notes.some((n) => n.startsWith("JPB:"))).toBe(true);
    expect(notes.some((n) => n.startsWith("PAR: no sheet row"))).toBe(true);
  });

  it("initials-list comparison ignores spacing/separator/case differences", () => {
    const sheet = [
      sheetRow({ ini: "KES", salary: 332340, associate: "jpb", paralegal: "sab, afl", paraSalary: 75000 }),
    ];
    const { notes } = reconcileBonusConfig(sheet, defaults);
    expect(notes.filter((n) => n.startsWith("KES:"))).toEqual([]); // equivalent lists → no override note
  });
});
