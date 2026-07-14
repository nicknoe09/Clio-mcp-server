// WebCrypto polyfill guard — jose needs globalThis.crypto (present on Node 18+,
// but make it explicit so this is the first thing that runs).
import { webcrypto } from "node:crypto";
if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}

import dotenv from "dotenv";
dotenv.config();

import { ENV } from "./utils/env";
import { createApp } from "./app";
import { diagnosticToolsEnabled } from "./utils/diagnostics";

const BASE_URL = ENV.PUBLIC_BASE_URL.replace(/\/$/, "");

// App construction (routes, auth, stateless /mcp transport) lives in app.ts so
// tests can drive the HTTP surface in-process; this file is just the entrypoint.
const app = createApp();

// --- Start Server ---
const PORT = ENV.PORT;
const httpServer = app.listen(PORT, () => {
  console.log(`Clio MCP Server running on port ${PORT}`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
  console.log(`  MCP:       http://localhost:${PORT}/mcp (Streamable HTTP, stateless)`);
  console.log(`  Discovery: ${BASE_URL}/.well-known/oauth-protected-resource`);
  console.log(`  Box OAuth: http://localhost:${PORT}/box/oauth/start`);
  console.log(`  Auth:      per-user Microsoft OAuth (Bearer JWT required)`);
  // Boot-visible so a mistyped flag value is diagnosable from deploy logs
  // instead of silently hiding the probe tools.
  console.log(
    `  Diag tools: ${diagnosticToolsEnabled() ? "ENABLED" : "disabled"} ` +
    `(ENABLE_DIAGNOSTIC_TOOLS=${JSON.stringify(process.env.ENABLE_DIAGNOSTIC_TOOLS ?? "(unset)")})`
  );
});
// Node's default keep-alive timeout (5s) is shorter than Railway's edge proxy
// idle timeout, so the proxy reuses sockets the server already closed —
// sporadic ECONNRESET/502 that the connector sees as a dropped connection.
httpServer.keepAliveTimeout = 75_000;
httpServer.headersTimeout = 80_000;
