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

    console.log("[MCP] All 23 tools registered successfully");
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
  res.json({ status: "ok", server: "clio-mcp", version: "1.1.0", build: "all-tools" });
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
        from: "2026-03-01T00:00:00+00:00",
        to: "2026-03-31T23:59:59+00:00",
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

// --- Debug: timing breakdown for fee_allocation ---
app.get("/debug-timing", async (_req, res) => {
  try {
    const { fetchAllPages } = require("./clio/pagination");
    const timings: Record<string, any> = {};
    let t0 = Date.now();

    // Step 1: Fetch allocations for March
    const allAllocations = await fetchAllPages("/allocations", {
      fields: "id,amount,date,bill{id,number},matter{id,display_number}",
      created_since: "2026-03-01T00:00:00+00:00",
    });
    timings.allocations_fetch_ms = Date.now() - t0;
    const allocations = allAllocations.filter((a: any) =>
      a.date && a.date >= "2026-03-01" && a.date <= "2026-03-25" && a.amount > 0
    );
    timings.total_allocations = allAllocations.length;
    timings.filtered_allocations = allocations.length;
    const matterIds = [...new Set(allocations.map((a: any) => a.matter?.id).filter(Boolean))];
    timings.unique_matters = matterIds.length;

    // Step 2: Fetch entries for first 3 matters only (sample)
    t0 = Date.now();
    const sampleMatters = matterIds.slice(0, 3);
    for (const mid of sampleMatters) {
      const entries = await fetchAllPages("/activities", {
        type: "TimeEntry",
        billed: true,
        fields: "id,quantity,price,user{id,name}",
        matter_id: mid,
      });
      timings[`matter_${mid}_entries`] = entries.length;
    }
    timings.sample_entries_fetch_ms = Date.now() - t0;

    res.json(timings);
  } catch (err: any) {
    res.json({ error: err.message, status: err.response?.status });
  }
});

// --- Debug: test bill_id filter + timing ---
app.get("/debug-billfilter", async (_req, res) => {
  try {
    const { fetchAllPages, rawGetSingle } = require("./clio/pagination");
    const t0 = Date.now();

    // Step 1: Get allocations for Feb
    const allocs = await fetchAllPages("/allocations", {
      fields: "id,date,bill{id}",
      created_since: "2026-02-01T00:00:00+00:00",
    });
    const febAllocs = allocs.filter((a: any) => a.date >= "2026-02-01" && a.date <= "2026-02-28");
    const billIds = [...new Set(febAllocs.map((a: any) => a.bill?.id).filter(Boolean))];
    const t1 = Date.now();

    // Step 2: Test if bill_id filter works on activities
    const testBillId = billIds[0];
    const filtered = await rawGetSingle("/activities", {
      type: "TimeEntry", billed: true, bill_id: testBillId,
      fields: "id,quantity,price,bill{id},user{id,name}", limit: 5,
    });
    const t2 = Date.now();

    // Step 3: Test without bill_id filter for comparison
    const unfiltered = await rawGetSingle("/activities", {
      type: "TimeEntry", billed: true,
      fields: "id,quantity,price,bill{id},user{id,name}", limit: 5,
    });
    const t3 = Date.now();

    res.json({
      allocs_ms: t1 - t0,
      total_feb_allocs: febAllocs.length,
      unique_bills: billIds.length,
      test_bill_id: testBillId,
      filtered_count: filtered.meta?.records,
      filtered_sample: filtered.data,
      filtered_ms: t2 - t1,
      unfiltered_total: unfiltered.meta?.records,
      unfiltered_ms: t3 - t2,
    });
  } catch (err: any) {
    res.json({ error: err.message, status: err.response?.status });
  }
});

