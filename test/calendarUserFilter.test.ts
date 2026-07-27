import { describe, it, expect } from "vitest";
import { selectUserCalendarIds } from "../src/tools/calendar";

// Regression: get_calendar_entries(user_id=N) was "broken" — it passed the
// raw user_id as `calendar_owner_id`, which is NOT a valid calendar_entries
// list filter in Clio (the filter is `calendar_id`, a Calendar resource ID).
// Clio silently ignored the bogus param and returned EVERY firm entry in the
// date range. Clio's Calendar and User are separate resources: a
// CalendarEntry's `calendar_owner` is a Calendar ID, never a User ID. So
// filtering "by user" means resolving the calendars that user OWNS
// (creator.id === user_id) and filtering on those calendar IDs.
describe("selectUserCalendarIds", () => {
  const calendars = [
    { id: 2882209, name: "Nicholas Noe", creator: { id: 111, name: "Nicholas Noe" } },
    { id: 9473780, name: "NRN - Personal", creator: { id: 111, name: "Nicholas Noe" } },
    { id: 555, name: "Jane Roe", creator: { id: 222, name: "Jane Roe" } },
    { id: 3107359, name: "Firm Deadlines", creator: { id: 999, name: "Firm Admin" } },
  ];

  it("returns ALL calendars owned by the user (a user may own several)", () => {
    expect(selectUserCalendarIds(calendars, 111)).toEqual([2882209, 9473780]);
  });

  it("resolves a User ID to Calendar IDs — never returns the user_id itself", () => {
    const ids = selectUserCalendarIds(calendars, 111);
    // The old bug filtered by the user_id (111) as if it were a calendar id.
    expect(ids).not.toContain(111);
  });

  it("scopes to a single user, excluding other users' calendars", () => {
    expect(selectUserCalendarIds(calendars, 222)).toEqual([555]);
  });

  it("returns [] when the user owns no visible calendar (→ empty result, not everyone's entries)", () => {
    expect(selectUserCalendarIds(calendars, 333)).toEqual([]);
  });

  it("tolerates calendars with a missing/blank creator", () => {
    const withGaps = [
      ...calendars,
      { id: 42, name: "Orphan", creator: null },
      { id: 43, name: "No creator field" },
    ];
    expect(selectUserCalendarIds(withGaps, 111)).toEqual([2882209, 9473780]);
  });

  it("drops calendars with no id rather than emitting null/undefined ids", () => {
    const missingId = [
      { name: "No id", creator: { id: 111 } },
      { id: 2882209, creator: { id: 111 } },
    ];
    expect(selectUserCalendarIds(missingId, 111)).toEqual([2882209]);
  });
});
