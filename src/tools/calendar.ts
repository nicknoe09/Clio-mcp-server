import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawPostSingle, rawPatchSingle, rawDeleteSingle } from "../clio/pagination";
import { getActingClioUserId } from "../clio/actingUser";
import { isActingUserOwner } from "../clio/owner";

// `attendees` is PLURAL — per Clio's OpenAPI, CalendarEntry.attendees is an
// array of Attendee_base. (A singular `attendee` is not a valid field; asking
// for it makes Clio reject the whole request.) Attendee_base.type is an enum
// of "Contact" | "Calendar", so a *person* attendee is identified by their
// CALENDAR id — the same Calendar-vs-User distinction that applies to
// calendar_owner.
const CALENDAR_FIELDS =
  "id,summary,description,start_at,end_at,all_day,location,recurrence_rule,matter{id,display_number},calendar_owner{id,name},calendar_entry_event_type{id,name,color},attendees{id,name,type,email}";

// Per Clio's Calendar schema (OpenAPI Calendar_base): `visible` is a valid
// response field, but `writeable` is NOT — `writeable` is only a query-filter
// param on GET /calendars, not a returned property. Use `permission` for
// read-side write-ability info if needed.
const CALENDAR_LIST_FIELDS = "id,name,color,creator{id,name},visible,permission,type";

// Find the primary Calendar resource owned by a given user. Clio's Calendar
// and User are separate resources — calendar_owner on a CalendarEntry refers
// to a Calendar ID, not a User ID. Each user has at least one Calendar
// (their personal calendar) whose `creator.id` matches their user_id.
// Returns null if none found. If the user has multiple, returns the first
// (Clio orders by id ascending by default; oldest = personal calendar in
// most cases).
async function findUserPrimaryCalendarId(userId: number): Promise<number | null> {
  const calendars = await fetchAllPages<any>("/calendars", {
    fields: "id,name,creator{id,name}",
  });
  const userCalendars = calendars.filter((c: any) => c.creator?.id === userId);
  if (userCalendars.length === 0) return null;
  // Heuristic: prefer a calendar whose name contains the user's name (matches
  // Clio's "John Smith" naming convention for personal calendars). Otherwise
  // return the first (oldest by id) calendar created by this user.
  const creatorName = userCalendars[0].creator?.name || "";
  const named = userCalendars.find((c: any) =>
    creatorName && c.name && c.name.toLowerCase().includes(creatorName.toLowerCase()),
  );
  return (named ?? userCalendars[0]).id;
}

// Pure, unit-testable: given a list of Calendar resources and a User ID,
// return the IDs of every calendar CREATED BY that user. Clio's Calendar and
// User are distinct resources — a CalendarEntry's `calendar_owner` is a
// Calendar ID, never a User ID — so filtering entries "by user" means first
// resolving which calendars that user owns, then filtering on those calendar
// IDs. A user commonly owns more than one calendar, so this returns ALL of
// them (not just the primary).
export function selectUserCalendarIds(calendars: any[], userId: number): number[] {
  return calendars
    .filter((c: any) => c.creator?.id === userId)
    .map((c: any) => c.id)
    .filter((id: any) => id !== undefined && id !== null);
}

// Resolve a User ID to the Calendar IDs that user owns (fetches /calendars,
// then applies selectUserCalendarIds). Returns [] when the firm OAuth user
// can't see any calendar owned by that user.
async function findUserCalendarIds(userId: number): Promise<number[]> {
  const calendars = await fetchAllPages<any>("/calendars", {
    fields: "id,name,creator{id,name}",
  });
  return selectUserCalendarIds(calendars, userId);
}

// Pure: is this entry ON one of the given calendars (i.e. the user OWNS it)?
// Reads calendar_owner{id} and falls back to the flat calendar_owner_id field
// (both are on Clio's CalendarEntry response model).
export function isEntryOwnedBy(entry: any, calendarIds: Set<number>): boolean {
  const ownerId = entry?.calendar_owner?.id ?? entry?.calendar_owner_id;
  return ownerId != null && calendarIds.has(ownerId);
}

