import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildQueryString,
  fetchAllPages,
  rawPostSingle,
  rawPatchSingle,
  rawDeleteSingle,
} from "../clio/pagination";
import { getActingClioUserId } from "../clio/actingUser";

// =====================================================================
// Clio Reminders — pre-event/pre-due-date notifications attached to a
// CalendarEntry or a Task (GET/POST/PATCH/DELETE /reminders).
//
// A Reminder fires `duration` (minutes) before its subject, via a
// NotificationMethod. Clio exposes no endpoint to list NotificationMethods,
// so creating one needs a notification_method_id the caller already knows —
// get_reminders surfaces the notification_method on existing reminders so
// an id can be reused.
// =====================================================================

const REMINDER_FIELDS =
  "id,duration,next_delivery_at,state,created_at,updated_at," +
  "notification_method{id,name},subject{id,type}";

function ok(payload: any) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: any) {
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

export function formatReminder(r: any) {
  return {
    id: r.id,
    duration_minutes: r.duration,
    next_delivery_at: r.next_delivery_at,
    state: r.state,
    notification_method: r.notification_method,
    subject: r.subject,
  };
}

export function registerReminderTools(server: McpServer): void {
  // get_reminders — list reminders, defaulting to the acting attorney's own.
  server.tool(
    "get_reminders",
    "List Clio reminders (GET /reminders). Defaults to YOUR reminders. Scope to a specific Task or CalendarEntry with subject_id + subject_type. Each result includes its notification_method (id + name) — reuse that id when calling create_reminder.",
    {
      user_id: z.coerce.number().optional().describe("Filter to a specific user's reminders. Defaults to YOU (the acting attorney)."),
      all_users: z.boolean().optional().default(false).describe("Set true to list reminders across all users instead of just yours."),
      subject_id: z.coerce.number().optional().describe("Scope to a single Task or CalendarEntry id (requires subject_type)"),
      subject_type: z.enum(["Task", "CalendarEntry"]).optional().describe("Type of subject_id (required when subject_id is given)"),
      state: z.string().optional().describe("Filter by reminder state"),
      limit: z.coerce.number().optional().default(200).describe("Max reminders to return (default 200)"),
    },
    async (params) => {
      try {
        if (params.subject_id && !params.subject_type) {
          return fail(new Error("subject_type is required when subject_id is given (Task or CalendarEntry)."));
        }
        const queryParams: Record<string, any> = { fields: REMINDER_FIELDS };
        if (!params.all_users) {
          queryParams.user_id = params.user_id ?? (await getActingClioUserId());
        } else if (params.user_id) {
          queryParams.user_id = params.user_id;
        }
        if (params.subject_id) {
          queryParams.subject_id = params.subject_id;
          queryParams.subject_type = params.subject_type;
        }
        if (params.state) queryParams.state = params.state;

        const reminders = await fetchAllPages<any>("/reminders", queryParams, params.limit);
        return ok({ count: reminders.length, reminders: reminders.map(formatReminder) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // create_reminder — attach a reminder to a Task or CalendarEntry.
  server.tool(
    "create_reminder",
    "Create a Clio reminder on a Task or CalendarEntry (POST /reminders). The reminder fires duration_value×duration_unit before the subject. Requires a notification_method_id — Clio has no endpoint to list these, so reuse one from an existing reminder (see get_reminders).",
    {
      subject_id: z.coerce.number().describe("The Task or CalendarEntry id to remind about"),
      subject_type: z.enum(["Task", "CalendarEntry"]).describe("Type of the subject"),
      duration_value: z.coerce.number().describe("How long before the subject to fire (a positive integer)"),
      duration_unit: z.enum(["weeks", "days", "hours", "minutes"]).describe("Unit for duration_value"),
      notification_method_id: z.coerce.number().describe("NotificationMethod id (reuse one from get_reminders)"),
    },
    async (params) => {
      try {
        const body = {
          data: {
            subject: { id: params.subject_id, type: params.subject_type },
            duration_value: params.duration_value,
            duration_unit: params.duration_unit,
            notification_method: { id: params.notification_method_id },
          },
        };
        const result = await rawPostSingle(
          `/reminders?${buildQueryString({ fields: REMINDER_FIELDS })}`,
          body
        );
        return ok({ created: true, reminder: formatReminder(result.data ?? {}) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // update_reminder — change the lead time / notification method.
  server.tool(
    "update_reminder",
    "Update a Clio reminder's lead time and/or notification method (PATCH /reminders/{id}). The subject cannot be changed — delete and recreate to move a reminder to a different task/event.",
    {
      reminder_id: z.coerce.number().describe("Clio reminder id to update"),
      duration_value: z.coerce.number().optional().describe("New lead-time amount"),
      duration_unit: z.enum(["weeks", "days", "hours", "minutes"]).optional().describe("New lead-time unit"),
      notification_method_id: z.coerce.number().optional().describe("New NotificationMethod id"),
    },
    async (params) => {
      try {
        const data: any = {};
        if (params.duration_value !== undefined) data.duration_value = params.duration_value;
        if (params.duration_unit !== undefined) data.duration_unit = params.duration_unit;
        if (params.notification_method_id !== undefined) {
          data.notification_method = { id: params.notification_method_id };
        }
        if ((data.duration_value === undefined) !== (data.duration_unit === undefined)) {
          return fail(new Error("Pass duration_value and duration_unit together."));
        }
        if (Object.keys(data).length === 0) {
          return fail(new Error("Nothing to update — pass duration_value+duration_unit and/or notification_method_id."));
        }
        const result = await rawPatchSingle(
          `/reminders/${params.reminder_id}?${buildQueryString({ fields: REMINDER_FIELDS })}`,
          { data }
        );
        return ok({ updated: true, reminder: formatReminder(result.data ?? {}) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // delete_reminder
  server.tool(
    "delete_reminder",
    "Delete a Clio reminder (DELETE /reminders/{id}).",
    { reminder_id: z.coerce.number().describe("Clio reminder id to delete") },
    async (params) => {
      try {
        await rawDeleteSingle(`/reminders/${params.reminder_id}`);
        return ok({ deleted: true, id: params.reminder_id });
      } catch (err: any) {
        return fail(err);
      }
    }
  );
}