// --- Debug: probe Clio reports API ---
app.get("/debug-reports", async (_req, res) => {
  try {
    const { rawGetSingle } = require("./clio/pagination");
    const results: Record<string, any> = {};

    const endpoints = [
      { name: "reports", ep: "/reports", p: { limit: 2 } },
      { name: "report_presets", ep: "/report_presets", p: { limit: 2 } },
      { name: "report_schedules", ep: "/report_schedules", p: { limit: 2 } },
      { name: "billing_reports", ep: "/billing_reports", p: { limit: 2 } },
      { name: "collection_reports", ep: "/collection_reports", p: { limit: 2 } },
      { name: "fee_allocations", ep: "/fee_allocations", p: { limit: 2 } },
      { name: "payment_allocations", ep: "/payment_allocations", p: { limit: 2 } },
      { name: "line_items_minimal", ep: "/line_items", p: { fields: "id,total,quantity,price,type", limit: 2 } },
      { name: "line_items_with_bill_user", ep: "/line_items", p: { fields: "id,total,type,bill,user", limit: 2 } },
      { name: "line_items_default", ep: "/line_items", p: { limit: 2 } },
    ];

    for (const { name, ep, p } of endpoints) {
      try {
        const r = await rawGetSingle(ep, p);
        results[name] = { ok: true, count: r.meta?.records, sample: r.data };
      } catch (e: any) {
        results[name] = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
      }
    }

    res.json(results);
  } catch (err: any) {
    res.json({ error: err.message, status: err.response?.status });
  }
});

