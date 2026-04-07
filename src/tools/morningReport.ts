import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";

// NRN Hard Scheduled Event type ID
const HARD_SCHEDULED_EVENT_TYPE_ID = 738410;
const HARD_SCHEDULED_PATTERNS = /\b(hearing|trial|deposition|mediation|conference|call|phone|zoom|teams|meeting|oral argument|docket|status conference|pretrial|scheduling|appointment)\b/i;

// NRN user ID
const NRN_USER_ID = 348755029;
// NRN calendar IDs
const NRN_CALENDAR_ID = 2882209;
const NRN_CLAUDE_CALENDAR_ID = 10217705;

export function registerMorningReportTools(server: McpServer): void {
  server.tool(
    "get_todays_events",
    "Get today's calendar events for a user with reliable date filtering. Returns only events with hard start times (not all-day). Flags events within 1 hour as 'imminent'. Also flags events that look hard-scheduled but aren't typed as NRN Hard Scheduled Event.",
    {
      user_id: z.coerce.number().optional().describe("User ID. Defaults to Nicholas Noe (348755029)."),
      date: z.string().optional().describe("Date to query (YYYY-MM-DD). Defaults to today."),
      include_all_day: z.boolean().optional().default(false).describe("Include all-day events"),
    },
    async (params) => {
      try {
        const userId = params.user_id || NRN_USER_ID;
        const today = params.date || new Date().toISOString().split("T")[0];
        const now = new Date();

        // Query with explicit date bounds in CST
        const entries = await fetchAllPages<any>("/calendar_entries", {
          fields: "id,summary,description,start_at,end_at,all_day,location,matter{id,display_number,description},calendar_owner{id,name},calendar_entry_event_type{id,name,color}",
          from: `${today}T00:00:00-06:00`,
          to: `${today}T23:59:59-06:00`,
        });

        // Filter to this user's calendars (user calendar + adhoc calendars they own)
        const userCalendarIds = new Set([userId, NRN_CALENDAR_ID, NRN_CLAUDE_CALENDAR_ID]);
        let filtered = entries.filter((e: any) => userCalendarIds.has(e.calendar_owner?.id));

        // Double-check date filtering — only include events that actually start today
        filtered = filtered.filter((e: any) => {
          if (!e.start_at) return false;
          const startDate = e.start_at.split("T")[0];
          return startDate === today;
        });

        // Filter out all-day unless requested
        if (!params.include_all_day) {
          filtered = filtered.filter((e: any) => !e.all_day);
        }

        // Sort by start time
        filtered.sort((a: any, b: any) => (a.start_at || "").localeCompare(b.start_at || ""));

        const events = filtered.map((e: any) => {
          const startTime = new Date(e.start_at);
          const minutesUntil = Math.round((startTime.getTime() - now.getTime()) / 60000);
          const isImminent = minutesUntil > 0 && minutesUntil <= 60;
          const isPast = minutesUntil < 0;

          const currentType = e.calendar_entry_event_type;
          const isHardPattern = HARD_SCHEDULED_PATTERNS.test(e.summary || "");
          const isTypedHard = currentType?.id === HARD_SCHEDULED_EVENT_TYPE_ID;
          const needsHardTag = isHardPattern && !isTypedHard;

          return {
            id: e.id,
            summary: e.summary,
            description: e.description,
            start_at: e.start_at,
            end_at: e.end_at,
            all_day: e.all_day,
            location: e.location,
            matter: e.matter ? `${e.matter.display_number} — ${e.matter.description || ""}` : null,
            event_type: currentType ? { id: currentType.id, name: currentType.name } : null,
            is_imminent: isImminent,
            is_past: isPast,
            minutes_until: minutesUntil,
            needs_hard_scheduled_tag: needsHardTag,
          };
        });

        const imminent = events.filter((e: any) => e.is_imminent);
        const needsTag = events.filter((e: any) => e.needs_hard_scheduled_tag);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              date: today,
              total_events: events.length,
              imminent_count: imminent.length,
              needs_hard_tag_count: needsTag.length,
              events,
              _notes: {
                imminent: imminent.length > 0
                  ? `${imminent.length} event(s) starting within the next hour`
                  : "No imminent events",
                needs_tag: needsTag.length > 0
                  ? `${needsTag.length} event(s) look hard-scheduled but aren't typed. Ask user if they want to update with event_type: "hard_scheduled".`
                  : null,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: true, message: err.message, status: err.response?.status }),
          }],
          isError: true,
        };
      }
    }
  );
}
