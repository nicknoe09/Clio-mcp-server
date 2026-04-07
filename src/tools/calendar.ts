import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawPostSingle, rawPatchSingle, rawDeleteSingle } from "../clio/pagination";

const CALENDAR_FIELDS =
  "id,summary,description,start_at,end_at,all_day,location,recurrence_rule,matter{id,display_number},calendar_owner{id,name},calendar_entry_event_type{id,name,color}";

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
  NRN_DEADLINES: 2882389,     // Deadlines (NRN)
  NRN_CANCELLED: 3107359,     // NRN - Cancelled or Reset
  NRN_PERSONAL: 9473359,      // NRN - Personal
  NICHOLAS_NOE: 2882209,      // Nicholas Noe (user calendar)
};

// Patterns to auto-detect hard scheduled events
const HARD_SCHEDULED_PATTERNS = /\b(hearing|trial|deposition|mediation|conference|call|phone|zoom|teams|meeting|oral argument|docket|status conference|pretrial|scheduling)\b/i;

export function registerCalendarTools(server: McpServer): void {
  // get_calendar_entries
  server.tool(
    "get_calendar_entries",
    "Get calendar entries from Clio. Filter by date range, user, or matter. Returns event type and color info.",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      user_id: z.coerce.number().optional().describe("Filter by calendar owner user ID"),
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      query: z.string().optional().describe("Search term to filter by summary/description"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: CALENDAR_FIELDS,
          from: `${params.start_date}T00:00:00+00:00`,
          to: `${params.end_date}T23:59:59+00:00`,
        };
        if (params.user_id) queryParams.calendar_owner_id = params.user_id;
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.query) queryParams.query = params.query;

        const entries = await fetchAllPages<any>("/calendar_entries", queryParams);

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
        }));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: formatted.length,
              period: { start: params.start_date, end: params.end_date },
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
    `Create a calendar entry in Clio. Supports event types for color-coding and calendar assignment.

Event types (use event_type_id or event_type name):
- "hard_scheduled" (ID ${EVENT_TYPES.HARD_SCHEDULED}) — hearings, trials, depositions, mediations, calls, conferences
- "nrn_claude" (ID ${EVENT_TYPES.NRN_CLAUDE}) — default for all Claude-created events
- "trial_hearing" (ID ${EVENT_TYPES.TRIAL_HEARING}) — Trial/Hearing/Depositions/Mediations
- "deadline" (ID ${EVENT_TYPES.DEADLINE}) — Deadlines
- "admin" (ID ${EVENT_TYPES.ADMIN}) — Admin events
- "personal" (ID ${EVENT_TYPES.OUT_PERSONAL}) — Out for Personal

If no event type is specified, Claude-created events default to "nrn_claude". If the summary matches a hard-scheduled pattern (hearing, trial, deposition, etc.), it auto-sets to "hard_scheduled".`,
    {
      summary: z.string().describe("Event title/summary"),
      start_at: z.string().describe("Start datetime (ISO 8601, e.g. 2026-03-25T14:00:00-05:00)"),
      end_at: z.string().describe("End datetime (ISO 8601, e.g. 2026-03-25T15:00:00-05:00)"),
      description: z.string().optional().describe("Event description/notes"),
      location: z.string().optional().describe("Event location"),
      all_day: z.boolean().optional().default(false).describe("Whether this is an all-day event"),
      matter_id: z.coerce.number().optional().describe("Link to a Clio matter by ID"),
      calendar_owner_id: z.coerce.number().optional().describe("Assign to a specific user (defaults to token owner)"),
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
        if (params.calendar_owner_id) body.data.calendar_owner = { id: params.calendar_owner_id };
        if (params.recurrence_rule) body.data.recurrence_rule = params.recurrence_rule;

        // Determine event type
        let eventTypeId: number | null = null;

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
        } else {
          // Auto-detect: hard scheduled events by summary, otherwise default to NRN Claude
          if (HARD_SCHEDULED_PATTERNS.test(params.summary)) {
            eventTypeId = EVENT_TYPES.HARD_SCHEDULED;
          } else {
            eventTypeId = EVENT_TYPES.NRN_CLAUDE;
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
    "Update an existing calendar entry in Clio. Can modify time, summary, description, location, matter, event type, or recurrence. For recurring events, updates the entire series.",
    {
      id: z.coerce.number().describe("Calendar entry ID to update"),
      summary: z.string().optional().describe("Updated event title/summary"),
      start_at: z.string().optional().describe("Updated start datetime (ISO 8601)"),
      end_at: z.string().optional().describe("Updated end datetime (ISO 8601)"),
      description: z.string().optional().describe("Updated event description/notes"),
      location: z.string().optional().describe("Updated event location"),
      all_day: z.boolean().optional().describe("Whether this is an all-day event"),
      matter_id: z.coerce.number().optional().describe("Link to a Clio matter by ID"),
      calendar_owner_id: z.coerce.number().optional().describe("Reassign to a specific user"),
      recurrence_rule: z.string().optional().describe(
        "RRULE for recurring events. Set to empty string to remove recurrence."
      ),
      event_type: z.string().optional().describe(
        "Event type name: 'hard_scheduled', 'nrn_claude', 'trial_hearing', 'deadline', 'admin', 'personal'"
      ),
      event_type_id: z.coerce.number().optional().describe("Direct event type ID (overrides event_type name)"),
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
        if (params.calendar_owner_id !== undefined) body.data.calendar_owner = { id: params.calendar_owner_id };
        if (params.recurrence_rule !== undefined) {
          body.data.recurrence_rule = params.recurrence_rule === "" ? null : params.recurrence_rule;
        }

        // Event type
        if (params.event_type_id) {
          body.data.calendar_entry_event_type = { id: params.event_type_id };
        } else if (params.event_type) {
          const typeMap: Record<string, number> = {
            hard_scheduled: EVENT_TYPES.HARD_SCHEDULED,
            nrn_claude: EVENT_TYPES.NRN_CLAUDE,
            trial_hearing: EVENT_TYPES.TRIAL_HEARING,
            deadline: EVENT_TYPES.DEADLINE,
            admin: EVENT_TYPES.ADMIN,
            personal: EVENT_TYPES.OUT_PERSONAL,
          };
          const typeId = typeMap[params.event_type.toLowerCase()];
          if (typeId) body.data.calendar_entry_event_type = { id: typeId };
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
