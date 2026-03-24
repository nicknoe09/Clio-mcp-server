import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllPages } from "../clio/pagination";

const BILL_FIELDS =
  "id,number,issued_at,due_at,balance,total,state,matters";

export function registerBillTools(server: McpServer): void {
  server.tool(
    "get_bills",
    "Get bills with filters. Flags aging: outstanding > 30, 60, 90 days.",
    {
      matter_id: z.number().optional().describe("Filter by matter ID"),
      client_id: z.number().optional().describe("Filter by client ID"),
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
}
