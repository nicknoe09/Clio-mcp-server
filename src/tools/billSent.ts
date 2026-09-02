import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildQueryString,
  fetchAllPages,
  rawGetSingle,
  rawPatchSingle,
  rawPostSingle,
} from "../clio/pagination";

// =====================================================================
// Bill submission ledger — recording that an invoice actually went out.
//
// Clio's v4 API has no way to send a bill: POST /bills/{id}/send,
// /bills/{id}/share, /bills/{id}/deliveries, /bill_deliveries and
// /outbound_shares are all 404 (probe_bill_pdf_apis, 2026-09-02). The web
// UI's "Send bill" flow is what sets `last_sent_at`, and `last_sent_at` is
// read-only on the Bill schema, so a bill delivered any other way — mailed,
// hand-delivered, or emailed out of Outlook — keeps sent=false forever.
//
// Mental health commitment invoices are billed to the court and emailed
// from Outlook, so every one of them is permanently unsent as far as Clio
// is concerned. The monthly unsent-invoice report papered over that with a
// matter-name rule ("In the Interest of" => assume court submitted), which
// clears the bill whether or not anyone sent it, and hides invoices that
// were generated, never sent, and never paid.
//
// These tools replace that assumption with a per-bill record:
//
//   mark_bill_sent        attempts the native last_sent_at write, and
//                         records a submission entry on the matter
//   get_bill_submissions  reads the ledger back, parsed
//
// The ledger entry is a Clio Communication on the bill's matter, so it
// lives in Clio (no second system to keep in sync), shows up on the
// matter's Communications tab, carries Clio's own user attribution and
// timestamp, and is queryable by the report.
// =====================================================================

/** Token that identifies a ledger entry. Distinctive and search-safe. */
export const SUBMISSION_MARKER = "BILLSENT";

const COMM_FIELDS =
  "id,subject,body,type,date,received_at,created_at," +
  "user{id,name},matter{id,display_number}";

const BILL_SENT_FIELDS = "id,number,state,last_sent_at,total,balance,matters";

/** How the invoice physically left the firm. */
export const SUBMISSION_METHODS = [
  "email",
  "mail",
  "hand_delivery",
  "efile",
  "clio_portal",
  "fax",
  "other",
] as const;

export type SubmissionMethod = (typeof SUBMISSION_METHODS)[number];

export interface SubmissionRecord {
  bill_id: number | null;
  bill_number: string | null;
  sent_at: string | null;
  method: string | null;
  recipient: string | null;
  note: string | null;
  outlook_message_id: string | null;
}

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
      }, null, 2),
    }],
    isError: true,
  };
}

/** YYYY-MM-DD for today in the server's local zone. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Ledger entry format
// ---------------------------------------------------------------------
// Subject is human-readable on the matter's Communications tab; the body
// carries key=value lines so the report can parse an entry exactly rather
// than scraping prose. Both are written by buildSubmissionBody/Subject and
// read by parseSubmissionBody, so the format has exactly one definition.

export function buildSubmissionSubject(billNumber: string | null, sentAt: string, method: string): string {
  return `${SUBMISSION_MARKER} Invoice ${billNumber ?? "unknown"} sent ${sentAt} via ${method}`;
}

export function buildSubmissionBody(rec: SubmissionRecord): string {
  const lines = [
    SUBMISSION_MARKER,
    `bill_id=${rec.bill_id ?? ""}`,
    `bill_number=${rec.bill_number ?? ""}`,
    `sent_at=${rec.sent_at ?? ""}`,
    `method=${rec.method ?? ""}`,
  ];
  if (rec.recipient) lines.push(`recipient=${rec.recipient}`);
  if (rec.outlook_message_id) lines.push(`outlook_message_id=${rec.outlook_message_id}`);
  if (rec.note) lines.push(`note=${rec.note}`);
  return lines.join("\n");
}

/**
 * Parse a ledger entry out of a communication body. Returns null when the
 * communication is not a submission entry, so a matter's ordinary logged
 * emails and calls are ignored rather than misread as submissions.
 */
export function parseSubmissionBody(body: string | null | undefined): SubmissionRecord | null {
  if (typeof body !== "string" || !body.includes(SUBMISSION_MARKER)) return null;

  const fields: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (m) fields[m[1]] = m[2].trim();
  }

  const billId = fields.bill_id ? Number(fields.bill_id) : NaN;
  const billNumber = fields.bill_number || null;
  // An entry with neither identifier can't be matched to a bill, so it is
  // not a usable record.
  if (!Number.isFinite(billId) && !billNumber) return null;

  return {
    bill_id: Number.isFinite(billId) ? billId : null,
    bill_number: billNumber,
    sent_at: fields.sent_at || null,
    method: fields.method || null,
    recipient: fields.recipient || null,
    note: fields.note || null,
    outlook_message_id: fields.outlook_message_id || null,
  };
}