// Pure: is the user an ATTENDEE on this entry (someone else's event they were
// invited to / assigned)? Only attendees of type "Calendar" are people at the
// firm — per Clio's Attendee_base enum, the other type is "Contact" (clients,
// opposing counsel), whose ids are Contact ids and must NOT be compared
// against calendar ids.
export function isUserAttendingEntry(entry: any, calendarIds: Set<number>): boolean {
  const attendees = Array.isArray(entry?.attendees) ? entry.attendees : [];
  return attendees.some(
    (a: any) => a?.type === "Calendar" && a?.id != null && calendarIds.has(a.id),
  );
}

// Pure: why did this entry match — because the user owns the calendar it sits
// on, because they're an attendee on someone else's, or both? Returns null
// when the entry doesn't involve the user at all. Callers surface this as
// `match` so a tickler can tell "my event" from "I was added to this".
export function classifyEntryMatch(
  entry: any,
  calendarIds: Set<number>,
): "owner" | "attendee" | "both" | null {
  const owned = isEntryOwnedBy(entry, calendarIds);
  const attending = isUserAttendingEntry(entry, calendarIds);
  if (owned && attending) return "both";
  if (owned) return "owner";
  if (attending) return "attendee";
  return null;
}

// RomSum event type IDs (from /calendar_entry_event_types)
const EVENT_TYPES = {
  HARD_SCHEDULED: 738410,     // NRN Hard Scheduled Event — hearings, trials, depositions, mediations, calls
  NRN_CLAUDE: 738425,         // NRN Claude Events — all Claude-created events
  TRIAL_HEARING: 18276,       // Trial/Hearing/Depositions/Mediations
  DEADLINE: 199985,           // Deadline
  ADMIN: 324949,              // Admin
  OUT_PERSONAL: 101584,       // Out for Personal
};

// NRN calendar IDs
const NRN_CALENDARS = {
  NRN_CLAUDE: 10217705,       // NRN - Claude Created (adhoc calendar)
  NRN_DEADLINES: 2882389,     // Deadlines (NRN)
  NRN_CANCELLED: 3107359,     // NRN - Cancelled or Reset
  NRN_PERSONAL: 9473780,      // NRN - Personal
  NICHOLAS_NOE: 2882209,      // Nicholas Noe (user calendar)
};

