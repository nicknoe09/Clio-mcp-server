import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { rawPatchSingle } from "../clio/pagination";
import { readCSV, writeCSV } from "../routes/review";

export function registerReviewTools(server: McpServer): void {
  server.tool(
    "apply_pending_changes",
    "Apply accepted/edited time entry revisions from the /review UI to Clio. Reads pending.csv, PATCHes each accepted or edited entry, and returns a summary. Use dry_run=true to preview without modifying Clio.",
    {
      dry_run: z.enum(["true", "false"]).optional().default("false").describe("If true, preview changes without applying them"),
    },
    async (params) => {
      try {
        const rows = readCSV();
        const toApply = rows.filter((r) => r.status === "accepted" || r.status === "edited");
        const skippedRows = rows.filter((r) => r.status === "skipped");
        const pendingRows = rows.filter((r) => r.status === "pending");

        if (toApply.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                message: "No accepted or edited entries to apply.",
                total_rows: rows.length,
                pending: pendingRows.length,
                skipped: skippedRows.length,
              }, null, 2),
            }],
          };
        }

        if (params.dry_run === "true") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                dry_run: true,
                would_apply: toApply.map((r) => ({
                  activity_id: r.activity_id,
                  matter: r.matter_name,
                  date: r.date,
                  current_note: r.current_note,
                  selected_note: r.selected_note,
                  status: r.status,
                })),
                would_skip: skippedRows.length,
                pending: pendingRows.length,
              }, null, 2),
            }],
          };
        }

        // Apply changes
        let patched = 0;
        const errors: string[] = [];

        for (const row of toApply) {
          try {
            await rawPatchSingle(`/activities/${row.activity_id}`, {
              data: { note: row.selected_note },
            });
            patched++;
          } catch (err: any) {
            errors.push(`Activity ${row.activity_id} (${row.matter_name}): ${err.message}`);
          }
        }

        // Clear CSV on success
        if (errors.length === 0) {
          writeCSV([]);
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              patched,
              skipped: skippedRows.length,
              pending: pendingRows.length,
              errors: errors.length > 0 ? errors : undefined,
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
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
