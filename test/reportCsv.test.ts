import { describe, it, expect } from "vitest";
import {
  parseCSV, matchRosterUser, matchRosterResponsible,
  aggregateRealizationCollections, aggregateFeeAllocationCollectionHrs,
} from "../src/clio/reportCsv";

const roster = [
  { initials: "NRN", name: "Nicholas Noe", user_id: 348755029 },
  { initials: "TBS", name: "Tzipora Simmons", user_id: 359711375 },
];

describe("parseCSV", () => {
  it("parses headers + rows", () => {
    expect(parseCSV("a,b,c\n1,2,3")).toEqual([{ a: "1", b: "2", c: "3" }]);
  });
  it("strips a leading UTF-8 BOM from the first header", () => {
    expect(parseCSV("﻿h1,h2\nv1,v2")[0]).toEqual({ h1: "v1", h2: "v2" });
  });
  it("respects quoted fields with commas and escaped quotes", () => {
    expect(parseCSV('a,b\n"x,y","a""b"')).toEqual([{ a: "x,y", b: 'a"b' }]);
  });
  it("skips blank lines; header-only yields []", () => {
    expect(parseCSV("a,b\n\n1,2\n")).toEqual([{ a: "1", b: "2" }]);
    expect(parseCSV("a,b")).toEqual([]);
  });
});

describe("matchRosterUser ('Last, First' or 'First Last')", () => {
  it("matches Last, First", () => expect(matchRosterUser("Simmons, Tzipora", roster)).toBe(359711375));
  it("matches First Last", () => expect(matchRosterUser("Nicholas Noe", roster)).toBe(348755029));
  it("returns null for unknown", () => expect(matchRosterUser("Nobody, X", roster)).toBeNull());
});

describe("matchRosterResponsible ('First Last')", () => {
  it("exact match", () => expect(matchRosterResponsible("Nicholas Noe", roster)).toBe(348755029));
  it("last-name fallback", () => expect(matchRosterResponsible("Noe", roster)).toBe(348755029));
  it("empty -> null", () => expect(matchRosterResponsible("", roster)).toBeNull());
});

// Collection-tab HOURS split: the Realization-report aggregator and the
// Fee-Allocation aggregator must produce IDENTICAL collected/uncollected hours
// given the same economic inputs (billed$, collected$, outstanding$, billed hrs).
// This proves the "compare_collection_methods" diagnostic measures the SOURCE
// population (Realization = time-entry date vs Fee Allocation = issue date), not
// a difference in the arithmetic — so any live delta is a real basis difference,
// not a bug. Column names differ between the two reports ("Billed Time Amount"
// vs "Billed Time").
describe("collection HOURS aggregators are equivalent given equal inputs", () => {
  const nameToUid = new Map<string, number>(roster.map((r) => [r.name.toLowerCase(), r.user_id]));

  it("allocates billed hours to collected/uncollected by the dollar split", () => {
    const realizRows = [
      { User: "Nicholas Noe", "Billed Time Amount": "1000", "Billed Time Collected": "600", "Billed Time Outstanding": "400", "Billed Hours": "10" },
    ];
    const feeRows = [
      { User: "Nicholas Noe", "Billed Time": "1000", "Billed Time Collected": "600", "Billed Time Outstanding": "400", "Billed Hours": "10" },
    ];
    const a = aggregateRealizationCollections(realizRows, nameToUid)[348755029];
    const b = aggregateFeeAllocationCollectionHrs(feeRows, roster)[348755029];
    expect(a.collectedHrs).toBeCloseTo(6, 6);
    expect(a.uncollectedHrs).toBeCloseTo(4, 6);
    expect(b.collectedHrs).toBeCloseTo(a.collectedHrs, 6);
    expect(b.uncollectedHrs).toBeCloseTo(a.uncollectedHrs, 6);
  });

  it("sums multiple entries and skips zero-billed / non-roster rows", () => {
    const realizRows = [
      { User: "Nicholas Noe", "Billed Time Amount": "1000", "Billed Time Collected": "500", "Billed Time Outstanding": "500", "Billed Hours": "8" },
      { User: "Nicholas Noe", "Billed Time Amount": "200", "Billed Time Collected": "200", "Billed Time Outstanding": "0", "Billed Hours": "2" },
      { User: "Nicholas Noe", "Billed Time Amount": "0", "Billed Time Collected": "0", "Billed Time Outstanding": "0", "Billed Hours": "0" }, // unbilled — skipped
      { User: "Stranger, Sam", "Billed Time Amount": "500", "Billed Time Collected": "500", "Billed Time Outstanding": "0", "Billed Hours": "5" }, // non-roster — skipped
    ];
    const agg = aggregateRealizationCollections(realizRows, nameToUid)[348755029];
    // entry1: 8h * 0.5 = 4 collected, 4 uncollected; entry2: 2h collected
    expect(agg.collectedHrs).toBeCloseTo(6, 6);
    expect(agg.uncollectedHrs).toBeCloseTo(4, 6);
  });
});
