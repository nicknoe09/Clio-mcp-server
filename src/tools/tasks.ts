import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawPostSingle, rawPatchSingle, rawDeleteSingle } from "../clio/pagination";

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

  // create_task
  server.tool(
    "create_task",
    "Create a new task in Clio. Must provide a name. Optionally assign to a user, link to a matter, set priority, due date, and status.",
    {
      name: z.string().describe("Task name/title (required)"),
      description: z.string().optional().describe("Task description or notes"),
      due_at: z.string().optional().describe("Due date (ISO 8601, e.g. 2026-04-20T17:00:00-05:00)"),
      status: z
        .enum(["pending", "in_progress", "in_review", "complete", "draft"])
        .optional()
        .default("pending")
        .describe("Task status"),
      priority: z
        .enum(["High", "Normal", "Low"])
        .optional()
        .default("Normal")
        .describe("Task priority (High, Normal, Low)"),
      matter_id: z.coerce.number().optional().describe("Link to a Clio matter by ID"),
      assignee_id: z.coerce.number().optional().describe("Assign to a user by ID"),
      is_private: z.boolean().optional().default(false).describe("Whether the task is private"),
      statute_of_limitations: z.boolean().optional().default(false).describe("Whether this is a statute of limitations task"),
    },
    async (params) => {
      try {
        const body: any = {
          data: {
            name: params.name,
            status: params.status,
            priority: params.priority,
            is_private: params.is_private,
            statute_of_limitations: params.statute_of_limitations,
          },
        };
        if (params.description) body.data.description = params.description;
        if (params.due_at) body.data.due_at = params.due_at;
        if (params.matter_id) body.data.matter = { id: params.matter_id };
        if (params.assignee_id) body.data.assignee = { id: params.assignee_id, type: "User" };

        const result = await rawPostSingle("/tasks", body);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              created: true,
              task: {
                id: result.data?.id,
                name: result.data?.name,
                description: result.data?.description,
                due_at: result.data?.due_at,
                status: result.data?.status,
                priority: result.data?.priority,
                matter: result.data?.matter,
                assignee: result.data?.assignee,
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

  // update_task
  server.tool(
    "update_task",
    "Update an existing task in Clio. Can modify name, description, due date, status, priority, assignee, or matter link.",
    {
      id: z.coerce.number().describe("Task ID to update"),
      name: z.string().optional().describe("Updated task name/title"),
      description: z.string().optional().describe("Updated task description or notes"),
      due_at: z.string().optional().describe("Updated due date (ISO 8601). Set to empty string to clear."),
      status: z
        .enum(["pending", "in_progress", "in_review", "complete", "draft"])
        .optional()
        .describe("Updated task status"),
      priority: z
        .enum(["High", "Normal", "Low"])
        .optional()
        .describe("Updated task priority (High, Normal, Low)"),
      matter_id: z.coerce.number().optional().describe("Link to a different Clio matter by ID"),
      assignee_id: z.coerce.number().optional().describe("Reassign to a different user by ID"),
      is_private: z.boolean().optional().describe("Whether the task is private"),
      statute_of_limitations: z.boolean().optional().describe("Whether this is a statute of limitations task"),
    },
    async (params) => {
      try {
        const body: any = { data: {} };
        if (params.name !== undefined) body.data.name = params.name;
        if (params.description !== undefined) body.data.description = params.description;
        if (params.due_at !== undefined) {
          body.data.due_at = params.due_at === "" ? null : params.due_at;
        }
        if (params.status !== undefined) body.data.status = params.status;
        if (params.priority !== undefined) body.data.priority = params.priority;
        if (params.matter_id !== undefined) body.data.matter = { id: params.matter_id };
        if (params.assignee_id !== undefined) body.data.assignee = { id: params.assignee_id, type: "User" };
        if (params.is_private !== undefined) body.data.is_private = params.is_private;
        if (params.statute_of_limitations !== undefined) body.data.statute_of_limitations = params.statute_of_limitations;

        const result = await rawPatchSingle(`/tasks/${params.id}`, body);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              updated: true,
              task: {
                id: result.data?.id,
                name: result.data?.name,
                description: result.data?.description,
                due_at: result.data?.due_at,
                status: result.data?.status,
                priority: result.data?.priority,
                matter: result.data?.matter,
                assignee: result.data?.assignee,
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

  // delete_task
  server.tool(
    "delete_task",
    "Delete a task from Clio. This permanently removes the task.",
    {
      id: z.coerce.number().describe("Task ID to delete"),
    },
    async (params) => {
      try {
        await rawDeleteSingle(`/tasks/${params.id}`);

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
