// WebCrypto polyfill guard — jose needs globalThis.crypto (present on Node 18+,
// but make it explicit so this is the first thing that runs).
import { webcrypto } from "node:crypto";
if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}

import dotenv from "dotenv";
dotenv.config();

import { randomUUID } from "node:crypto";
import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ENV } from "./utils/env";
import { als } from "./auth/identity";
import { verifyMicrosoftToken, isEmailAllowed, AuthError } from "./auth/microsoft";
import { buildUserContext, NotProvisionedError } from "./auth/vault";
import { registerOAuthProxyRoutes } from "./auth/oauthProxy";
import { getBoxAuthorizationUrl, exchangeBoxCodeForTokens } from "./box/auth";
import { registerMatterTools } from "./tools/matters";
import { registerMatterFinancialsTools } from "./tools/matterFinancials";
import { registerTimeTools } from "./tools/time";
import { registerExpenseTools } from "./tools/expenses";
import { registerContactTools } from "./tools/contacts";
import { registerTaskTools } from "./tools/tasks";
import { registerBillTools } from "./tools/bills";
import { registerPaymentTools } from "./tools/payments";
import { registerARTools } from "./tools/ar";
import { registerPerformanceTools } from "./tools/performance";
import { registerReconcileTools } from "./tools/reconcile";
import { registerScorecardTools } from "./tools/scorecard";
import { registerCalendarTools } from "./tools/calendar";
import { registerCustomFieldTools } from "./tools/customFields";
import { registerCalcTools } from "./tools/calc";
import { registerDocumentTools } from "./tools/documents";
import { registerAuditTools } from "./tools/audit";
import { registerAuditTimeTools } from "./tools/auditTime";
import { registerReviewTools } from "./tools/review";
import { registerMorningReportTools } from "./tools/morningReport";
import { registerVersionTools } from "./tools/version";
import { registerWhoAmITools } from "./tools/whoami";
import reviewRouter from "./routes/review";
import uploadRouter from "./routes/upload";
import { getDownload } from "./utils/downloadStore";

const BASE_URL = ENV.PUBLIC_BASE_URL.replace(/\/$/, "");

const app = express();
// Streamable HTTP works on the PARSED JSON body (unlike the old SSE /messages
// route, which read the raw body). Parse JSON globally; the /token proxy adds
// its own urlencoded parser at the route level.
app.use(express.json({ limit: "10mb" }));

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

    registerMatterFinancialsTools(server);
    console.log("[MCP] registerMatterFinancialsTools OK");

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

    registerPaymentTools(server);
    console.log("[MCP] registerPaymentTools OK");

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
    registerCustomFieldTools(server);
    console.log("[MCP] registerCustomFieldTools OK");
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
    registerVersionTools(server);
    console.log("[MCP] registerVersionTools OK");
    registerWhoAmITools(server);
    console.log("[MCP] registerWhoAmITools OK");

    console.log("[MCP] All tools registered successfully");
    return server;
  } catch (err: any) {
    console.error("[MCP] FATAL: tool registration failed");
    console.error(err.stack || err);
    throw err;
  }
}

// --- OAuth discovery + proxy (how the connector logs in via Microsoft) ---
registerOAuthProxyRoutes(app);

