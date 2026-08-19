import { describe, it, expect } from "vitest";
import {
  buildCalendarIdToUserId,
  resolveAttendeeUserIds,
  ATTENDEE_FIELDS,
} from "../src/clio/calendarIdentity";

// Clio's Calendar and User are separate resources, and CalendarEntry.attendees
// identifies a *person* by their CALENDAR id (Attendee_base.type ===
// "Calendar"). The scorecard is keyed by Clio USER id, so attendee ids must be
// mapped before counting — comparing them directly matches nothing, which is
// how the "potential calls" metric silently read 0 for every timekeeper.
const CALENDARS = [
  { id: 2882209, name: "Nicholas Noe", creator: { id: 111, name: "Nicholas Noe" } },
  { id: 9473780, name: "NRN - Personal", creator: { id: 111, name: "Nicholas Noe" } },
  { id: 555, name: "Jane Roe", creator: { id: 222, name: "Jane Roe" } },
  { id: 3107359, name: "Firm Deadlines", creator: null },
];

describe("buildCalendarIdToUserId", () => {
  it("maps each calendar id to its owning user id", () => {
    const map = buildCalendarIdToUserId(CALENDARS);
    expect(map.get(2882209)).toBe(111);
    expect(map.get(9473780)).toBe(111); // both of Nick's calendars → same user
    expect(map.get(555)).toBe(222);
  });

  it("skips calendars with no creator rather than mapping to undefined", () => {
    const map = buildCalendarIdToUserId(CALENDARS);
    expect(map.has(3107359)).toBe(false);
  });

  it("tolerates malformed records", () => {
    const map = buildCalendarIdToUserId([null, {}, { id: 1 }, { creator: { id: 2 } }] as any[]);
    expect(map.size).toBe(0);
  });
});

describe("resolveAttendeeUserIds", () => {
  const map = buildCalendarIdToUserId(CALENDARS);

  it("resolves Calendar-type attendees to their user ids", () => {
    const entry = {
      summary: "Potential new client call",
      attendees: [
        { id: 2882209, name: "Nicholas Noe", type: "Calendar" },
        { id: 555, name: "Jane Roe", type: "Calendar" },
      ],
    };
    expect(resolveAttendeeUserIds(entry, map).sort()).toEqual([111, 222]);
  });

  it("credits BOTH people on a shared call (the old code counted at most one)", () => {
    const entry = {
      attendees: [
        { id: 2882209, type: "Calendar" },
        { id: 555, type: "Calendar" },
      ],
    };
    expect(resolveAttendeeUserIds(entry, map)).toHaveLength(2);
  });

  it("de-duplicates when one person is on the entry via two of their calendars", () => {
    const entry = {
      attendees: [
        { id: 2882209, type: "Calendar" },
        { id: 9473780, type: "Calendar" },
      ],
    };
    // Both calendars belong to user 111 — count them once, not twice.
    expect(resolveAttendeeUserIds(entry, map)).toEqual([111]);
  });

  it("ignores Contact attendees even when the id collides with a calendar id", () => {
    // Contact ids and Calendar ids are different namespaces, so a Contact
    // whose id equals a real calendar id must not be credited as that user.
    const entry = {
      attendees: [{ id: 2882209, name: "A Client", type: "Contact" }],
    };
    expect(resolveAttendeeUserIds(entry, map)).toEqual([]);
  });

  it("ignores Calendar attendees that aren't in the map (e.g. departed user)", () => {
    expect(resolveAttendeeUserIds({ attendees: [{ id: 99999, type: "Calendar" }] }, map)).toEqual([]);
  });

  it("tolerates missing/empty/non-array attendees", () => {
    expect(resolveAttendeeUserIds({}, map)).toEqual([]);
    expect(resolveAttendeeUserIds({ attendees: null }, map)).toEqual([]);
    expect(resolveAttendeeUserIds({ attendees: [] }, map)).toEqual([]);
    expect(resolveAttendeeUserIds({ attendees: [null, {}] }, map)).toEqual([]);
  });
});

describe("ATTENDEE_FIELDS", () => {
  it("requests attendees PLURAL — a singular `attendee` makes Clio reject the request", () => {
    expect(ATTENDEE_FIELDS).toContain("attendees{");
    expect(ATTENDEE_FIELDS).not.toMatch(/(^|[^s])attendee\{/);
  });

  it("includes type, which is required to tell firm people from Contacts", () => {
    expect(ATTENDEE_FIELDS).toContain("type");
  });
});
