import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildQueryString,
  rawGetSingle,
  rawPostSingle,
  rawDeleteSingle,
} from "../clio/pagination";

// =====================================================================
// Clio Timer — the single running timer for the acting attorney
// (GET/POST/DELETE /timer). A timer runs against an existing Activity
// (time entry); starting one sets its start_time, and stopping it (DELETE)
// rolls the elapsed time onto that activity. There is at most one timer
// per user at a time.
// =====================================================================

const TIMER_FIELDS =
  "id,start_time,elapsed_time,created_at,updated_at,activity{id,type,note}";

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

export function formatTimer(t: any) {
  return {
    id: t.id,
    start_time: t.start_time,
    elapsed_time_seconds: t.elapsed_time,
    activity: t.activity,
  };
}

export function registerTimerTools(server: McpServer): void {
  // get_timer — the currently running timer (if any).
  server.tool(
    "get_timer",
    "Get YOUR currently running Clio timer, if one is running (GET /timer). Returns the timer's start time, elapsed seconds, and the activity it's attached to. Reports running=false when no timer is active.",
    {},
    async () => {
      try {
        const res = await rawGetSingle("/timer", { fields: TIMER_FIELDS });
        return ok({ running: true, timer: formatTimer(res.data ?? {}) });
      } catch (err: any) {
        if (err.response?.status === 404) {
          return ok({ running: false, timer: null });
        }
        return fail(err);
      }
    }
  );

  // start_timer — start the timer on an existing activity/time entry.
  server.tool(
    "start_timer",
    "Start YOUR Clio timer on an existing activity/time entry (POST /timer). Pass the activity_id of a time entry to track against. Clio allows only one running timer at a time — starting a new one fails if one is already running (stop it first with stop_timer).",
    {
      activity_id: z.coerce.number().describe("The Activity (time entry) id to run the timer against"),
    },
    async (params) => {
      try {
        const result = await rawPostSingle(
          `/timer?${buildQueryString({ fields: TIMER_FIELDS })}`,
          { data: { activity: { id: params.activity_id } } }
        );
        return ok({ started: true, timer: formatTimer(result.data ?? {}) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // stop_timer — stop/delete the running timer.
  server.tool(
    "stop_timer",
    "Stop YOUR running Clio timer (DELETE /timer). This ends the timer and rolls its elapsed time onto the attached activity. No-op-safe: reports stopped=false if no timer was running.",
    {},
    async () => {
      try {
        await rawDeleteSingle("/timer");
        return ok({ stopped: true });
      } catch (err: any) {
        if (err.response?.status === 404) {
          return ok({ stopped: false, note: "No timer was running." });
        }
        return fail(err);
      }
    }
  );
}
