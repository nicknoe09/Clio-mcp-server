import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ENV } from "./utils/env";
import { getAuthorizationUrl, exchangeCodeForTokens } from "./clio/auth";
import { registerMatterTools } from "./tools/matters";
import { registerTimeTools } from "./tools/time";
import { registerExpenseTools } from "./tools/expenses";
import { registerContactTools } from "./tools/contacts";
import { registerTaskTools } from "./tools/tasks";
import { registerBillTools } from "./tools/bills";
import { registerARTools } from "./tools/ar";
import { registerPerformanceTools } from "./tools/performance";
import { registerReconcileTools } from "./tools/reconcile";

const app = express();

// Only parse JSON on non-MCP routes — SSEServerTransport reads the raw body itself
app.use((req, res, next) => {
  if (req.path === "/messages") return next();
  express.json()(req, res, next);
});

// --- MCP Server Factory ---
function createMcpServer(): McpServer {
  try {
    const server = new McpServer({
      name: "clio-mcp",
      version: "1.0.0",
    });
    console.log("[MCP] McpServer instance created");

    registerMatterTools(server);
    console.log("[MCP] registerMatterTools OK");

    registerTimeTools(server);
    console.log("[MCP] registerTimeTools OK");

    registerExpenseTools(server);
    console.log("[MCP] registerExpenseTools OK");

    registerContactTools(server);
    console.log("[MCP] registerContactTools OK");

    registerTaskTools(server);
    console.log("[MCP] registerTaskTools OK");

    registerBillTools(server);
    console.log("[MCP] registerBillTools OK");

    registerARTools(server);
    console.log("[MCP] registerARTools OK");

    registerPerformanceTools(server);
    console.log("[MCP] registerPerformanceTools OK");

    registerReconcileTools(server);
    console.log("[MCP] registerReconcileTools OK");

    console.log("[MCP] All 19 tools registered successfully");
    return server;
  } catch (err: any) {
    console.error("[MCP] FATAL: tool registration failed");
    console.error(err.stack || err);
    throw err;
  }
}

// --- SSE Transport for Claude.ai ---
// Track active transports by session
const transports: Record<string, SSEServerTransport> = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const mcpServer = createMcpServer();
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports[transport.sessionId];
  });

  await mcpServer.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  if (!transport) {
    res.status(400).json({ error: "No active SSE session for this sessionId" });
    return;
  }
  await transport.handlePostMessage(req, res);
});

// --- Health Check ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "clio-mcp", version: "1.0.7", build: "cursor-pagination" });
});

// --- Debug: show query string construction ---
app.get("/debug-fields", (_req, res) => {
  const { buildQueryString } = require("./clio/pagination");
  const testFields = "id,date,quantity,price,total,note,type,billed,matter{id,display_number,description,client},user{id,name}";
  const qs = buildQueryString({ fields: testFields, limit: 200, type: "TimeEntry" });
  const fullUrl = `/activities?${qs}`;
  res.json({ fields_input: testFields, query_string: qs, full_url: fullUrl });
});

// --- Debug: compare rawGetSingle vs fetchAllPages ---
app.get("/debug-clio", async (_req, res) => {
  try {
    const { rawGetSingle } = require("./clio/pagination");
    const results: Record<string, any> = {};

    // Probe each endpoint with limit=1 to validate fields and params
    const probes: Record<string, Record<string, any>> = {
      // Activities - TimeEntry
      "activities_TimeEntry": { fields: "id,date,quantity,price,total,note,type,billed,matter{id,display_number,description,client},user{id,name}", type: "TimeEntry", limit: 1 },
      // Activities - ExpenseEntry (not "Expense")
      "activities_ExpenseEntry": { fields: "id,date,price,note,type,billed,matter{id,display_number,client},user{id,name},expense_category{name}", type: "ExpenseEntry", limit: 1 },
      // Activities - Expense (current code uses this)
      "activities_Expense": { fields: "id,date,price,note,type,billed,matter{id,display_number,client},user{id,name}", type: "Expense", limit: 1 },
      // Bills
      "bills_matters": { fields: "id,number,issued_at,due_at,balance,total,state,matters", limit: 1 },
      // Contacts - try different field names
      "contacts_matters": { fields: "id,name,type,email_addresses,phone_numbers,matters{id,display_number}", query: "a", limit: 1 },
      "contacts_matters_plain": { fields: "id,name,type,email_addresses,phone_numbers,matters", query: "a", limit: 1 },
      "contacts_no_matters": { fields: "id,name,first_name,last_name,type,email_addresses,phone_numbers", query: "a", limit: 1 },
      // Tasks - try status values
      "tasks_pending": { fields: "id,name,due_at,status,matter{id,display_number},assignee{id,name}", status: "pending", limit: 1 },
      "tasks_no_status": { fields: "id,name,due_at,status,matter{id,display_number},assignee{id,name}", limit: 1 },
      // Matters
      "matters": { fields: "id,display_number,description,status,client{id,name}", limit: 1 },
      // Bank accounts
      "bank_accounts": { fields: "id,name,type,balance", limit: 1 },
      // Trust ledger
      "trust_ledger": { fields: "id,date,amount,balance,description,type,matter{id,display_number,client},bank_account{id,name,type}", limit: 1 },
    };

    const endpoints: Record<string, string> = {
      activities_TimeEntry: "/activities", activities_ExpenseEntry: "/activities", activities_Expense: "/activities",
      bills_matters: "/bills",
      contacts_matters: "/contacts", contacts_matters_plain: "/contacts", contacts_no_matters: "/contacts",
      tasks_pending: "/tasks", tasks_no_status: "/tasks",
      matters: "/matters", bank_accounts: "/bank_accounts", trust_ledger: "/trust_ledger_entries",
    };

    for (const [name, params] of Object.entries(probes)) {
      try {
        const r = await rawGetSingle(endpoints[name], params);
        results[name] = { ok: true, count: r.meta?.records, sample: r.data?.[0] };
      } catch (e: any) { results[name] = { ok: false, error: e.response?.data?.error?.message ?? e.message }; }
    }
    res.json(results);
  } catch (err: any) {
    res.json({
      success: false,
      error: err.message,
      status: err.response?.status,
      clio_error: err.response?.data,
    });
  }
});

// --- OAuth Bootstrap ---
app.get("/oauth/start", (_req, res) => {
  const url = getAuthorizationUrl();
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  try {
    await exchangeCodeForTokens(code);
    res.send(
      "<h1>Clio OAuth Complete</h1><p>Tokens have been saved. You can close this window and start using the MCP server.</p>"
    );
  } catch (err: any) {
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

// --- Start Server ---
const PORT = ENV.PORT;
app.listen(PORT, () => {
  console.log(`Clio MCP Server running on port ${PORT}`);
  console.log(`  Health:   http://localhost:${PORT}/health`);
  console.log(`  SSE:      http://localhost:${PORT}/sse`);
  console.log(`  OAuth:    http://localhost:${PORT}/oauth/start`);
});