// --- Debug: probe allocation fields ---
app.get("/debug-alloc-fields", async (_req, res) => {
  try {
    const { rawGetSingle } = require("./clio/pagination");
    const results: Record<string, any> = {};

    const probes = [
      { name: "alloc_all_fields", ep: "/allocations", p: { fields: "id,date,amount,description,type,category,kind,parent,bill{id,number,state},matter{id},contact{id,name}", limit: 5 } },
      { name: "alloc_with_parent_type", ep: "/allocations", p: { fields: "id,date,amount,parent{id,type}", limit: 5 } },
      { name: "alloc_feb_sample", ep: "/allocations", p: { fields: "id,date,amount,description,bill{id,number}", created_since: "2026-02-01T00:00:00+00:00", limit: 10 } },
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

// --- Debug: find all allocation parent types ---
app.get("/debug-alloc-types", async (_req, res) => {
  try {
    const { fetchAllPages } = require("./clio/pagination");
    // Get Feb 2026 allocations with parent type
    const allocs = await fetchAllPages("/allocations", {
      fields: "id,date,amount,description,parent{id,type},bill{id,number},matter{id}",
      created_since: "2026-02-01T00:00:00+00:00",
    });
    const febAllocs = allocs.filter((a: any) => a.date >= "2026-02-01" && a.date <= "2026-02-28");

    // Group by parent type
    const byType: Record<string, { count: number; total: number; samples: any[] }> = {};
    for (const a of febAllocs) {
      const ptype = a.parent?.type ?? "unknown";
      if (!byType[ptype]) byType[ptype] = { count: 0, total: 0, samples: [] };
      byType[ptype].count++;
      byType[ptype].total += a.amount || 0;
      if (byType[ptype].samples.length < 3) byType[ptype].samples.push(a);
    }

    // Round totals
    for (const t of Object.values(byType)) {
      t.total = Math.round(t.total * 100) / 100;
    }

    res.json({ total_feb_allocations: febAllocs.length, by_parent_type: byType });
  } catch (err: any) {
    res.json({ error: err.message });
  }
});

// --- Debug: probe reports + line_items structure ---
app.get("/debug-reports2", async (_req, res) => {
  try {
    const { rawGetSingle } = require("./clio/pagination");
    const results: Record<string, any> = {};

    // 1. Reports with fields
    try {
      const r = await rawGetSingle("/reports", { fields: "id,name,type,category", limit: 5 });
      results.reports = { ok: true, count: r.meta?.records, sample: r.data };
    } catch (e: any) {
      results.reports = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
    }

    // 2. Report presets with fields
    try {
      const r = await rawGetSingle("/report_presets", { fields: "id,name,type,category", limit: 5 });
      results.report_presets = { ok: true, count: r.meta?.records, sample: r.data };
    } catch (e: any) {
      results.report_presets = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
    }

    // 3. Line items full structure with bill+user+matter
    try {
      const r = await rawGetSingle("/line_items", {
        fields: "id,total,quantity,price,type,date,bill{id,number,state},user{id,name},matter{id,display_number}",
        limit: 3,
      });
      results.line_items_full = { ok: true, count: r.meta?.records, sample: r.data };
    } catch (e: any) {
      results.line_items_full = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
    }

    // 4. Line items filtered to paid bills
    try {
      const r = await rawGetSingle("/line_items", {
        fields: "id,total,type,bill{id,number},user{id,name}",
        bill_state: "paid",
        limit: 3,
      });
      results.line_items_paid = { ok: true, count: r.meta?.records, sample: r.data };
    } catch (e: any) {
      results.line_items_paid = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
    }

    // 5. Line items filtered by specific bill_id
    try {
      const r = await rawGetSingle("/line_items", {
        fields: "id,total,type,bill{id,number},user{id,name}",
        bill_id: 5049358,
        limit: 3,
      });
      results.line_items_by_bill = { ok: true, count: r.meta?.records, sample: r.data };
    } catch (e: any) {
      results.line_items_by_bill = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
    }

    res.json(results);
  } catch (err: any) {
    res.json({ error: err.message, status: err.response?.status });
  }
});

// --- Debug: probe Clio API for line items and bill associations ---
app.get("/debug-alloc", async (_req, res) => {
  try {
    const { rawGetSingle } = require("./clio/pagination");
    const results: Record<string, any> = {};

    // 1. Check if /line_items endpoint exists and what fields it supports
    try {
      const r = await rawGetSingle("/line_items", {
        fields: "id,amount,date,description,quantity,price,type,bill{id,number},matter{id},user{id,name},activity{id}",
        limit: 3,
      });
      results.line_items = { ok: true, count: r.meta?.records, sample: r.data };
    } catch (e: any) {
      results.line_items = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
    }

    // 2a. Check if /bills can include line_items as a nested field (flat)
    try {
      const r = await rawGetSingle("/bills", {
        fields: "id,number,state,total,balance,issued_at,due_at,line_items",
        limit: 2,
      });
      results.bills_with_line_items_flat = { ok: true, count: r.meta?.records, sample: r.data };
    } catch (e: any) {
      results.bills_with_line_items_flat = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
    }

    // 2b. Check if /bills can include line_items with nested fields
    try {
      const r = await rawGetSingle("/bills", {
        fields: "id,number,state,total,balance,matters,line_items{id,amount,user}",
        limit: 2,
      });
      results.bills_with_line_items_nested = { ok: true, count: r.meta?.records, sample: r.data };
    } catch (e: any) {
      results.bills_with_line_items_nested = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
    }

    // 3. Check /activities with bill association
    try {
      const r = await rawGetSingle("/activities", {
        fields: "id,date,quantity,price,bill{id,number,state},user{id,name},matter{id}",
        limit: 2,
      });
      results.activities_with_bill = { ok: true, count: r.meta?.records, sample: r.data };
    } catch (e: any) {
      results.activities_with_bill = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
    }

    // 4a. Check if /bill_line_items endpoint exists
    try {
      const r = await rawGetSingle("/bill_line_items", {
        fields: "id,amount",
        limit: 2,
      });
      results.bill_line_items = { ok: true, count: r.meta?.records, sample: r.data };
    } catch (e: any) {
      results.bill_line_items = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
    }

    // 4b. Check if /invoice_line_items endpoint exists
    try {
      const r = await rawGetSingle("/invoice_line_items", {
        fields: "id,amount",
        limit: 2,
      });
      results.invoice_line_items = { ok: true, count: r.meta?.records, sample: r.data };
    } catch (e: any) {
      results.invoice_line_items = { ok: false, status: e.response?.status, error: e.response?.data?.error?.message ?? e.message };
    }

    res.json(results);
  } catch (err: any) {
    res.json({ error: err.message, status: err.response?.status });
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
