import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages, rawGetSingle, rawGetBinarySingle, rawPatchSingle } from "../clio/pagination";
import JSZip from "jszip";

const BILL_FIELDS =
  "id,number,issued_at,due_at,balance,total,state,matters";

export function registerBillTools(server: McpServer): void {
  server.tool(
    "get_bills",
    "Get bills with filters. Flags aging: outstanding > 30, 60, 90 days.",
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

          return {
            id: b.id,
            number: b.number,
            issued_at: b.issued_at,
            due_at: b.due_at,
            total: b.total,
            balance: b.balance,
            state: b.state,
            matter: b.matters?.[0] ?? null,
            days_outstanding: daysOutstanding,
            aging_flag,
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
