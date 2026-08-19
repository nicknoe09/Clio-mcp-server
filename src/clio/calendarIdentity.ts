import { fetchAllPages } from "./pagination";

/**
 * Calendar-vs-User identity, in one place.
 *
 * Clio models Calendar and User as SEPARATE resources, and the API surfaces
 * calendars where you might reasonably expect users:
 *   - CalendarEntry.calendar_owner is a **Calendar**, not a User.
 *   - CalendarEntry.attendees[] is an array of Attendee_base whose `type` is
 *     "Contact" | "Calendar" — so a *person* attendee is identified by their
 *     **Calendar** id, and "Contact" attendees (clients, opposing counsel)
 *     carry Contact ids from an entirely different namespace.
 *
 * Comparing a Clio User ID against either of those silently matches nothing.
 * That mistake has now produced two separate bugs in this server (the
 * get_calendar_entries user_id filter, and the scorecard "potential calls"
 * metric), so the mapping lives here rather than being re-derived per caller.
 */

/**
 * Pure: build a Calendar ID → owning User ID map from /calendars records.
 * A calendar's owner is its `creator`.
 */
export function buildCalendarIdToUserId(calendars: any[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const c of calendars) {
    const calendarId = c?.id;
    const userId = c?.creator?.id;
    if (calendarId != null && userId != null) map.set(calendarId, userId);
  }
  return map;
}

/**
 * Pure: resolve a CalendarEntry's attendees to the Clio USER ids of the
 * firm people on it. Attendees of type "Contact" are skipped — their ids are
 * Contact ids, and treating them as calendar ids produces false matches when
 * the numbers happen to collide.
 *
 * Returns a de-duplicated array (an entry can list the same person via more
 * than one calendar).
 */
export function resolveAttendeeUserIds(
  entry: any,
  calendarIdToUserId: Map<number, number>,
): number[] {
  const attendees = Array.isArray(entry?.attendees) ? entry.attendees : [];
  const userIds = new Set<number>();
  for (const a of attendees) {
    if (a?.type !== "Calendar") continue;
    const userId = a?.id != null ? calendarIdToUserId.get(a.id) : undefined;
    if (userId != null) userIds.add(userId);
  }
  return [...userIds];
}

/**
 * Fetch /calendars and build the Calendar ID → User ID map. Kept separate
 * from the pure helper so callers can unit-test the mapping without HTTP.
 */
export async function fetchCalendarIdToUserId(): Promise<Map<number, number>> {
  const calendars = await fetchAllPages<any>("/calendars", {
    fields: "id,name,creator{id,name}",
  });
  return buildCalendarIdToUserId(calendars);
}

/**
 * The `fields` value needed to get attendee data back on a CalendarEntry.
 * NOTE: `attendees` is PLURAL. A singular `attendee` field does not exist in
 * Clio's schema, and asking for it makes Clio reject the entire request —
 * which is exactly how the scorecard's potential-calls metric silently read
 * zero for every timekeeper.
 */
export const ATTENDEE_FIELDS = "attendees{id,name,type,email}";