/** A parsed ledger entry plus the Clio record it came from. */
export interface ParsedSubmission extends SubmissionRecord {
  communication_id: number;
  logged_by: string | null;
  logged_at: string | null;
  matter: { id: number; display_number?: string } | null;
}

export function parseSubmissionCommunication(c: any): ParsedSubmission | null {
  const rec = parseSubmissionBody(c?.body);
  if (!rec) return null;
  return {
    ...rec,
    communication_id: c.id,
    logged_by: c.user?.name ?? null,
    logged_at: c.created_at ?? c.received_at ?? c.date ?? null,
    matter: c.matter ?? null,
  };
}

/**
 * Read the submission ledger from Clio. Filters are pushed to the API where
 * Clio supports them; entries are then parsed and non-entries dropped.
 */
export async function fetchSubmissions(opts: {
  matter_id?: number;
  received_since?: string;
  received_before?: string;
  limit?: number;
}): Promise<ParsedSubmission[]> {
  const params: Record<string, any> = { fields: COMM_FIELDS, order: "date(desc)" };
  if (opts.matter_id) params.matter_id = opts.matter_id;
  else params.query = SUBMISSION_MARKER;
  if (opts.received_since) params.received_since = opts.received_since;
  if (opts.received_before) params.received_before = opts.received_before;

  const comms = await fetchAllPages<any>("/communications", params, opts.limit ?? 500);
  return comms
    .map(parseSubmissionCommunication)
    .filter((s): s is ParsedSubmission => s !== null);
}

/**
 * Index a ledger by bill id and bill number so a report can join it against
 * a bill list in one pass. Latest sent_at wins when a bill has more than one
 * entry (a re-send).
 */
export function indexSubmissions(subs: ParsedSubmission[]): Map<string, ParsedSubmission> {
  const index = new Map<string, ParsedSubmission>();
  const keep = (key: string, s: ParsedSubmission) => {
    const existing = index.get(key);
    if (!existing || (s.sent_at ?? "") > (existing.sent_at ?? "")) index.set(key, s);
  };
  for (const s of subs) {
    if (s.bill_id != null) keep(`id:${s.bill_id}`, s);
    if (s.bill_number) keep(`num:${s.bill_number}`, s);
  }
  return index;
}

export function lookupSubmission(
  index: Map<string, ParsedSubmission>,
  bill: { id?: number | null; number?: string | null },
): ParsedSubmission | null {
  if (bill.id != null && index.has(`id:${bill.id}`)) return index.get(`id:${bill.id}`)!;
  if (bill.number && index.has(`num:${bill.number}`)) return index.get(`num:${bill.number}`)!;
  return null;
}

// ---------------------------------------------------------------------
// Native-write probe
// ---------------------------------------------------------------------
// Whether Clio will take a write to last_sent_at is a question about
// Clio, not about this server, so resolve it against the live API rather
// than asserting it. The probe PATCHes last_sent_at with a deliberately
// invalid value: Clio's error says which of the two cases it is, and no
// valid value is ever written, so nothing changes either way.
//
//   rejects the ATTRIBUTE  -> read-only/unknown, the flag cannot be set
//   rejects the VALUE      -> the attribute is writable, wire it up
//
// A 200 means Clio silently dropped the field; the caller re-reads the bill
// to confirm nothing moved.

export interface ProbeVerdict {
  writable: boolean | null;
  status: number | null;
  verdict: string;
  clio_error?: any;
}

export function interpretSentWriteError(status: number | null, clioError: any): ProbeVerdict {
  const text = typeof clioError === "string" ? clioError : JSON.stringify(clioError ?? "");
  const lower = text.toLowerCase();

  // Clio names the offending attribute when a field is unknown, read-only,
  // or not permitted on this resource.
  if (/unknown attribute|unpermitted|not permitted|read.?only|invalid parameter|unknown parameter/.test(lower)) {
    return {
      writable: false,
      status,
      verdict:
        "Clio rejected the ATTRIBUTE — last_sent_at is not writable via PATCH /bills/{id}. " +
        "The sent flag can only be set by Clio's own send-bill flow. Use the submission ledger.",
      clio_error: clioError,
    };
  }

  // A complaint about the value itself means the attribute was accepted.
  if (/invalid date|not a valid|can't be blank|cannot be blank|is invalid|parse/.test(lower)) {
    return {
      writable: true,
      status,
      verdict:
        "Clio rejected the VALUE, not the attribute — last_sent_at appears writable. " +
        "Re-run mark_bill_sent without dry_run to set it natively.",
      clio_error: clioError,
    };
  }

  return {
    writable: null,
    status,
    verdict:
      `Clio returned ${status ?? "an error"} and the message does not say whether the attribute ` +
      "or the value was rejected — see clio_error.",
    clio_error: clioError,
  };
}