// --- Auth gate (per-user Microsoft identity) ---
function send401(res: Response): void {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer realm="clio-mcp", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`
  );
  res.status(401).json({ error: "unauthorized" });
}

// Don't confirm a session exists to the wrong identity — return 404.
function sessionNotFound(res: Response): void {
  res.status(404).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Session not found" },
    id: null,
  });
}

/**
 * Validate the Bearer JWT from the Authorization header (never `?token=`).
 * Returns the verified, allowlisted email, or sends 401 and returns null.
 */
async function authenticate(req: Request, res: Response): Promise<string | null> {
  const header = req.headers.authorization;
  const token = header && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    send401(res);
    return null;
  }
  let email: string;
  try {
    ({ email } = await verifyMicrosoftToken(token));
  } catch (err) {
    console.warn(`[auth] token rejected: ${err instanceof AuthError ? err.code : "invalid_token"}`);
    send401(res);
    return null;
  }
  if (!isEmailAllowed(email)) {
    console.warn("[auth] authenticated email is not on the onboarding allowlist");
    send401(res);
    return null;
  }
  return email;
}

// --- Streamable HTTP transport at /mcp (stateful, per-session) ---
const transports: Record<string, StreamableHTTPServerTransport> = {};
const sessionEmail: Record<string, string> = {};

app.post("/mcp", async (req: Request, res: Response) => {
  const email = await authenticate(req, res);
  if (!email) return;

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    // Existing session: the JWT email must match the email bound at init.
    if (sessionEmail[sessionId] !== email) {
      sessionNotFound(res);
      return;
    }
    transport = transports[sessionId];
  } else if (sessionId) {
    // Stale session id — sessions live in memory, so every restart/redeploy
    // forgets them. The spec requires 404 here: that's the signal the client
    // uses to re-initialize transparently. (A 400 surfaces to the user as a
    // dropped connection that needs a manual reconnect.)
    sessionNotFound(res);
    return;
  } else if (isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
        sessionEmail[sid] = email; // bind session -> verified identity
        console.log(`[MCP] session ${sid.slice(0, 8)}… initialized`);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        delete transports[sid];
        delete sessionEmail[sid];
      }
    };
    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid session id" },
      id: null,
    });
    return;
  }

  // Preload the user's Clio token from the vault, then run the handler inside
  // the per-request identity context so pagination.ts reads the right token.
  let ctx;
  try {
    ctx = await buildUserContext(email);
  } catch (err) {
    if (err instanceof NotProvisionedError) {
      send401(res);
      return;
    }
    console.error("[MCP] failed to build user context:", (err as Error).message);
    res.status(503).json({
      jsonrpc: "2.0",
      error: { code: -32002, message: "User vault temporarily unavailable" },
      id: null,
    });
    return;
  }

  await als.run(ctx, () => transport.handleRequest(req, res, req.body));
});

// GET (server->client notification stream) and DELETE (session teardown).
async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const email = await authenticate(req, res);
  if (!email) return;

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId] || sessionEmail[sessionId] !== email) {
    sessionNotFound(res);
    return;
  }
  const transport = transports[sessionId];

  let ctx;
  try {
    ctx = await buildUserContext(email);
  } catch (err) {
    if (err instanceof NotProvisionedError) {
      send401(res);
      return;
    }
    res.status(503).json({ error: "vault_unavailable" });
    return;
  }

  await als.run(ctx, () => transport.handleRequest(req, res));
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

// --- Health Check ---
// Reports the deployed git SHA via RAILWAY_GIT_COMMIT_SHA (Railway sets this
// automatically on each deploy). Lets callers verify "is my latest commit
// actually live?" without guessing at deploy timing.
const DEPLOY_SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT_SHA ||
  process.env.SOURCE_VERSION || // Heroku
  "unknown";
const DEPLOY_BRANCH = process.env.RAILWAY_GIT_BRANCH || process.env.GIT_BRANCH || "unknown";
const STARTED_AT = new Date().toISOString();
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    server: "clio-mcp",
    version: "1.1.0",
    build: "all-tools",
    transport: "streamable-http",
    git_sha: DEPLOY_SHA,
    git_sha_short: DEPLOY_SHA === "unknown" ? "unknown" : DEPLOY_SHA.slice(0, 7),
    git_branch: DEPLOY_BRANCH,
    started_at: STARTED_AT,
  });
});

// --- Token-addressed file downloads (Box upload fallback) ---
// No auth: the unguessable token IS the authorization. See utils/downloadStore.ts.
app.get("/download/:token", (req, res) => {
  const token = req.params.token;
  const entry = getDownload(token);
  if (!entry) {
    console.warn(`[Download] 404 token=${token.slice(0, 8)}…`);
    res.status(404).json({ error: "Download not found or expired" });
    return;
  }
  const safeName = entry.filename.replace(/["\\\r\n]/g, "");
  res.setHeader("Content-Type", entry.mimetype);
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.setHeader("Content-Length", entry.buffer.length.toString());
  res.setHeader("Cache-Control", "private, no-store");
  console.log(
    `[Download] served filename=${entry.filename} size_kb=${Math.round(entry.buffer.length / 1024)} token=${token.slice(0, 8)}…`,
  );
  res.end(entry.buffer);
});

// --- Review UI Routes ---
app.use(reviewRouter);

// --- Binary upload → Box (auth via X-Upload-Secret; see routes/upload.ts) ---
app.use(uploadRouter);

// --- Box OAuth (unchanged — out of scope) ---
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
const httpServer = app.listen(PORT, () => {
  console.log(`Clio MCP Server running on port ${PORT}`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
  console.log(`  MCP:       http://localhost:${PORT}/mcp (Streamable HTTP)`);
  console.log(`  Discovery: ${BASE_URL}/.well-known/oauth-protected-resource`);
  console.log(`  Box OAuth: http://localhost:${PORT}/box/oauth/start`);
  console.log(`  Auth:      per-user Microsoft OAuth (Bearer JWT required)`);
});
// Node's default keep-alive timeout (5s) is shorter than Railway's edge proxy
// idle timeout, so the proxy reuses sockets the server already closed —
// sporadic ECONNRESET/502 that the connector sees as a dropped connection.
httpServer.keepAliveTimeout = 75_000;
httpServer.headersTimeout = 80_000;
