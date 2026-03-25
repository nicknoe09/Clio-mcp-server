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
import { registerCalendarTools } from "./tools/calendar";

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
    registerCalendarTools(server);
    console.log("[MCP] registerCalendarTools OK");

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

// --- Debug: probe Clio API endpoints ---
app.get("/debug-clio", async (_req, res) => {
  try {
    const { rawGetSingle } = require("./clio/pagination");
    const results: Record<string, any> = {};

    const probes = [
      // Payment associations
      { name: "payment_bill", ep: "/payments", p: { fields: "id,amount,date,description,bill{id,number}", limit: 2 } },
      { name: "payment_matter", ep: "/payments", p: { fields: "id,amount,date,matter{id}", limit: 2 } },
      { name: "payment_type_state", ep: "/payments", p: { fields: "id,amount,date,type,state,method", limit: 2 } },
      { name: "payment_contact", ep: "/payments", p: { fields: "id,amount,date,contact{id,name}", limit: 2 } },
      // Allocation associations
      { name: "alloc_bill", ep: "/allocations", p: { fields: "id,amount,date,bill{id,number}", limit: 2 } },
      { name: "alloc_matter", ep: "/allocations", p: { fields: "id,amount,date,matter{id}", limit: 2 } },
      { name: "alloc_contact", ep: "/allocations", p: { fields: "id,amount,date,contact{id,name}", limit: 2 } },
      { name: "alloc_parent", ep: "/allocations", p: { fields: "id,amount,date,parent{id}", limit: 2 } },
      // Calendar full fields
      { name: "calendar_full", ep: "/calendar_entries", p: { fields: "id,summary,description,start_at,end_at,all_day,location,matter{id,display_number},attendees,calendar_owner{id,name}", limit: 2 } },
    ];

    for (const { name, ep, p } of probes) {
      try {
        const r = await rawGetSingle(ep, p);
        results[name] = { ok: true, count: r.meta?.records, sample: r.data };
      } catch (e: any) {
        results[name] = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
      }
    }

    res.json(results);
  } catch (err: any) {
    res.json({ error: err.message });
  }
});

// --- Debug: test new tools via HTTP so we don't need MCP reconnect ---
app.get("/debug-test", async (req, res) => {
  try {
    const tool = req.query.tool as string;
    const { fetchAllPages, rawGetSingle, rawPostSingle } = require("./clio/pagination");

    if (tool === "calendar") {
      const entries = await fetchAllPages("/calendar_entries", {
        fields: "id,summary,start_at,end_at,matter{id,display_number},calendar_owner{id,name}",
        from: "2026-03-01",
        to: "2026-03-31",
        limit: 5,
      });
      res.json({ ok: true, count: entries.length, sample: entries.slice(0, 3) });
    } else if (tool === "fee_allocation") {
      const allocs = await fetchAllPages("/allocations", {
        fields: "id,amount,date,bill{id,number},matter{id,display_number}",
        created_since: "2026-03-01T00:00:00+00:00",
        limit: 5,
      });
      const filtered = allocs.filter((a: any) => a.date >= "2026-03-01" && a.date <= "2026-03-31");
      res.json({ ok: true, total_allocations: filtered.length, sample: filtered.slice(0, 3) });
    } else if (tool === "responsible_collections") {
      // Quick sanity test — just verify allocations + time entries fetch works
      const allocs = await fetchAllPages("/allocations", {
        fields: "id,amount,date,matter{id}",
        created_since: "2026-03-01T00:00:00+00:00",
        limit: 5,
      });
      res.json({ ok: true, alloc_count: allocs.length, sample: allocs.slice(0, 2) });
    } else {
      res.json({ error: "Use ?tool=calendar|fee_allocation|responsible_collections" });
    }
  } catch (err: any) {
    res.json({ error: err.message, status: err.response?.status, clio_error: err.response?.data });
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
