import { describe, it, expect } from "vitest";
import { parseCSV, matchRosterUser, matchRosterResponsible } from "../src/clio/reportCsv";

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
