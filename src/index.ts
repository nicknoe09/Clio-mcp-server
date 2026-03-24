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
import { registerScorecardTools } from "./tools/scorecard";

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

    registerScorecardTools(server);
    console.log("[MCP] registerScorecardTools OK");

    console.log("[MCP] All 21 tools registered successfully");
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

    // Probe trust-related endpoints to find the right one
    const probes = [
      { name: "trust_line_items", ep: "/trust_line_items", p: { fields: "id", limit: 1 } },
      { name: "trust_requests", ep: "/trust_requests", p: { fields: "id", limit: 1 } },
      { name: "transactions", ep: "/transactions", p: { fields: "id", limit: 1 } },
      { name: "bank_transactions", ep: "/bank_transactions", p: { fields: "id", limit: 1 } },
      { name: "trust_ledger_entries", ep: "/trust_ledger_entries", p: { fields: "id", limit: 1 } },
      { name: "bank_accounts", ep: "/bank_accounts", p: { fields: "id,name,type,balance", limit: 1 } },
    ];

    for (const { name, ep, p } of probes) {
      try {
        const r = await rawGetSingle(ep, p);
        results[name] = { ok: true, count: r.meta?.records };
      } catch (e: any) { results[name] = { ok: false, error: e.response?.data?.error?.message ?? e.message }; }
    }

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
