import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";

const TIME_ENTRY_FIELDS =
  "id,date,quantity,price,total,note,type,billed,matter{id,display_number,description,client},user{id,name}";

export function registerTimeTools(server: McpServer): void {
  // get_time_entries
  server.tool(
    "get_time_entries",
    "Get time entries with filters. Hours are returned in decimal (quantity from Clio is seconds / 3600).",
    {
      matter_id: z.number().optional().describe("Filter by matter ID"),
      user_id: z.number().optional().describe("Filter by user/timekeeper ID"),
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
    "Get all unbilled time entries grouped by matter with subtotals and firm-wide totals",
    {
      matter_id: z.number().optional().describe("Filter by matter ID"),
      user_id: z.number().optional().describe("Filter by user/timekeeper ID"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          type: "TimeEntry",
          billed: false,
          fields: TIME_ENTRY_FIELDS,
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.user_id) queryParams.user_id = params.user_id;
        if (params.start_date) queryParams.created_since = `${params.start_date}T00:00:00+00:00`;

        const entries = await fetchAllPages<any>("/activities", queryParams);

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
}
