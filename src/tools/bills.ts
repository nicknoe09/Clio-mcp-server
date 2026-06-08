import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle, rawGetBinarySingle, rawPatchSingle, rawDeleteSingle } from "../clio/pagination";
import JSZip from "jszip";

const BILL_FIELDS =
  "id,number,subject,memo,kind,type,state,available_state_transitions,can_update," +
  "issued_at,due_at,start_at,end_at,created_at,updated_at,last_sent_at," +
  "total,due,balance,paid,pending,paid_at,credits_issued,shared,matters," +
  "client{id,name,primary_email_address,type}";

export function registerBillTools(server: McpServer): void {
  server.tool(
    "get_bills",
    "Get bills with filters. Flags aging: outstanding > 30, 60, 90 days. Returns payment detail (`paid`, `pending`, `paid_at`, `due`, `credits_issued`), routing info (`client`, `shared`), bill metadata (`subject`, `memo`, `kind`, `type`, `start_at`, `end_at`, `created_at`, `updated_at`), state machine (`available_state_transitions`, `can_update`), and sent indicators (`sent`, `last_sent_at`) so callers can distinguish bills that have been emailed/shared to the client from approved bills still sitting in the drawer.",
    {
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      client_id: z.coerce.number().optional().describe("Filter by client ID"),
      state: z
        .enum(["draft", "awaiting_approval", "awaiting_payment", "paid", "void", "all"])
        .optional()
        .default("all")
        .describe("Filter by bill state"),
      issued_after: z.string().optional().describe("Issued after date (YYYY-MM-DD)"),
      issued_before: z.string().optional().describe("Issued before date (YYYY-MM-DD)"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, any> = {
          fields: BILL_FIELDS,
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.client_id) queryParams.client_id = params.client_id;
        if (params.state !== "all") queryParams.state = params.state;
        if (params.issued_after) queryParams.issued_after = params.issued_after;
        if (params.issued_before) queryParams.issued_before = params.issued_before;

        const bills = await fetchAllPages<any>("/bills", queryParams);
        const today = new Date();

        const formatted = bills.map((b: any) => {
          const dueDate = b.due_at ? new Date(b.due_at) : null;
          const daysOutstanding = dueDate
            ? Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
            : null;

          let aging_flag: string | null = null;
          if (b.state === "outstanding" && daysOutstanding !== null) {
            if (daysOutstanding > 90) aging_flag = "90+ days";
            else if (daysOutstanding > 60) aging_flag = "60+ days";
            else if (daysOutstanding > 30) aging_flag = "30+ days";
          }

          const last_sent_at = b.last_sent_at ?? null;
          const sent = !!last_sent_at;

          return {
            id: b.id,
            number: b.number,
            subject: b.subject ?? null,
            memo: b.memo ?? null,
            kind: b.kind ?? null,
            type: b.type ?? null,
            state: b.state,
            available_state_transitions: b.available_state_transitions ?? [],
            can_update: b.can_update ?? null,
            issued_at: b.issued_at,
            due_at: b.due_at,
            start_at: b.start_at ?? null,
            end_at: b.end_at ?? null,
            created_at: b.created_at ?? null,
            updated_at: b.updated_at ?? null,
            total: b.total,
            due: b.due ?? null,
            balance: b.balance,
            paid: b.paid ?? null,
            pending: b.pending ?? null,
            paid_at: b.paid_at ?? null,
            credits_issued: b.credits_issued ?? null,
            shared: b.shared ?? null,
            matter: b.matters?.[0] ?? null,
            client: b.client ?? null,
            days_outstanding: daysOutstanding,
            aging_flag,
            sent,
            last_sent_at,
          };
        });

        const totalBalance =
          Math.round(
            formatted.reduce((s: number, b: any) => s + (b.balance || 0), 0) * 100
          ) / 100;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: formatted.length,
                  total_balance: totalBalance,
                  bills: formatted,
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

  // ============================================================
  //  debug_bill_fields — verify Clio returns each requested field
  // ============================================================
  // Hits /bills/{id} with the same field set get_bills uses, then dumps
  // (a) the raw Clio response, (b) the get_bills-shaped output for that
  // bill, and (c) a presence check showing which of the tracked fields
  // came back populated vs null/missing. Useful for confirming Clio
  // actually supports each name in BILL_FIELDS before relying on it.
  server.tool(
    "debug_bill_fields",
    "Debug helper: fetch one bill with the full get_bills field set and report which fields Clio returned. Use this after editing BILL_FIELDS to confirm Clio accepts each field name and to see the actual shape of nested objects (client, matters).",
    {
      bill_id: z.coerce.number().describe("Clio bill ID to inspect"),
    },
    async (params) => {
      try {
        const resp = await rawGetSingle(`/bills/${params.bill_id}`, {
          fields: BILL_FIELDS,
        });
        const b = resp.data;
        if (!b) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, message: `Bill ${params.bill_id} not found` }),
            }],
            isError: true,
          };
        }

        const today = new Date();
        const dueDate = b.due_at ? new Date(b.due_at) : null;
        const daysOutstanding = dueDate
          ? Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
          : null;
        const last_sent_at = b.last_sent_at ?? null;

        const mapped = {
          id: b.id,
          number: b.number,
          subject: b.subject ?? null,
          memo: b.memo ?? null,
          kind: b.kind ?? null,
          type: b.type ?? null,
          state: b.state,
          available_state_transitions: b.available_state_transitions ?? [],
          can_update: b.can_update ?? null,
          issued_at: b.issued_at,
          due_at: b.due_at,
          start_at: b.start_at ?? null,
          end_at: b.end_at ?? null,
          created_at: b.created_at ?? null,
          updated_at: b.updated_at ?? null,
          total: b.total,
          due: b.due ?? null,
          balance: b.balance,
          paid: b.paid ?? null,
          pending: b.pending ?? null,
          paid_at: b.paid_at ?? null,
          credits_issued: b.credits_issued ?? null,
          shared: b.shared ?? null,
          matter: b.matters?.[0] ?? null,
          client: b.client ?? null,
          days_outstanding: daysOutstanding,
          sent: !!last_sent_at,
          last_sent_at,
        };

        const tracked = [
          "subject",
          "memo",
          "kind",
          "type",
          "available_state_transitions",
          "can_update",
          "start_at",
          "end_at",
          "created_at",
          "updated_at",
          "last_sent_at",
          "due",
          "paid",
          "pending",
          "paid_at",
          "credits_issued",
          "shared",
          "client",
        ];
        const field_presence = Object.fromEntries(
          tracked.map((k) => {
            const v = (b as any)[k];
            const present = v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
            return [k, { present, value: v ?? null }];
          })
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              bill_id: params.bill_id,
              fields_requested: BILL_FIELDS,
              field_presence,
              mapped_output: mapped,
              raw_clio_response: b,
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
              hint: err.response?.status === 400
                ? "Clio rejected the request — likely an unsupported field name in BILL_FIELDS. Check clio_error for the offending field."
                : undefined,
            }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  //  download_bill_pdf — Download a single bill as PDF
  // ============================================================
  server.tool(
    "download_bill_pdf",
    "Download a single bill as a PDF file. Returns base64-encoded PDF for download. Requires the bill ID (use get_bills to find IDs). Draft bills may not have PDFs available.",
    {
      bill_id: z.coerce.number().describe("Clio bill ID"),
    },
    async (params) => {
      try {
        // Fetch bill metadata for filename and state check
        const billData = await rawGetSingle(`/bills/${params.bill_id}`, {
          fields: "id,number,state,issued_at",
        });
        const bill = billData.data;

        if (!bill) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `Bill ${params.bill_id} not found` }) }],
            isError: true,
          };
        }

        if (bill.state === "draft") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `Bill ${bill.number || params.bill_id} is a draft — PDFs are only available for issued bills. Issue the bill in Clio first.` }) }],
            isError: true,
          };
        }

        // Download the PDF — try .pdf suffix first, fall back to Accept header
        let result: { buffer: Buffer; contentType: string };
        try {
          result = await rawGetBinarySingle(`/bills/${params.bill_id}.pdf`);
        } catch (suffixErr: any) {
          // If .pdf suffix doesn't work, try Accept header approach
          if (suffixErr.response?.status === 404 || suffixErr.response?.status === 406) {
            result = await rawGetBinarySingle(
              `/bills/${params.bill_id}`,
              {},
              { "Accept": "application/pdf" }
            );
          } else {
            throw suffixErr;
          }
        }

        // Verify we actually got a PDF
        if (!result.contentType.includes("pdf") && !result.buffer.slice(0, 5).toString().startsWith("%PDF")) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `Clio returned content-type "${result.contentType}" instead of PDF. The API may not support PDF download for this bill.` }) }],
            isError: true,
          };
        }

        const base64 = result.buffer.toString("base64");
        const filename = `Bill-${bill.number || params.bill_id}.pdf`;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              filename,
              format: "pdf",
              size_kb: Math.round(result.buffer.length / 1024),
              base64,
            }),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }) }],
          isError: true,
        };
      }
    }
  );

  // ============================================================
  //  set_bill_state — change a bill's state (e.g. void, back to draft)
  // ============================================================
  // Wraps PATCH /bills/{id} with a target state. Common use cases:
  //   awaiting_payment → void   (firm-error fix; client won't be billed)
  //   awaiting_payment → draft  (move back for further editing)
  // Some transitions are restricted by Clio (e.g. you can't un-pay a paid
  // bill, and voiding may require additional fields like voided_at). Errors
  // are surfaced verbatim so the caller sees exactly what Clio rejected.
  server.tool(
    "set_bill_state",
    "Change a bill's state. Useful for voiding a bill that won't be issued, or moving an issued bill back to draft for editing. Wraps PATCH /bills/{id} with the target state. Reads before/after for audit. Some transitions may be restricted by Clio (e.g. paid → anything-else); Clio errors are surfaced verbatim. If the bill is already in the target state, no PATCH is sent.",
    {
      bill_id: z.coerce.number().describe("Clio bill ID"),
      target_state: z
        .enum(["draft", "awaiting_approval", "awaiting_payment", "paid", "void"])
        .describe(
          "Target state. Common transitions: awaiting_payment → void (firm-error fix), awaiting_payment → draft (re-edit), draft → awaiting_payment (issue).",
        ),
    },
    async (params) => {
      try {
        // Step 1: Read current state.
        const beforeResp = await rawGetSingle(`/bills/${params.bill_id}`, {
          fields: BILL_FIELDS,
        });
        const beforeBill = beforeResp.data;
        if (!beforeBill) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ success: false, message: `Bill ${params.bill_id} not found` }),
            }],
            isError: true,
          };
        }

        const before = {
          state: beforeBill.state,
          total: beforeBill.total,
          balance: beforeBill.balance,
          number: beforeBill.number,
        };

        // No-op shortcut: don't bother PATCHing if already in target state.
        if (before.state === params.target_state) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                no_change: true,
                bill_id: params.bill_id,
                message: `Bill ${beforeBill.number || params.bill_id} already in state "${params.target_state}" — no PATCH sent.`,
                state: before.state,
              }, null, 2),
            }],
          };
        }

        // Step 2: Attempt the PATCH.
        const patchBody = { data: { state: params.target_state } };
        try {
          await rawPatchSingle(`/bills/${params.bill_id}`, patchBody);
        } catch (err: any) {
          const status = err.response?.status || err.statusCode;
          let interpretation = "Unknown error";
          if (status === 422) interpretation = "Clio rejected the state transition — the requested change may not be allowed from the current state, or additional fields (e.g. voided_at, voided_reason) may be required.";
          else if (status === 403) interpretation = "Forbidden — insufficient permissions for this state change.";
          else if (status === 404) interpretation = "Bill not found.";
          else if (status === 400) interpretation = "Bad request — check the field shape Clio expects.";
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                bill_id: params.bill_id,
                attempted_transition: `${before.state} → ${params.target_state}`,
                status,
                interpretation,
                message: err.message,
                clio_error: err.response?.data,
                request_body: patchBody,
              }, null, 2),
            }],
            isError: true,
          };
        }

        // Step 3: Read again to confirm.
        const afterResp = await rawGetSingle(`/bills/${params.bill_id}`, {
          fields: BILL_FIELDS,
        });
        const afterBill = afterResp.data;
        const after = {
          state: afterBill?.state,
          total: afterBill?.total,
          balance: afterBill?.balance,
          number: afterBill?.number,
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              bill_id: params.bill_id,
              transition: `${before.state} → ${after.state}`,
              before,
              after,
              message: `Bill ${afterBill?.number || params.bill_id} state changed: ${before.state} → ${after.state}.`,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              bill_id: params.bill_id,
              message: err.message,
              status: err.response?.status,
              clio_error: err.response?.data,
            }),
          }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  //  delete_draft_bill — DELETE a draft bill via /bills/{id}
  // ============================================================
  // Underlying activities are NOT deleted; they revert to unbilled and
  // will be picked up by Clio's "Generate Bill" / "Regenerate Draft" flow
  // in the matter's UI. Use case: cleaning up a stale draft after
  // prepare_line_split / prepare_hard_combine when Clio UI doesn't expose
  // a Regenerate Draft option for the bill in question (varies by plan).
  // Refuses if the bill is not in 'draft' state — deleting issued/paid/
  // void bills affects accounting and isn't supported here.
  server.tool(
    "delete_draft_bill",
    "Delete a draft bill via DELETE /bills/{id}. Refuses if the bill is not in 'draft' state. The underlying activities are NOT deleted — they revert to unbilled and will appear on the next bill cycle for the matter, OR you can immediately recreate a draft via Clio UI ('Generate Bill' on the matter). Use case: cleaning up a stale draft after prepare_line_split / prepare_hard_combine when Clio UI doesn't expose a per-bill Regenerate Draft option (varies by Clio plan). Reads the bill's pre-delete state for audit; returns an explicit ui_instruction for the next step.",
    {
      bill_id: z.coerce.number().describe("Clio bill ID. Must currently be in 'draft' state."),
    },
    async (params) => {
      try {
        // Step 1: Read the bill to verify state before deleting.
        const beforeResp = await rawGetSingle(`/bills/${params.bill_id}`, {
          fields: BILL_FIELDS,
        });
        const before = beforeResp.data;
        if (!before) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ success: false, message: `Bill ${params.bill_id} not found.` }),
            }],
            isError: true,
          };
        }
        if (before.state !== "draft") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                bill_id: params.bill_id,
                bill_state: before.state,
                message: `Refusing to delete: bill ${before.number || params.bill_id} is in state "${before.state}", not "draft". Only draft bills can be deleted via this tool. To void an issued bill, use set_bill_state with target_state="void".`,
                context: "bill_not_draft",
              }, null, 2),
            }],
            isError: true,
          };
        }

        // Step 2: DELETE the bill.
        await rawDeleteSingle(`/bills/${params.bill_id}`);

        const matterDisplay = before.matters?.[0]?.display_number ?? `matter ${before.matters?.[0]?.id ?? "?"}`;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              deleted_bill: {
                id: params.bill_id,
                number: before.number,
                total: before.total,
                balance: before.balance,
                state: "draft",
                matter: before.matters?.[0] ?? null,
              },
              ui_instruction: `Bill ${before.number || params.bill_id} (draft, was \$${before.total ?? 0}) has been deleted. The underlying activities are now unbilled. To bring them back onto a fresh draft on ${matterDisplay}, open Clio UI → that matter → click "Generate Bill" (or "Create Bill"). The new draft will include all unbilled activities for the matter within the relevant date range — including any you just created via prepare_line_split / prepare_hard_combine / etc.`,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        const status = err.response?.status || err.statusCode;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              bill_id: params.bill_id,
              status,
              message: err.message,
              clio_error: err.response?.data,
            }, null, 2),
          }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  //  download_bills_pdf — Bulk download bills as a zip of PDFs
  // ============================================================
  server.tool(
    "download_bills_pdf",
    "Download multiple bill PDFs as a zip file. Filters bills by state, matter, client, or date range, then downloads each PDF and bundles them. Draft bills are skipped (no PDF available). Returns base64-encoded zip for download.",
    {
      state: z
        .enum(["draft", "awaiting_approval", "awaiting_payment", "paid", "void", "all"])
        .optional()
        .default("all")
        .describe("Filter by bill state"),
      matter_id: z.coerce.number().optional().describe("Filter by matter ID"),
      client_id: z.coerce.number().optional().describe("Filter by client ID"),
      issued_after: z.string().optional().describe("Issued after date (YYYY-MM-DD)"),
      issued_before: z.string().optional().describe("Issued before date (YYYY-MM-DD)"),
    },
    async (params) => {
      try {
        // Fetch matching bills
        const queryParams: Record<string, any> = {
          fields: "id,number,state,issued_at",
        };
        if (params.matter_id) queryParams.matter_id = params.matter_id;
        if (params.client_id) queryParams.client_id = params.client_id;
        if (params.state !== "all") queryParams.state = params.state;
        if (params.issued_after) queryParams.issued_after = params.issued_after;
        if (params.issued_before) queryParams.issued_before = params.issued_before;

        const bills = await fetchAllPages<any>("/bills", queryParams);

        if (bills.length === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: "No bills matched the provided filters." }) }],
            isError: true,
          };
        }

        // Separate downloadable bills from drafts
        const drafts = bills.filter((b: any) => b.state === "draft");
        const downloadable = bills.filter((b: any) => b.state !== "draft");

        if (downloadable.length === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `All ${drafts.length} matching bill(s) are drafts — PDFs are only available for issued bills.` }) }],
            isError: true,
          };
        }

        // Download each PDF sequentially (respects rate limits)
        const zip = new JSZip();
        let downloaded = 0;
        let failed = 0;
        const errors: string[] = [];

        for (const bill of downloadable) {
          try {
            let result: { buffer: Buffer; contentType: string };
            try {
              result = await rawGetBinarySingle(`/bills/${bill.id}.pdf`);
            } catch (suffixErr: any) {
              if (suffixErr.response?.status === 404 || suffixErr.response?.status === 406) {
                result = await rawGetBinarySingle(
                  `/bills/${bill.id}`,
                  {},
                  { "Accept": "application/pdf" }
                );
              } else {
                throw suffixErr;
              }
            }

            const filename = `Bill-${bill.number || bill.id}.pdf`;
            zip.file(filename, result.buffer);
            downloaded++;

            // Courtesy delay between downloads to avoid slamming the API
            if (downloaded < downloadable.length) {
              await new Promise((r) => setTimeout(r, 200));
            }
          } catch (dlErr: any) {
            failed++;
            errors.push(`Bill ${bill.number || bill.id}: ${dlErr.message}`);
          }
        }

        if (downloaded === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: `Failed to download all ${downloadable.length} bill PDFs. Errors: ${errors.join("; ")}` }) }],
            isError: true,
          };
        }

        const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
        const base64 = zipBuffer.toString("base64");

        const filterDesc = [
          params.state !== "all" ? params.state : null,
          params.matter_id ? `matter-${params.matter_id}` : null,
          params.client_id ? `client-${params.client_id}` : null,
        ].filter(Boolean).join("_") || "filtered";

        const filename = `Bills-${filterDesc}.zip`;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              filename,
              format: "zip",
              size_kb: Math.round(zipBuffer.length / 1024),
              base64,
              summary: {
                total_matched: bills.length,
                downloaded,
                skipped_drafts: drafts.length,
                failed,
                errors: errors.length > 0 ? errors : undefined,
              },
            }),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: true, message: err.message, status: err.response?.status, clio_error: err.response?.data }) }],
          isError: true,
        };
      }
    }
  );
}
