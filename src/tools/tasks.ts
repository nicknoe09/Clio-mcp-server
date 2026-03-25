import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";

const TASK_FIELDS =
  "id,name,description,due_at,status,matter{id,display_number},assignee{id,name}";

export function registerTaskTools(server: McpServer): void {
  server.tool(
    "get_tasks",
    "Get tasks with filters. Defaults to incomplete tasks sorted by due date ascending.",
    {
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      assignee_id: z.coerce.number().optional().describe("Filter by assignee user ID"),
      status: z
        .enum(["pending", "in_progress", "in_review", "complete", "draft", "all"])
        .optional()
        .default("pending")
        .describe("Filter by task status (pending, in_progress, in_review, complete, draft, all)"),
      due_before: z.string().optional().describe("Due before date (YYYY-MM-DD)"),
      due_after: z.string().optional().describe("Due after date (YYYY-MM-DD)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: TASK_FIELDS,
          order: "due_at(asc)",
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.assignee_id) queryParams.assignee_id = params.assignee_id;
        if (params.status !== "all") queryParams.status = params.status;
        if (params.due_before) queryParams.due_before = params.due_before;
        if (params.due_after) queryParams.due_after = params.due_after;

        const tasks = await fetchAllPages<any>("/tasks", queryParams);

        const formatted = tasks.map((t: any) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          due_at: t.due_at,
          status: t.status,
          matter: t.matter,
          assignee: t.assignee,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { count: formatted.length, tasks: formatted },
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
