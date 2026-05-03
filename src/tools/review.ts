import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { patchTimeEntrySmart } from "../clio/lineItems";
import { readCSV, writeCSV } from "../routes/review";

export function registerReviewTools(server: McpServer): void {
  server.tool(
    "apply_pending_changes",
    "Apply accepted/edited time entry revisions from the /review UI to Clio. Reads pending.csv and dispatches by the action recorded on each row. Only rows with action 'patch' (or empty/legacy rows) trigger a Clio PATCH here — rows with action 'delete', 'combine', 'fix-rate', 'discount-100', or 'noop' have already been applied in real-time when the user clicked Accept and are skipped to avoid duplicating work or 404'ing on already-deleted activities. Use dry_run=true to preview.",
    {
      dry_run: z.enum(["true", "false"]).optional().default("false").describe("If true, preview changes without modifying Clio"),
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

        // Categorize by action so we can show what each row would do.
        const categorize = (r: any) => (r.action || "patch").toLowerCase();
        const wouldPatch = toApply.filter((r) => categorize(r) === "patch");
        const wouldSkipByAction = toApply.filter((r) => categorize(r) !== "patch");

        if (params.dry_run === "true") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                dry_run: true,
                would_patch_count: wouldPatch.length,
                would_skip_by_action_count: wouldSkipByAction.length,
                would_patch: wouldPatch.map((r) => ({
                  activity_id: r.activity_id,
                  matter: r.matter_name,
                  date: r.date,
                  current_note: r.current_note,
                  selected_note: r.selected_note,
                  status: r.status,
                  action: r.action || "patch",
                })),
                would_skip_by_action: wouldSkipByAction.map((r) => ({
                  activity_id: r.activity_id,
                  matter: r.matter_name,
                  action: r.action,
                  reason: "action ran in real-time; not replayed by batch",
                })),
                would_skip_status: skippedRows.length,
                pending: pendingRows.length,
              }, null, 2),
            }],
          };
        }

        let patched = 0;
        let skippedByAction = 0;
        const errors: string[] = [];
        const actionBreakdown: Record<string, number> = {};

        for (const row of toApply) {
          const action = categorize(row);
          actionBreakdown[action] = (actionBreakdown[action] || 0) + 1;

          if (action === "patch") {
            try {
              await patchTimeEntrySmart(Number(row.activity_id), { note: row.selected_note });
              patched++;
            } catch (err: any) {
              const detail = err.response?.data?.error?.message || err.response?.data?.message || err.message;
              errors.push(`Activity ${row.activity_id} (${row.matter_name}): ${detail}`);
            }
          } else {
            skippedByAction++;
          }
        }

        if (errors.length === 0) {
          writeCSV([]);
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: errors.length === 0,
              patched,
              skipped_by_action: skippedByAction,
              action_breakdown: actionBreakdown,
              skipped_status: skippedRows.length,
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