export function registerCalendarTools(server: McpServer): void {
  // list_calendars — lookup utility for resolving Calendar IDs.
  // Clio's CalendarEntry.calendar_owner is a Calendar ID, not a User ID.
  // Use this tool to find the right ID before calling create_calendar_entry
  // or update_calendar_entry (or use assign_to_user_id which calls this
  // internally).
  server.tool(
    "list_calendars",
    "List all Clio Calendar resources visible to the firm OAuth user. Each Calendar has a numeric `id` (used as calendar_owner on CalendarEntry) and a `creator` (the User who owns the calendar). Use this to find the right calendar_id to assign events to — passing a User ID where Clio expects a Calendar ID returns 404. Filter results by creator_user_id to find a user's personal calendar.",
    {
      creator_user_id: z.coerce.number().optional().describe("Optional: filter to calendars created by a specific Clio user (e.g. find a user's personal calendar). If omitted, returns ALL calendars visible to the firm OAuth user (firm calendars, deadlines, all user calendars)."),
      writeable_only: z.boolean().optional().default(false).describe("If true, return only calendars the firm OAuth user can write to."),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: CALENDAR_LIST_FIELDS,
        };
        if (params.writeable_only) queryParams.writeable = true;
        const calendars = await fetchAllPages<any>("/calendars", queryParams);
        const filtered = params.creator_user_id !== undefined
          ? calendars.filter((c: any) => c.creator?.id === params.creator_user_id)
          : calendars;
        const formatted = filtered.map((c: any) => ({
          id: c.id,
          name: c.name,
          color: c.color,
          type: c.type,
          visible: c.visible,
          permission: c.permission,
          creator: c.creator ? { id: c.creator.id, name: c.creator.name } : null,
        }));
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: formatted.length,
              filter: params.creator_user_id !== undefined
                ? `creator_user_id=${params.creator_user_id}`
                : "none",
              calendars: formatted,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: err.message,
              status: err.response?.status,
              clio_error: err.response?.data,
            }),
          }],
          isError: true,
        };
      }
    },
  );

  // get_calendar_entries
  server.tool(
    "get_calendar_entries",
    "Get calendar entries from Clio. Filter by date range, user, or matter. Returns event type and color info.",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      user_id: z.coerce.number().optional().describe("Filter to entries owned by a Clio **User** (pass the User ID). The tool resolves that user to the Calendar(s) they own and filters on those. Clio's calendar_entries list filter is `calendar_id` (a Calendar resource), NOT a User ID — passing the raw user_id as a calendar filter matches nothing and Clio silently returns every firm entry, so this resolution step is required."),
      include_attending: z.boolean().optional().default(true).describe("ON BY DEFAULT. Returns entries on calendars the user owns AND entries on OTHER people's calendars where the user is an attendee (events someone else calendared and added them to) — because both are genuinely \"their events\". Each returned entry carries `match`: \"owner\", \"attendee\", or \"both\". Clio has NO attendee query filter, so the attendee half is found by sweeping the date range and matching `attendees[]` client-side; keep the date range tight on large firms. Pass false to get ONLY calendars the user owns, which filters server-side via calendar_id and reads far less data. Only applies when user_id is set."),
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      query: z.string().optional().describe("Search term to filter by summary/description"),
    },
    async (params) => {
      try {
        const baseParams: Record<string, any> = {
          fields: CALENDAR_FIELDS,
          from: `${params.start_date}T00:00:00+00:00`,
          to: `${params.end_date}T23:59:59+00:00`,
        };
        if (params.matter_id) baseParams.matter_id = params.matter_id;
        if (params.query) baseParams.query = params.query;

        // NOTE: include_attending is ON BY DEFAULT, so it must NOT be an error
        // to omit user_id — that combination is simply "no user to match
        // attendees against", and the no-user_id path already returns every
        // visible entry (a superset of anything attendee matching could add).
        // The reported `scope` says which path ran.

        // user_id → calendar_id(s). Clio's calendar_entries index filters by
        // `calendar_id` (a Calendar resource ID). The old code passed the raw
        // user_id as `calendar_owner_id`, which is NOT a valid list filter, so
        // Clio ignored it and returned EVERY firm entry in the date range —
        // the "broken" filter. Resolve the user's owned calendars and query
        // each (a user can own several calendars, and the list filter takes a
        // single calendar_id), merging results and de-duplicating by entry id.
        let entries: any[];
        const matchByEntryId = new Map<number, "owner" | "attendee" | "both">();
        if (params.user_id) {
          const calendarIds = await findUserCalendarIds(params.user_id);
          if (calendarIds.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  count: 0,
                  period: { start: params.start_date, end: params.end_date },
                  entries: [],
                  // Attendee matching keys off calendar ids too (a person
                  // attendee is Attendee_base.type "Calendar"), so with no
                  // resolvable calendar there is nothing to match on EITHER
                  // side — ownership or attendance.
                  note: `No calendar owned by user ${params.user_id} is visible to the firm OAuth user, so no entries match — neither events they own nor events they attend (attendee identity is also a Calendar id). Use list_calendars(creator_user_id=${params.user_id}) to inspect what's available.`,
                }, null, 2),
              }],
            };
          }
          if (params.include_attending) {
            // Clio exposes NO attendee filter on /calendar_entries (verified
            // against the OpenAPI spec — the only ownership-ish filter is
            // calendar_id), so catching "events someone ELSE calendared me
            // onto" requires sweeping the range once and matching
            // attendees[] client-side. One unfiltered sweep is cheaper than
            // per-calendar queries plus a sweep, and it catches both cases.
            const calendarIdSet = new Set(calendarIds);
            const swept = await fetchAllPages<any>("/calendar_entries", baseParams);
            entries = [];
            for (const e of swept) {
              const match = classifyEntryMatch(e, calendarIdSet);
              if (match) {
                matchByEntryId.set(e.id, match);
                entries.push(e);
              }
            }
          } else {
            // Owned-only (default): filter server-side by calendar_id, which
            // is far less data than sweeping the whole firm's range.
            const seen = new Set<number>();
            entries = [];
            for (const calendarId of calendarIds) {
              const page = await fetchAllPages<any>("/calendar_entries", {
                ...baseParams,
                calendar_id: calendarId,
              });
              for (const e of page) {
                if (!seen.has(e.id)) {
                  seen.add(e.id);
                  matchByEntryId.set(e.id, "owner");
                  entries.push(e);
                }
              }
            }
          }
        } else {
          entries = await fetchAllPages<any>("/calendar_entries", baseParams);
        }

        const formatted = entries.map((e: any) => ({
          id: e.id,
          summary: e.summary,
          description: e.description,
          start_at: e.start_at,
          end_at: e.end_at,
          all_day: e.all_day,
          location: e.location,
          recurrence_rule: e.recurrence_rule,
          matter: e.matter ? {
            id: e.matter.id,
            number: e.matter.display_number,
          } : null,
          calendar_owner: e.calendar_owner,
          event_type: e.calendar_entry_event_type ? {
            id: e.calendar_entry_event_type.id,
            name: e.calendar_entry_event_type.name,
            color: e.calendar_entry_event_type.color,
          } : null,
          attendees: Array.isArray(e.attendees)
            ? e.attendees.map((a: any) => ({
                id: a.id,
                name: a.name,
                // "Calendar" = a person at the firm; "Contact" = client /
                // third party. The id namespace differs per type.
                type: a.type,
                email: a.email,
              }))
            : [],
          // Only meaningful when user_id was supplied; tells a tickler whether
          // this is the user's own event or one they were added to.
          ...(matchByEntryId.has(e.id) ? { match: matchByEntryId.get(e.id) } : {}),
        }));

        const attendeeOnlyCount = formatted.filter((e: any) => e.match === "attendee").length;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: formatted.length,
              period: { start: params.start_date, end: params.end_date },
              scope: params.user_id
                ? (params.include_attending
                    ? "calendars owned by the user + entries they attend on others' calendars"
                    : "calendars owned by the user ONLY — include_attending=false, so events others calendared them onto are excluded")
                : "all calendars visible to the firm OAuth user (no user_id given)",
              ...(params.include_attending ? { attendee_only_count: attendeeOnlyCount } : {}),
              entries: formatted,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: err.message,
              status: err.response?.status,
              clio_error: err.response?.data,
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // create_calendar_entry
  server.tool(
    "create_calendar_entry",
    `Create a calendar entry in Clio. By default the entry lands on YOUR OWN personal Clio calendar.

OWNER-ONLY: the custom event types below only apply when the acting user is the configured owner (the attorney the custom tooling was built for); for every other user event_type / event_type_id are IGNORED. Calendar placement (calendar_owner_id / assign_to_user_id, or the default of your own personal calendar) works for ALL users — Clio enforces write permission on the target calendar.

Event type is OPT-IN — if you don't pass event_type or event_type_id, the entry is created with NO event type (the bare calendar entry). Pass an explicit event_type only if the caller asked for one.

Event types (owner-only; use event_type_id or event_type name):
- "hard_scheduled" (ID ${EVENT_TYPES.HARD_SCHEDULED}) — hearings, trials, depositions, mediations, calls, conferences
- "nrn_claude" (ID ${EVENT_TYPES.NRN_CLAUDE}) — NRN Claude Events tag
- "trial_hearing" (ID ${EVENT_TYPES.TRIAL_HEARING}) — Trial/Hearing/Depositions/Mediations
- "deadline" (ID ${EVENT_TYPES.DEADLINE}) — Deadlines
- "admin" (ID ${EVENT_TYPES.ADMIN}) — Admin events
- "personal" (ID ${EVENT_TYPES.OUT_PERSONAL}) — Out for Personal`,
    {
      summary: z.string().describe("Event title/summary"),
      start_at: z.string().describe("Start datetime (ISO 8601, e.g. 2026-03-25T14:00:00-05:00)"),
      end_at: z.string().describe("End datetime (ISO 8601, e.g. 2026-03-25T15:00:00-05:00)"),
      description: z.string().optional().describe("Event description/notes"),
      location: z.string().optional().describe("Event location"),
      all_day: z.boolean().optional().default(false).describe("Whether this is an all-day event"),
      matter_id: z.coerce.number().optional().describe("Link to a Clio matter by ID"),
      calendar_owner_id: z.coerce.number().optional().describe("**Calendar ID** (NOT user ID) — Clio's calendar_owner field expects the numeric ID of a Calendar resource. Use list_calendars to discover IDs. To assign to a user's personal calendar, prefer assign_to_user_id (next param) which looks the right calendar up automatically. If neither is provided, defaults to YOUR OWN (the acting attorney's) personal calendar."),
      assign_to_user_id: z.coerce.number().optional().describe("Convenience: provide a Clio User ID, and the tool will look up that user's personal calendar (via list_calendars / creator filter) and use its calendar_id automatically. Overrides calendar_owner_id when both are set. If the user has no calendar visible to the firm OAuth user, the call fails before any event is created (with a clear error) rather than silently falling back to a default."),
      recurrence_rule: z.string().optional().describe(
        "RRULE for recurring events (e.g. 'FREQ=WEEKLY;BYDAY=MO,WE,FR', 'FREQ=MONTHLY;BYMONTHDAY=15')"
      ),
      event_type: z.string().optional().describe(
        "Event type name: 'hard_scheduled', 'nrn_claude', 'trial_hearing', 'deadline', 'admin', 'personal'. Auto-detected from summary if not specified."
      ),
      event_type_id: z.coerce.number().optional().describe("Direct event type ID (overrides event_type name)"),
    },
    async (params) => {
      try {
        const body: any = {
          data: {
            summary: params.summary,
            start_at: params.start_at,
            end_at: params.end_at,
            all_day: params.all_day,
          },
        };
        if (params.description) body.data.description = params.description;
        if (params.location) body.data.location = params.location;
        if (params.matter_id) body.data.matter = { id: params.matter_id };

        // Only the custom NRN/RomSum EVENT TYPES are owner-only. Calendar
        // targeting (assign_to_user_id / calendar_owner_id) is available to
        // everyone — Clio itself enforces write permission on the target
        // calendar, so a user can only reassign to calendars they own or can
        // write to. Non-owners who pass an event type get it ignored (and told
        // so); their calendar targeting is honored.
        const isOwner = await isActingUserOwner();
        const ignoredForNonOwner: string[] = [];
        if (!isOwner) {
          if (params.event_type !== undefined) ignoredForNonOwner.push("event_type");
          if (params.event_type_id !== undefined) ignoredForNonOwner.push("event_type_id");
        }

        // Resolve calendar_owner. Priority:
        //   1. assign_to_user_id (look up that user's primary calendar)
        //   2. calendar_owner_id (explicit Calendar ID)
        //   3. DEFAULT → the ACTING attorney's own primary calendar (not a
        //      hardcoded calendar — that silently put everyone's events on one
        //      person's calendar). Fail loudly if it can't be resolved rather
        //      than misattributing.
        let calendarOwnerId: number;
        if (params.assign_to_user_id !== undefined) {
          const resolved = await findUserPrimaryCalendarId(params.assign_to_user_id);
          if (resolved === null) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message: `No calendar found for user ${params.assign_to_user_id}. The firm OAuth user may not have visibility to that user's calendar, or the user has no Calendar resource yet. Use list_calendars to inspect what's available, or pass calendar_owner_id directly with the desired Calendar ID.`,
                  context: "user_calendar_not_found",
                  assign_to_user_id: params.assign_to_user_id,
                }, null, 2),
              }],
              isError: true,
            };
          }
          calendarOwnerId = resolved;
        } else if (params.calendar_owner_id !== undefined) {
          calendarOwnerId = params.calendar_owner_id;
        } else {
          const actingId = await getActingClioUserId();
          const resolved = await findUserPrimaryCalendarId(actingId);
          if (resolved === null) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message: `Could not find your own calendar (acting Clio user ${actingId}), so the event was not created (to avoid putting it on the wrong calendar). Pass calendar_owner_id with the desired Calendar ID, or assign_to_user_id, or check list_calendars.`,
                  context: "acting_user_calendar_not_found",
                  acting_user_id: actingId,
                }, null, 2),
              }],
              isError: true,
            };
          }
          calendarOwnerId = resolved;
        }
        body.data.calendar_owner = { id: calendarOwnerId };
        if (params.recurrence_rule) body.data.recurrence_rule = params.recurrence_rule;

        // Event type is opt-in AND owner-only. Do NOT auto-detect or default;
        // user-side policy is "only set an event type when explicitly asked."
        // The previous version auto-set NRN_CLAUDE (or HARD_SCHEDULED for
        // pattern-matching summaries) — that ran against the user's intent
        // and ended up tagging every Claude-created event with a type the
        // user didn't choose. For non-owners the custom event types don't
        // apply at all, so this block is skipped.
        let eventTypeId: number | null = null;
        if (isOwner) {
          if (params.event_type_id) {
            eventTypeId = params.event_type_id;
          } else if (params.event_type) {
            const typeMap: Record<string, number> = {
              hard_scheduled: EVENT_TYPES.HARD_SCHEDULED,
              nrn_claude: EVENT_TYPES.NRN_CLAUDE,
              trial_hearing: EVENT_TYPES.TRIAL_HEARING,
              deadline: EVENT_TYPES.DEADLINE,
              admin: EVENT_TYPES.ADMIN,
              personal: EVENT_TYPES.OUT_PERSONAL,
            };
            eventTypeId = typeMap[params.event_type.toLowerCase()] || null;
          }
        }
        if (eventTypeId) {
          body.data.calendar_entry_event_type = { id: eventTypeId };
        }

        const result = await rawPostSingle("/calendar_entries", body);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              created: true,
              calendar_entry: {
                id: result.data?.id,
                summary: result.data?.summary,
                start_at: result.data?.start_at,
                end_at: result.data?.end_at,
                matter_id: result.data?.matter?.id,
                recurrence_rule: result.data?.recurrence_rule,
                event_type: result.data?.calendar_entry_event_type,
              },
              ...(ignoredForNonOwner.length > 0
                ? {
                    note: "Custom event types are owner-only, so the following inputs were ignored. Calendar placement (calendar_owner_id / assign_to_user_id / default) was applied as normal.",
                    ignored: ignoredForNonOwner,
                  }
                : {}),
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: err.message,
              status: err.response?.status,
              clio_error: err.response?.data,
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // update_calendar_entry
  server.tool(
    "update_calendar_entry",
    "Update an existing calendar entry in Clio. Can modify time, summary, description, location, matter, or recurrence. For recurring events, updates the entire series. Reassigning to another calendar (calendar_owner_id / assign_to_user_id) works for ALL users — Clio enforces write permission on the target calendar. OWNER-ONLY: setting/clearing custom event types (event_type / event_type_id) only applies when the acting user is the configured owner; for every other user those inputs are ignored.",
    {
      id: z.coerce.number().describe("Calendar entry ID to update"),
      summary: z.string().optional().describe("Updated event title/summary"),
      start_at: z.string().optional().describe("Updated start datetime (ISO 8601)"),
      end_at: z.string().optional().describe("Updated end datetime (ISO 8601)"),
      description: z.string().optional().describe("Updated event description/notes"),
      location: z.string().optional().describe("Updated event location"),
      all_day: z.boolean().optional().describe("Whether this is an all-day event"),
      matter_id: z.coerce.number().optional().describe("Link to a Clio matter by ID"),
      calendar_owner_id: z.coerce.number().optional().describe("**Calendar ID** (NOT user ID) to reassign the entry to. Use list_calendars to discover IDs. To reassign to a user's personal calendar, prefer assign_to_user_id (next param)."),
      assign_to_user_id: z.coerce.number().optional().describe("Convenience: provide a Clio User ID, and the tool will look up that user's personal calendar and reassign to it. Overrides calendar_owner_id when both are set. Fails loudly with a clear error if the user has no calendar visible to the firm OAuth user."),
      recurrence_rule: z.string().optional().describe(
        "RRULE for recurring events. Set to empty string to remove recurrence."
      ),
      event_type: z.string().optional().describe(
        "Event type name: 'hard_scheduled', 'nrn_claude', 'trial_hearing', 'deadline', 'admin', 'personal'. Pass 'none' (or empty string) to CLEAR an existing event_type (set to null on the calendar entry)."
      ),
      event_type_id: z.coerce.number().optional().describe("Direct event type ID (overrides event_type name). Pass 0 or a negative number to CLEAR an existing event_type."),
    },
    async (params) => {
      try {
        const body: any = { data: {} };
        if (params.summary !== undefined) body.data.summary = params.summary;
        if (params.start_at !== undefined) body.data.start_at = params.start_at;
        if (params.end_at !== undefined) body.data.end_at = params.end_at;
        if (params.description !== undefined) body.data.description = params.description;
        if (params.location !== undefined) body.data.location = params.location;
        if (params.all_day !== undefined) body.data.all_day = params.all_day;
        if (params.matter_id !== undefined) body.data.matter = { id: params.matter_id };

        // Only the custom NRN/RomSum EVENT TYPES are owner-only. Reassignment
        // (assign_to_user_id / calendar_owner_id) is available to everyone —
        // Clio enforces write permission on the target calendar, so a user can
        // only move an entry to a calendar they own or can write to. Non-owners
        // who pass an event type get it ignored (and told so); their
        // reassignment is honored.
        const isOwner = await isActingUserOwner();
        const ignoredForNonOwner: string[] = [];
        if (!isOwner) {
          if (params.event_type !== undefined) ignoredForNonOwner.push("event_type");
          if (params.event_type_id !== undefined) ignoredForNonOwner.push("event_type_id");
        }

        // Resolve calendar_owner reassignment. assign_to_user_id takes priority.
        if (params.assign_to_user_id !== undefined) {
          const resolved = await findUserPrimaryCalendarId(params.assign_to_user_id);
          if (resolved === null) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message: `No calendar found for user ${params.assign_to_user_id}. Use list_calendars to inspect what's available, or pass calendar_owner_id directly with the desired Calendar ID.`,
                  context: "user_calendar_not_found",
                  assign_to_user_id: params.assign_to_user_id,
                }, null, 2),
              }],
              isError: true,
            };
          }
          body.data.calendar_owner = { id: resolved };
        } else if (params.calendar_owner_id !== undefined) {
          body.data.calendar_owner = { id: params.calendar_owner_id };
        }
        if (params.recurrence_rule !== undefined) {
          body.data.recurrence_rule = params.recurrence_rule === "" ? null : params.recurrence_rule;
        }

        // Event type. Owner-only. Sentinel values clear an existing event_type:
        //   event_type_id <= 0  → null (clear)
        //   event_type in {"", "none", "null"}  → null (clear)
        // Otherwise: lookup by name or use the explicit id.
        if (isOwner && params.event_type_id !== undefined) {
          body.data.calendar_entry_event_type = params.event_type_id > 0
            ? { id: params.event_type_id }
            : null;
        } else if (isOwner && params.event_type !== undefined) {
          const lower = params.event_type.toLowerCase();
          if (lower === "" || lower === "none" || lower === "null") {
            body.data.calendar_entry_event_type = null;
          } else {
            const typeMap: Record<string, number> = {
              hard_scheduled: EVENT_TYPES.HARD_SCHEDULED,
              nrn_claude: EVENT_TYPES.NRN_CLAUDE,
              trial_hearing: EVENT_TYPES.TRIAL_HEARING,
              deadline: EVENT_TYPES.DEADLINE,
              admin: EVENT_TYPES.ADMIN,
              personal: EVENT_TYPES.OUT_PERSONAL,
            };
            const typeId = typeMap[lower];
            if (typeId) body.data.calendar_entry_event_type = { id: typeId };
          }
        }

        const result = await rawPatchSingle(`/calendar_entries/${params.id}`, body);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              updated: true,
              calendar_entry: {
                id: result.data?.id,
                summary: result.data?.summary,
                start_at: result.data?.start_at,
                end_at: result.data?.end_at,
                matter_id: result.data?.matter?.id,
                recurrence_rule: result.data?.recurrence_rule,
                event_type: result.data?.calendar_entry_event_type,
              },
              ...(ignoredForNonOwner.length > 0
                ? {
                    note: "Custom event types are owner-only, so the following inputs were ignored. Reassignment (calendar_owner_id / assign_to_user_id) was applied as normal.",
                    ignored: ignoredForNonOwner,
                  }
                : {}),
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: err.message,
              status: err.response?.status,
              clio_error: err.response?.data,
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // delete_calendar_entry
  server.tool(
    "delete_calendar_entry",
    "Delete a calendar entry from Clio. This permanently removes the event. For recurring events, deletes the entire series.",
    {
      id: z.coerce.number().describe("Calendar entry ID to delete"),
    },
    async (params) => {
      try {
        await rawDeleteSingle(`/calendar_entries/${params.id}`);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ deleted: true, id: params.id }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: err.message,
              status: err.response?.status,
              clio_error: err.response?.data,
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
