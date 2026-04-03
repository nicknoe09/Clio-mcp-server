import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawPatchSingle, rawGetSingle } from "../clio/pagination";

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
}
