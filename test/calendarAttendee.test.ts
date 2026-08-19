import { describe, it, expect } from "vitest";
import {
  isEntryOwnedBy,
  isUserAttendingEntry,
  classifyEntryMatch,
} from "../src/tools/calendar";

// Attendee matching, grounded in Clio's OpenAPI CalendarEntry model:
//   - CalendarEntry.attendees is an ARRAY of Attendee_base (plural; a
//     singular `attendee` field does not exist).
//   - Attendee_base.type is an enum of "Contact" | "Calendar" — so a PERSON
//     attendee is identified by their CALENDAR id, while "Contact" attendees
//     (clients, opposing counsel) carry Contact ids in a different namespace.
//   - /calendar_entries has NO attendee query filter, so this matching runs
//     client-side over a swept date range.
const NICK_CALENDARS = new Set([2882209, 9473780]);

describe("isEntryOwnedBy", () => {
  it("matches on nested calendar_owner{id}", () => {
    expect(isEntryOwnedBy({ calendar_owner: { id: 2882209 } }, NICK_CALENDARS)).toBe(true);
  });

  it("falls back to the flat calendar_owner_id response field", () => {
    expect(isEntryOwnedBy({ calendar_owner_id: 9473780 }, NICK_CALENDARS)).toBe(true);
  });

  it("does not match another user's calendar", () => {
    expect(isEntryOwnedBy({ calendar_owner: { id: 555 } }, NICK_CALENDARS)).toBe(false);
  });

  it("handles a missing owner without throwing", () => {
    expect(isEntryOwnedBy({}, NICK_CALENDARS)).toBe(false);
    expect(isEntryOwnedBy({ calendar_owner: null }, NICK_CALENDARS)).toBe(false);
  });
});

describe("isUserAttendingEntry", () => {
  it("matches a Calendar-type attendee on someone else's event", () => {
    const entry = {
      calendar_owner: { id: 555 }, // a paralegal's calendar
      attendees: [
        { id: 555, name: "Jane Roe", type: "Calendar" },
        { id: 2882209, name: "Nicholas Noe", type: "Calendar" },
      ],
    };
    expect(isUserAttendingEntry(entry, NICK_CALENDARS)).toBe(true);
    // The whole point of the feature: not owned, but still the user's event.
    expect(isEntryOwnedBy(entry, NICK_CALENDARS)).toBe(false);
  });

  it("ignores Contact attendees even when the id collides with a calendar id", () => {
    // Contact ids live in a different namespace than Calendar ids, so a
    // Contact whose id happens to equal one of the user's calendar ids must
    // NOT count as the user attending.
    const entry = {
      calendar_owner: { id: 555 },
      attendees: [{ id: 2882209, name: "Some Client", type: "Contact" }],
    };
    expect(isUserAttendingEntry(entry, NICK_CALENDARS)).toBe(false);
  });

  it("returns false when the user is not among the attendees", () => {
    const entry = {
      calendar_owner: { id: 555 },
      attendees: [{ id: 777, name: "Someone Else", type: "Calendar" }],
    };
    expect(isUserAttendingEntry(entry, NICK_CALENDARS)).toBe(false);
  });

  it("tolerates a missing/empty/non-array attendees field", () => {
    expect(isUserAttendingEntry({}, NICK_CALENDARS)).toBe(false);
    expect(isUserAttendingEntry({ attendees: [] }, NICK_CALENDARS)).toBe(false);
    expect(isUserAttendingEntry({ attendees: null }, NICK_CALENDARS)).toBe(false);
    expect(isUserAttendingEntry({ attendees: [null] }, NICK_CALENDARS)).toBe(false);
  });
});

describe("classifyEntryMatch", () => {
  it('labels an entry on the user\'s own calendar "owner"', () => {
    expect(classifyEntryMatch({ calendar_owner: { id: 2882209 } }, NICK_CALENDARS)).toBe("owner");
  });

  it('labels someone else\'s event the user was added to "attendee"', () => {
    const entry = {
      calendar_owner: { id: 555 },
      attendees: [{ id: 9473780, type: "Calendar" }],
    };
    expect(classifyEntryMatch(entry, NICK_CALENDARS)).toBe("attendee");
  });

  it('labels the user\'s own event that also lists them as attendee "both"', () => {
    const entry = {
      calendar_owner: { id: 2882209 },
      attendees: [{ id: 2882209, type: "Calendar" }],
    };
    expect(classifyEntryMatch(entry, NICK_CALENDARS)).toBe("both");
  });

  it("returns null for an unrelated entry so it is filtered out", () => {
    const entry = {
      calendar_owner: { id: 555 },
      attendees: [{ id: 777, type: "Calendar" }],
    };
    expect(classifyEntryMatch(entry, NICK_CALENDARS)).toBeNull();
  });
});
