import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawPostSingle, rawPatchSingle, rawGetSingle } from "../clio/pagination";

const TIME_ENTRY_FIELDS =
  "id,date,quantity,price,total,note,type,billed,matter{id,display_number,description,client},user{id,name}";

export function registerTimeTools(server: McpServer): void {
  // get_time_entries
  server.tool(
    "get_time_entries",
    "Get time entries with filters. Hours are returned in decimal (quantity from Clio is seconds / 3600).",
    {
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      user_id: z.coerce.number().optional().describe("Filter by user/timekeeper ID"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      billed: z
        .enum(["true", "false", "all"])
        .optional()
        .default("all")
        .describe("Filter by billed status"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          type: "TimeEntry",
          fields: TIME_ENTRY_FIELDS,
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.user_id) queryParams.user_id = params.user_id;
        // Clio ignores date_from/date_to — use created_since for server-side filtering
        if (params.start_date) queryParams.created_since = `${params.start_date}T00:00:00+00:00`;
        if (params.billed !== "all") queryParams.billed = params.billed === "true";

        let entries = await fetchAllPages<any>("/activities", queryParams);

        // Client-side date filtering (created_since filters by creation, not activity date)
        if (params.start_date) entries = entries.filter((e: any) => e.date >= params.start_date);
        if (params.end_date) entries = entries.filter((e: any) => e.date <= params.end_date);

        const formatted = entries.map((e: any) => ({
          id: e.id,
          date: e.date,
          hours: Math.round((e.quantity / 3600) * 100) / 100,
          rate: e.price,
          amount: Math.round(((e.quantity / 3600) * (e.price || 0)) * 100) / 100,
          description: e.note,
          billed: e.billed,
          matter: e.matter
            ? {
                id: e.matter.id,
                number: e.matter.display_number,
                description: e.matter.description,
                client: e.matter.client,
              }
            : null,
          timekeeper: e.user,
        }));

        const totalHours =
          Math.round(formatted.reduce((s: number, e: any) => s + e.hours, 0) * 100) / 100;
        const totalValue =
          Math.round(formatted.reduce((s: number, e: any) => s + e.amount, 0) * 100) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: formatted.length,
                  total_hours: totalHours,
                  total_value: totalValue,
                  entries: formatted,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: err.message,
                status: err.response?.status,
                clio_error: err.response?.data,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // get_unbilled_time
  server.tool(
    "get_unbilled_time",
    "Get all unbilled time entries grouped by matter with subtotals and firm-wide totals. Requires user_id or matter_id to keep response sizes manageable.",
    {
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      user_id: z.coerce.number().optional().describe("Filter by user/timekeeper ID"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD) — defaults to last 90 days if no user/matter filter"),
    },
    async (params) => {
      try {
        if (!params.user_id && !params.matter_id) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: "Provide user_id or matter_id to filter unbilled time. Use get_user_productivity for firm-wide summaries." }),
            }],
            isError: true,
          };
        }

        const queryParams: Record<string, any> = {
          type: "TimeEntry",
          billed: false,
          fields: TIME_ENTRY_FIELDS,
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.user_id) queryParams.user_id = params.user_id;
        // Default to last 90 days if no start_date provided, to prevent timeouts
        const effectiveStart = params.start_date ?? new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
        queryParams.created_since = `${effectiveStart}T00:00:00+00:00`;

        let entries = await fetchAllPages<any>("/activities", queryParams);
        entries = entries.filter((e: any) => e.date >= effectiveStart);

        // Group by matter
        const byMatter: Record<
          number,
          { matter: any; entries: any[]; total_hours: number; total_value: number }
        > = {};

        for (const e of entries) {
          const mid = e.matter?.id ?? 0;
          if (!byMatter[mid]) {
            byMatter[mid] = {
              matter: e.matter,
              entries: [],
              total_hours: 0,
              total_value: 0,
            };
          }
          const hours = e.quantity / 3600;
          const value = hours * (e.price || 0);
          byMatter[mid].entries.push({
            id: e.id,
            date: e.date,
            hours: Math.round(hours * 100) / 100,
            rate: e.price,
            amount: Math.round(value * 100) / 100,
            description: e.note,
            timekeeper: e.user,
          });
          byMatter[mid].total_hours += hours;
          byMatter[mid].total_value += value;
        }

        const matterGroups = Object.values(byMatter).map((g) => ({
          matter: g.matter,
          entry_count: g.entries.length,
          total_hours: Math.round(g.total_hours * 100) / 100,
          total_value: Math.round(g.total_value * 100) / 100,
          entries: g.entries,
        }));

        matterGroups.sort((a, b) => b.total_value - a.total_value);

        const firmTotalHours =
          Math.round(matterGroups.reduce((s, g) => s + g.total_hours, 0) * 100) / 100;
        const firmTotalValue =
          Math.round(matterGroups.reduce((s, g) => s + g.total_value, 0) * 100) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  firm_totals: {
                    total_entries: entries.length,
                    total_hours: firmTotalHours,
                    total_value: firmTotalValue,
                    matter_count: matterGroups.length,
                  },
                  by_matter: matterGroups,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: err.message,
                status: err.response?.status,
                clio_error: err.response?.data,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // test_update_time_entry — test whether Clio allows PATCH on a time entry (including on draft bills)
  server.tool(
    "test_update_time_entry",
    "Test tool: attempts to update a single time entry's description in Clio via PATCH. Use this to verify whether Clio allows modifications to time entries that are already on draft bills. Reads the entry first, applies the change, then reads again to confirm. Pass dry_run=true to just read the entry without modifying it.",
    {
      activity_id: z.coerce.number().describe("The Clio activity (time entry) ID to update"),
      new_note: z.string().optional().describe("New description/note text for the entry. Required unless dry_run=true."),
      new_rate: z.coerce.number().optional().describe("Optional: new hourly rate to set"),
      new_hours: z.coerce.number().optional().describe("Optional: new hours (will be converted to seconds for Clio)"),
      dry_run: z.enum(["true", "false"]).optional().default("false").describe("If true, just reads the entry without modifying it"),
    },
    async (params) => {
      try {
        // Step 1: Read the current state
        const before = await rawGetSingle(`/activities/${params.activity_id}`, {
          fields: "id,date,quantity,price,total,note,type,billed,matter{id,display_number},user{id,name}",
        });

        const entry = before.data;
        const beforeState = {
          id: entry.id,
          date: entry.date,
          hours: Math.round((entry.quantity / 3600) * 100) / 100,
          rate: entry.price,
          note: entry.note,
          billed: entry.billed,
          matter: entry.matter?.display_number,
          timekeeper: entry.user?.name,
        };

        if (params.dry_run === "true") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ dry_run: true, current_entry: beforeState }, null, 2),
            }],
          };
        }

        if (!params.new_note && params.new_rate === undefined && params.new_hours === undefined) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: "Provide new_note, new_rate, or new_hours (or set dry_run=true to just read)." }),
            }],
            isError: true,
          };
        }

        // Step 2: Attempt the PATCH
        const patchBody: Record<string, any> = {};
        if (params.new_note) patchBody.note = params.new_note;
        if (params.new_rate !== undefined) patchBody.price = params.new_rate;
        if (params.new_hours !== undefined) patchBody.quantity = Math.round(params.new_hours * 3600);

        const patchResult = await rawPatchSingle(`/activities/${params.activity_id}`, {
          data: patchBody,
        });

        // Step 3: Read again to confirm
        const after = await rawGetSingle(`/activities/${params.activity_id}`, {
          fields: "id,date,quantity,price,total,note,type,billed,matter{id,display_number},user{id,name}",
        });

        const afterEntry = after.data;
        const afterState = {
          id: afterEntry.id,
          date: afterEntry.date,
          hours: Math.round((afterEntry.quantity / 3600) * 100) / 100,
          rate: afterEntry.price,
          note: afterEntry.note,
          billed: afterEntry.billed,
          matter: afterEntry.matter?.display_number,
          timekeeper: afterEntry.user?.name,
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: "PATCH succeeded — Clio allowed the update.",
              before: beforeState,
              after: afterState,
              changes_applied: patchBody,
              on_draft_bill: beforeState.billed ? "Entry was marked as billed" : "Entry was unbilled",
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        const clioError = err.response?.data || err.body;

        let interpretation = "Unknown error";
        if (status === 422) interpretation = "Clio rejected the update — entry may be locked (on a finalized bill or otherwise protected).";
        else if (status === 403) interpretation = "Forbidden — insufficient permissions or entry is locked.";
        else if (status === 404) interpretation = "Activity not found — check the ID.";
        else if (status === 400) interpretation = "Bad request — check the field values.";

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              message: `PATCH failed with status ${status}`,
              interpretation,
              status,
              clio_error: clioError,
            }, null, 2),
          }],
          isError: true,
        };
      }
    }
  );

  // apply_entry_revision — apply a single revision to a time entry in Clio
  server.tool(
    "apply_entry_revision",
    "Apply a single revision to a Clio time entry. Used during interactive audit review to update one entry at a time. Can modify the description (note), hourly rate, and/or hours. Returns before/after state for confirmation.",
    {
      activity_id: z.coerce.number().describe("The Clio activity (time entry) ID to update"),
      new_note: z.string().optional().describe("Revised description/note for the entry"),
      new_rate: z.coerce.number().optional().describe("Revised hourly rate"),
      new_hours: z.coerce.number().optional().describe("Revised hours (converted to seconds for Clio)"),
    },
    async (params) => {
      try {
        if (!params.new_note && params.new_rate === undefined && params.new_hours === undefined) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: "Provide at least one of: new_note, new_rate, new_hours" }),
            }],
            isError: true,
          };
        }

        // Read current state
        const before = await rawGetSingle(`/activities/${params.activity_id}`, {
          fields: "id,date,quantity,price,total,note,type,billed,matter{id,display_number,description},user{id,name}",
        });
        const entry = before.data;

        // Build patch
        const patchBody: Record<string, any> = {};
        if (params.new_note) patchBody.note = params.new_note;
        if (params.new_rate !== undefined) patchBody.price = params.new_rate;
        if (params.new_hours !== undefined) patchBody.quantity = Math.round(params.new_hours * 3600);

        // Apply
        await rawPatchSingle(`/activities/${params.activity_id}`, { data: patchBody });

        // Read after
        const after = await rawGetSingle(`/activities/${params.activity_id}`, {
          fields: "id,date,quantity,price,total,note,type,billed,matter{id,display_number,description},user{id,name}",
        });
        const updated = after.data;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              activity_id: params.activity_id,
              matter: entry.matter?.display_number || "Unknown",
              timekeeper: entry.user?.name || "Unknown",
              before: {
                note: entry.note,
                hours: Math.round((entry.quantity / 3600) * 100) / 100,
                rate: entry.price,
              },
              after: {
                note: updated.note,
                hours: Math.round((updated.quantity / 3600) * 100) / 100,
                rate: updated.price,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              activity_id: params.activity_id,
              status,
              message: err.message,
              clio_error: err.response?.data || err.body,
            }, null, 2),
          }],
          isError: true,
        };
      }
    }
  );

  // create_time_entry
  server.tool(
    "create_time_entry",
    "Create a new time entry in Clio. Requires a date, user (timekeeper), matter, and duration. Optionally set the hourly rate and description. The entry is created as non-billable if rate is 0 or omitted, billable otherwise.",
    {
      date: z.string().describe("Date for the time entry (YYYY-MM-DD)"),
      user_id: z.coerce.number().describe("Clio user ID of the timekeeper"),
      matter_id: z.coerce.number().describe("Clio matter ID to log time against"),
      hours: z.coerce.number().describe("Duration in decimal hours (e.g. 1.5 for 1h30m)"),
      note: z.string().optional().describe("Description/narrative for the time entry"),
      rate: z.coerce.number().optional().describe("Hourly rate in dollars. Omit or 0 for non-billable."),
      activity_description_id: z.coerce.number().optional().describe("Clio activity description ID (pre-defined activity type). Optional."),
    },
    async (params) => {
      try {
        const quantity = Math.round(params.hours * 3600); // Clio stores time in seconds
        if (quantity <= 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: "Hours must be greater than 0." }) }],
            isError: true,
          };
        }

        const body: any = {
          data: {
            type: "TimeEntry",
            date: params.date,
            quantity,
            user: { id: params.user_id },
            matter: { id: params.matter_id },
          },
        };

        if (params.note) body.data.note = params.note;
        if (params.rate !== undefined && params.rate > 0) body.data.price = params.rate;
        if (params.activity_description_id) body.data.activity_description = { id: params.activity_description_id };

        const result = await rawPostSingle("/activities", body);
        const entry = result.data;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              activity_id: entry.id,
              date: entry.date,
              hours: Math.round((entry.quantity / 3600) * 100) / 100,
              rate: entry.price,
              note: entry.note,
              matter_id: params.matter_id,
              user_id: params.user_id,
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
              status: err.response?.status || err.statusCode,
              clio_error: err.response?.data || err.body,
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