export function registerBillSentTools(server: McpServer): void {
  // ============================================================
  //  mark_bill_sent
  // ============================================================
  server.tool(
    "mark_bill_sent",
    "Record that a bill actually went out to the client or the court. Clio's v4 API exposes no send route " +
      "(POST /bills/{id}/send, /share, /deliveries and /bill_deliveries are all 404) and `last_sent_at` is " +
      "read-only on the Bill schema, so bills delivered outside Clio — mental health commitment invoices " +
      "emailed to the court from Outlook, mailed invoices, hand-delivered ones — sit at sent=false forever. " +
      "This tool attempts the native last_sent_at write first and reports exactly what Clio said, then records " +
      "a submission entry as a Communication on the bill's matter (subject prefixed BILLSENT, body carrying " +
      "bill_id/bill_number/sent_at/method/recipient) so the unsent-invoice report can verify submission per bill " +
      "instead of assuming it from the matter name. Idempotent: a bill that already has an entry is returned " +
      "unchanged unless force=true. Use dry_run=true to ask Clio whether last_sent_at is writable without " +
      "writing anything at all.",
    {
      bill_id: z.coerce.number().describe("Clio bill ID"),
      sent_at: z.string().optional().describe("Date the invoice was sent (YYYY-MM-DD). Defaults to today."),
      method: z.enum(SUBMISSION_METHODS).optional().default("email")
        .describe("How it went out. 'email' covers sending from Outlook; 'clio_portal' is Clio's own send flow."),
      recipient: z.string().optional()
        .describe("Who it went to — e.g. 'Harris County Probate Court No. 3' or the client's email address."),
      note: z.string().optional().describe("Anything else worth recording on the matter."),
      outlook_message_id: z.string().optional()
        .describe("Message id of the sent email, so the entry points at a real sent message rather than a bare assertion."),
      dry_run: z.boolean().optional().default(false)
        .describe("Probe whether Clio accepts a last_sent_at write and stop. Writes nothing — no PATCH value, no ledger entry."),
      force: z.boolean().optional().default(false)
        .describe("Write a second ledger entry even though this bill already has one (a genuine re-send)."),
    },
    async (params) => {
      try {
        const sentAt = params.sent_at ?? today();

        // ---- Read the bill first: it supplies the number and matter the
        // ledger entry needs, and confirms the bill exists.
        const billResp = await rawGetSingle(`/bills/${params.bill_id}`, { fields: BILL_SENT_FIELDS });
        const bill = billResp?.data;
        if (!bill) {
          return ok({ success: false, message: `Bill ${params.bill_id} not found.` });
        }
        const matter = bill.matters?.[0] ?? null;

        // ---- Ask Clio whether the flag itself can be set.
        let native: any;
        if (params.dry_run) {
          try {
            await rawPatchSingle(`/bills/${params.bill_id}`, {
              data: { last_sent_at: "clio-mcp-write-probe" },
            });
            const after = (await rawGetSingle(`/bills/${params.bill_id}`, { fields: "id,last_sent_at" }))?.data;
            native = {
              writable: after?.last_sent_at === "clio-mcp-write-probe" ? true : null,
              status: 200,
              verdict:
                after?.last_sent_at === bill.last_sent_at
                  ? "Clio accepted the request but silently dropped last_sent_at — the field is not writable in practice. Use the submission ledger."
                  : "Clio accepted an invalid last_sent_at value — inspect the bill before trusting this.",
              last_sent_at_before: bill.last_sent_at ?? null,
              last_sent_at_after: after?.last_sent_at ?? null,
            };
          } catch (err: any) {
            native = interpretSentWriteError(err.response?.status ?? null, err.response?.data);
          }

          return ok({
            dry_run: true,
            bill: { id: bill.id, number: bill.number, state: bill.state, last_sent_at: bill.last_sent_at ?? null },
            native_sent_flag: native,
            nothing_written: true,
          });
        }

        // ---- Real run: attempt the native write, then verify by re-reading.
        // Clio ignoring the field silently is the case that matters, so
        // never report success from the PATCH status alone.
        try {
          await rawPatchSingle(`/bills/${params.bill_id}`, {
            data: { last_sent_at: `${sentAt}T00:00:00Z` },
          });
          const after = (await rawGetSingle(`/bills/${params.bill_id}`, { fields: "id,last_sent_at" }))?.data;
          const moved = (after?.last_sent_at ?? null) !== (bill.last_sent_at ?? null);
          native = moved
            ? { applied: true, last_sent_at: after?.last_sent_at ?? null, verdict: "Clio accepted the write — the bill's own sent flag is now set." }
            : {
                applied: false,
                last_sent_at: after?.last_sent_at ?? null,
                verdict: "Clio accepted the request but last_sent_at did not change — the field is read-only in practice. The ledger entry below is the record of record.",
              };
        } catch (err: any) {
          native = {
            applied: false,
            ...interpretSentWriteError(err.response?.status ?? null, err.response?.data),
          };
        }

        // ---- Idempotency: don't stack duplicate entries on re-runs.
        if (!params.force && matter?.id) {
          const existing = await fetchSubmissions({ matter_id: matter.id, limit: 200 });
          const hit = lookupSubmission(indexSubmissions(existing), { id: bill.id, number: bill.number });
          if (hit) {
            return ok({
              success: true,
              already_recorded: true,
              message:
                `Invoice ${bill.number} already has a submission entry (sent ${hit.sent_at} via ${hit.method}, ` +
                `logged by ${hit.logged_by ?? "unknown"}). Pass force=true to record a re-send.`,
              bill: { id: bill.id, number: bill.number, state: bill.state, total: bill.total, balance: bill.balance },
              submission: hit,
              native_sent_flag: native,
            });
          }
        }

        // ---- Write the ledger entry.
        const record: SubmissionRecord = {
          bill_id: bill.id,
          bill_number: bill.number ?? null,
          sent_at: sentAt,
          method: params.method,
          recipient: params.recipient ?? null,
          note: params.note ?? null,
          outlook_message_id: params.outlook_message_id ?? null,
        };

        const data: any = {
          type: params.method === "email" ? "EmailCommunication" : "PhoneCommunication",
          subject: buildSubmissionSubject(record.bill_number, sentAt, params.method),
          body: buildSubmissionBody(record),
          received_at: `${sentAt}T00:00:00Z`,
        };
        if (matter?.id) data.matter = { id: matter.id };

        const created = await rawPostSingle(
          `/communications?${buildQueryString({ fields: COMM_FIELDS })}`,
          { data },
        );
        const comm = created?.data ?? {};

        return ok({
          success: true,
          bill: {
            id: bill.id,
            number: bill.number,
            state: bill.state,
            total: bill.total,
            balance: bill.balance,
            matter: matter?.display_number ?? null,
          },
          native_sent_flag: native,
          submission: {
            communication_id: comm.id ?? null,
            ...record,
            logged_by: comm.user?.name ?? null,
          },
          message:
            `Invoice ${bill.number} recorded as sent ${sentAt} via ${params.method}` +
            (params.recipient ? ` to ${params.recipient}` : "") +
            ". get_bill_submissions and get_bills(verify_submissions=true) will now see it.",
        });
      } catch (err: any) {
        return fail(err);
      }
    },
  );

  // ============================================================
  //  get_bill_submissions
  // ============================================================
  server.tool(
    "get_bill_submissions",
    "Read the bill submission ledger written by mark_bill_sent — the record of invoices that went out to a " +
      "client or a court outside Clio's own send flow, which Clio itself has no field for. Filter by bill, " +
      "matter, or date range. Use this in the monthly unsent-invoice report to verify per bill that an invoice " +
      "was actually sent, instead of clearing bills by matter name (the 'In the Interest of' rule, which cleared " +
      "court-billed invoices whether or not anyone had sent them).",
    {
      bill_id: z.coerce.number().optional().describe("Only the entry for this bill ID"),
      bill_number: z.string().optional().describe("Only the entry for this invoice number"),
      matter_id: z.coerce.number().optional().describe("Only entries on this matter"),
      sent_since: z.string().optional().describe("Entries logged on/after this date (YYYY-MM-DD)"),
      sent_before: z.string().optional().describe("Entries logged on/before this date (YYYY-MM-DD)"),
      limit: z.coerce.number().optional().default(500).describe("Max entries to scan (default 500)"),
    },
    async (params) => {
      try {
        let subs = await fetchSubmissions({
          matter_id: params.matter_id,
          received_since: params.sent_since,
          received_before: params.sent_before,
          limit: params.limit,
        });

        if (params.bill_id != null) subs = subs.filter((s) => s.bill_id === params.bill_id);
        if (params.bill_number) subs = subs.filter((s) => s.bill_number === params.bill_number);

        return ok({
          count: subs.length,
          submissions: subs,
          ...(subs.length === 0
            ? { note: "No submission entries matched. Bills sent outside Clio only appear here once mark_bill_sent has recorded them." }
            : {}),
        });
      } catch (err: any) {
        return fail(err);
      }
    },
  );
}
