import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawPostSingle } from "../clio/pagination";

const CALENDAR_FIELDS =
  "id,summary,description,start_at,end_at,all_day,location,matter{id,display_number},calendar_owner{id,name}";

export function registerCalendarTools(server: McpServer): void {
  // get_calendar_entries
  server.tool(
    "get_calendar_entries",
    "Get calendar entries from Clio. Filter by date range, user, or matter. Use to find scheduled events, hearings, consultations, deadlines.",
    {
      start_date: z.string().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().describe("End date (YYYY-MM-DD)"),
      user_id: z.number().optional().describe("Filter by calendar owner user ID"),
      matter_id: z.number().optional().describe("Filter by matter ID"),
      query: z.string().optional().describe("Search term to filter by summary/description (e.g. 'Potential' for consultation calls)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: CALENDAR_FIELDS,
          from: params.start_date,
          to: params.end_date,
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
          matter: e.matter ? {
            id: e.matter.id,
            number: e.matter.display_number,
          } : null,
          calendar_owner: e.calendar_owner,
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
    "Create a calendar entry in Clio. Use for hearings, deadlines, consultations, meetings. Can link to a matter.",
    {
      summary: z.string().describe("Event title/summary"),
      start_at: z.string().describe("Start datetime (ISO 8601, e.g. 2026-03-25T14:00:00-05:00)"),
      end_at: z.string().describe("End datetime (ISO 8601, e.g. 2026-03-25T15:00:00-05:00)"),
      description: z.string().optional().describe("Event description/notes"),
      location: z.string().optional().describe("Event location"),
      all_day: z.boolean().optional().default(false).describe("Whether this is an all-day event"),
      matter_id: z.number().optional().describe("Link to a Clio matter by ID"),
      calendar_owner_id: z.number().optional().describe("Assign to a specific user (defaults to token owner)"),
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
}
