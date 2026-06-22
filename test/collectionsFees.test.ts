import { describe, it, expect } from "vitest";
import { aggregateMonthFees } from "../src/dashboard/collections";
import type { RosterMember } from "../src/domain/roster";

const ROSTER: RosterMember[] = [
  { initials: "PAR", name: "Paul Romano", user_id: 1 },
  { initials: "KES", name: "Kenny Sumner", user_id: 2 },
  { initials: "NRN", name: "Nicholas Noe", user_id: 3 },
];

// Mirrors the real Fee Allocation CSV columns.
const row = (o: Partial<Record<string, string>>): Record<string, string> => ({
  User: "", "Originating Attorney": "", "Responsible Attorney": "",
  "Billed Time Collected": "0", "Expense Amount Collected": "0", "Total Funds Collected": "0",
  ...o,
});

describe("aggregateMonthFees", () => {
  it("uses Billed Time Collected (fees only), ignoring expenses/tax in Total Funds", () => {
    const rows = [
      row({ User: "Paul Romano", "Originating Attorney": "Paul Romano", "Responsible Attorney": "Paul Romano",
        "Billed Time Collected": "735.0", "Expense Amount Collected": "3.34", "Total Funds Collected": "738.34" }),
    ];
    const agg = aggregateMonthFees(rows, ROSTER);
    expect(agg.indiv[1]).toBe(735); // not 738.34 — expense excluded
    expect(agg.firm).toBe(735);
  });

  it("credits col N by working timekeeper and col V by originating attorney", () => {
    const rows = [
      // Worked by Kenny, originated by Paul
      row({ User: "Kenny Sumner", "Originating Attorney": "Paul Romano", "Billed Time Collected": "1000" }),
    ];
    const agg = aggregateMonthFees(rows, ROSTER);
    expect(agg.indiv[2]).toBe(1000); // KES (worker) → col N
    expect(agg.orig[1]).toBe(1000);  // PAR (originator) → col V
  });

  it("pools non-roster billers so Σ col N (+NRB) == Σ col V (+NRB) == firm fees", () => {
    const rows = [
      row({ User: "Paul Romano", "Originating Attorney": "Paul Romano", "Billed Time Collected": "500" }),
      // Non-roster worker, roster originator → drops from col N without NRB, but kept via nonRosterIndiv
      row({ User: "Elissa Silguero", "Originating Attorney": "Kenny Sumner", "Billed Time Collected": "300" }),
      // Roster worker, non-roster originator → kept via nonRosterOrig
      row({ User: "Nicholas Noe", "Originating Attorney": "Former Partner", "Billed Time Collected": "200" }),
    ];
    const agg = aggregateMonthFees(rows, ROSTER);
    const sumN = Object.values(agg.indiv).reduce((s, v) => s + v, 0) + agg.nonRosterIndiv;
    const sumV = Object.values(agg.orig).reduce((s, v) => s + v, 0) + agg.nonRosterOrig;
    expect(agg.firm).toBe(1000);
    expect(sumN).toBe(1000);
    expect(sumV).toBe(1000);
    expect(agg.nonRosterIndiv).toBe(300); // Elissa
    expect(agg.nonRosterOrig).toBe(200);  // Former Partner
  });

  it("skips rows with zero collected fees", () => {
    const rows = [row({ User: "Paul Romano", "Billed Time Collected": "0", "Expense Amount Collected": "50" })];
    const agg = aggregateMonthFees(rows, ROSTER);
    expect(agg.firm).toBe(0);
    expect(agg.indiv[1]).toBeUndefined();
  });
});
