import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildQueryString,
  fetchAllPages,
  rawGetSingle,
  rawPostSingle,
  rawPatchSingle,
  rawDeleteSingle,
} from "../clio/pagination";

// =====================================================================
// Clio Communications — the log of phone calls and emails on a matter
// (GET/POST/PATCH/DELETE /communications).
//
// Pairs with the firm's Outlook stack: an email thread the attorney
// handled in Outlook can be recorded against the matter here, and phone
// calls can be logged after the fact. Senders/receivers are polymorphic
// (each is a User or a Contact) so the tool takes explicit {id, type}
// participant lists.
// =====================================================================

const COMM_TYPES = { phone: "PhoneCommunication", email: "EmailCommunication" } as const;
const TYPE_TO_FRIENDLY: Record<string, "phone" | "email"> = {
  PhoneCommunication: "phone",
  EmailCommunication: "email",
};

const COMM_FIELDS =
  "id,subject,body,type,date,received_at,time_entries_count,created_at,updated_at," +
  "user{id,name},matter{id,display_number}," +
  "senders{id,type},receivers{id,type}";

const participant = z.object({
  id: z.coerce.number().describe("User or Contact id"),
  type: z.enum(["User", "Contact"]).describe("Whether this participant is a User (firm member) or a Contact"),
});

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

export function formatCommunication(c: any) {
  return {
    id: c.id,
    type: TYPE_TO_FRIENDLY[c.type] ?? c.type,
    subject: c.subject,
    body: c.body,
    date: c.date,
    received_at: c.received_at,
    matter: c.matter,
    user: c.user,
    senders: c.senders,
    receivers: c.receivers,
    time_entries_count: c.time_entries_count,
  };
}

export function registerCommunicationTools(server: McpServer): void {
  // get_communications — list/search the communication log.
  server.tool(
    "get_communications",
    "List logged communications (phone calls and emails) from Clio (GET /communications). Filter by matter, contact, user, type (phone/email), and date range, or wildcard-search the subject/body. Returns metadata and participants; does not fetch attached .eml files.",
    {
      matter_id: z.coerce.number().optional().describe("Only communications on this matter"),
      contact_id: z.coerce.number().optional().describe("Only communications involving this contact"),
      user_id: z.coerce.number().optional().describe("Only communications for this user"),
      type: z.enum(["phone", "email"]).optional().describe("Only phone calls or only emails"),
      query: z.string().optional().describe("Wildcard search over subject/body"),
      received_since: z.string().optional().describe("On/after this date (ISO-8601)"),
      received_before: z.string().optional().describe("On/before this date (ISO-8601)"),
      limit: z.coerce.number().optional().default(100).describe("Max communications to return (default 100)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = { fields: COMM_FIELDS, order: "date(desc)" };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.contact_id) queryParams.contact_id = params.contact_id;
        if (params.user_id) queryParams.user_id = params.user_id;
        if (params.type) queryParams.type = COMM_TYPES[params.type];
        if (params.query) queryParams.query = params.query;
        if (params.received_since) queryParams.received_since = params.received_since;
        if (params.received_before) queryParams.received_before = params.received_before;

        const comms = await fetchAllPages<any>("/communications", queryParams, params.limit);
        return ok({ count: comms.length, communications: comms.map(formatCommunication) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // get_communication — single record.
  server.tool(
    "get_communication",
    "Get a single logged communication by ID (GET /communications/{id}), including its participants and linked matter.",
    { communication_id: z.coerce.number().describe("Clio communication ID") },
    async (params) => {
      try {
        const res = await rawGetSingle(`/communications/${params.communication_id}`, { fields: COMM_FIELDS });
        return ok({ communication: formatCommunication(res.data ?? {}) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // log_communication — record a phone call or email against a matter.
  server.tool(
    "log_communication",
    "Log a phone call or email in Clio (POST /communications) — record it against a matter with a subject, body, timestamp, and participants. Senders and receivers are lists of {id, type} where type is 'User' (a firm member) or 'Contact' (e.g. the client). Use this to record an Outlook email thread or a phone call on the matter file.",
    {
      type: z.enum(["phone", "email"]).describe("Kind of communication"),
      subject: z.string().optional().describe("Subject line / call summary title"),
      body: z.string().optional().describe("Body text / call notes"),
      matter_id: z.coerce.number().optional().describe("Matter to log this against"),
      received_at: z.string().optional().describe("When it occurred (ISO-8601 date-time). Defaults to now in Clio if omitted."),
      senders: z.array(participant).optional().describe("Who sent it, as [{id, type}] (User or Contact)"),
      receivers: z.array(participant).optional().describe("Who received it, as [{id, type}] (User or Contact)"),
    },
    async (params) => {
      try {
        const data: any = { type: COMM_TYPES[params.type] };
        if (params.subject !== undefined) data.subject = params.subject;
        if (params.body !== undefined) data.body = params.body;
        if (params.received_at !== undefined) data.received_at = params.received_at;
        if (params.matter_id !== undefined) data.matter = { id: params.matter_id };
        if (params.senders) data.senders = params.senders;
        if (params.receivers) data.receivers = params.receivers;

        const result = await rawPostSingle(
          `/communications?${buildQueryString({ fields: COMM_FIELDS })}`,
          { data }
        );
        return ok({ logged: true, communication: formatCommunication(result.data ?? {}) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // update_communication — edit an existing log entry.
  server.tool(
    "update_communication",
    "Update a logged communication (PATCH /communications/{id}) — edit its subject, body, timestamp, or move it to a different matter. To change participants, pass full senders/receivers lists (each entry {id, type}; add _deleted:true on an entry to remove it).",
    {
      communication_id: z.coerce.number().describe("Clio communication ID to update"),
      subject: z.string().optional().describe("New subject"),
      body: z.string().optional().describe("New body text"),
      matter_id: z.coerce.number().optional().describe("Move to this matter"),
      received_at: z.string().optional().describe("New timestamp (ISO-8601)"),
      senders: z.array(participant.extend({ _deleted: z.boolean().optional() })).optional()
        .describe("Replacement senders list ([{id, type, _deleted?}])"),
      receivers: z.array(participant.extend({ _deleted: z.boolean().optional() })).optional()
        .describe("Replacement receivers list ([{id, type, _deleted?}])"),
    },
    async (params) => {
      try {
        const data: any = {};
        if (params.subject !== undefined) data.subject = params.subject;
        if (params.body !== undefined) data.body = params.body;
        if (params.received_at !== undefined) data.received_at = params.received_at;
        if (params.matter_id !== undefined) data.matter = { id: params.matter_id };
        if (params.senders) data.senders = params.senders;
        if (params.receivers) data.receivers = params.receivers;
        if (Object.keys(data).length === 0) {
          return fail(new Error("Nothing to update — pass subject, body, received_at, matter_id, senders, or receivers."));
        }

        const result = await rawPatchSingle(
          `/communications/${params.communication_id}?${buildQueryString({ fields: COMM_FIELDS })}`,
          { data }
        );
        return ok({ updated: true, communication: formatCommunication(result.data ?? {}) });
      } catch (err: any) {
        return fail(err);
      }
    }
  );

  // delete_communication
  server.tool(
    "delete_communication",
    "Delete a logged communication (DELETE /communications/{id}). This permanently removes the log entry.",
    { communication_id: z.coerce.number().describe("Clio communication ID to delete") },
    async (params) => {
      try {
        await rawDeleteSingle(`/communications/${params.communication_id}`);
        return ok({ deleted: true, id: params.communication_id });
      } catch (err: any) {
        return fail(err);
      }
    }
  );
}
