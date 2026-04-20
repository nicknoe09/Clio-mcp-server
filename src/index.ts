import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ENV } from "./utils/env";
import { getAuthorizationUrl, exchangeCodeForTokens } from "./clio/auth";
import { getBoxAuthorizationUrl, exchangeBoxCodeForTokens } from "./box/auth";
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
import { registerCalcTools } from "./tools/calc";
import { registerDocumentTools } from "./tools/documents";
import { registerAuditTools } from "./tools/audit";
import { registerAuditTimeTools } from "./tools/auditTime";
import { registerReviewTools } from "./tools/review";
import { registerMorningReportTools } from "./tools/morningReport";
import reviewRouter from "./routes/review";

// Fail closed: refuse to start without a bearer secret. /sse + /messages
// expose every registered tool against the firm's shared Clio OAuth identity,
// so an unauthenticated deployment is a firm-wide data exposure.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
if (!MCP_AUTH_TOKEN) {
  throw new Error(
    "MCP_AUTH_TOKEN is required. Set it to a long random secret; MCP clients must send it as `Authorization: Bearer <token>` (or `?token=` on /sse).",
  );
}

const ALLOWED_ORIGINS = new Set(
  (process.env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const app = express();

// Only parse JSON on non-MCP routes — SSEServerTransport reads the raw body itself
app.use((req, res, next) => {
  if (req.path === "/messages") return next();
  express.json()(req, res, next);
});

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractBearer(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.slice(7).trim();
  const q = req.query.token;
  if (typeof q === "string" && q.length > 0) return q;
  return null;
}

// Blocks CSRF-style browser drive-by: EventSource can't set custom headers,
// so a page loaded in the token holder's browser could otherwise open an SSE
// stream using their ambient cookies. Non-browser clients don't send Origin.
function mcpGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    if (!ALLOWED_ORIGINS.has(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
  }

  const token = extractBearer(req);
  if (!token || !timingSafeEqualStr(token, MCP_AUTH_TOKEN)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

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
    registerCalcTools(server);
    console.log("[MCP] registerCalcTools OK");
    registerDocumentTools(server);
    console.log("[MCP] registerDocumentTools OK");
    registerAuditTools(server);
    console.log("[MCP] registerAuditTools OK");
    registerAuditTimeTools(server);
    console.log("[MCP] registerAuditTimeTools OK");
    registerMorningReportTools(server);
    console.log("[MCP] registerMorningReportTools OK");
    registerReviewTools(server);
    console.log("[MCP] registerReviewTools OK");

    console.log("[MCP] All tools registered successfully");
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

app.get("/sse", mcpGuard, async (req, res) => {
  console.log(
    `[MCP] /sse connect origin=${req.headers.origin || "none"} ua=${req.headers["user-agent"] || "none"} ip=${req.ip || "?"}`,
  );
  const transport = new SSEServerTransport("/messages", res);
  const mcpServer = createMcpServer();
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports[transport.sessionId];
  });

  await mcpServer.connect(transport);
});

app.post("/messages", mcpGuard, async (req, res) => {
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

// --- Review UI Routes ---
app.use(reviewRouter);

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

// --- Box OAuth ---
app.get("/box/oauth/start", (_req, res) => {
  const url = getBoxAuthorizationUrl();
  res.redirect(url);
});

app.get("/box/oauth/callback", async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  try {
    const { email } = await exchangeBoxCodeForTokens(code);
    res.send(
      `<h1>Box OAuth Complete</h1><p>Tokens saved for ${email}. You can close this window.</p>`
    );
  } catch (err: any) {
    res.status(500).send(`Box OAuth error: ${err.message}`);
  }
});

// --- Start Server ---
const PORT = ENV.PORT;
app.listen(PORT, () => {
  console.log(`Clio MCP Server running on port ${PORT}`);
  console.log(`  Health:   http://localhost:${PORT}/health`);
  console.log(`  SSE:      http://localhost:${PORT}/sse`);
  console.log(`  OAuth:    http://localhost:${PORT}/oauth/start`);
  console.log(`  Box OAuth: http://localhost:${PORT}/box/oauth/start`);
  console.log(
    `  Auth:     bearer required; origin allowlist size=${ALLOWED_ORIGINS.size}`,
  );
});
