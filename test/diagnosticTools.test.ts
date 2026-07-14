import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// auth modules have import-time env/network dependencies (JWKS, Postgres) —
// stub them exactly as test/mcpStatelessTransport.test.ts does, since app.ts
// (which owns createMcpServer) pulls them in.
vi.mock("../src/auth/microsoft", () => ({
  AuthError: class AuthError extends Error {
    code = "invalid_token";
  },
  verifyMicrosoftToken: async () => ({ email: "test@romanosumner.com" }),
  isEmailAllowed: () => true,
}));
vi.mock("../src/auth/vault", () => ({
  NotProvisionedError: class NotProvisionedError extends Error {},
  buildUserContext: async (email: string) => ({
    userEmail: email,
    accessToken: "test-clio-token",
    refreshToken: "",
  }),
  getUserByEmail: async () => null,
  getClioTokens: async () => null,
  updateClioTokens: async () => undefined,
  getBoxTokens: async () => null,
  updateBoxTokens: async () => undefined,
  resolveUploadKey: async () => null,
}));

import { createMcpServer } from "../src/app";

const DIAGNOSTIC_TOOLS = [
  "debug_bill_fields",
  "probe_billing_write_apis",
  "probe_clio_report_apis",
  "dump_compare_layout",
  "test_update_time_entry",
  "test_update_line_item",
];

async function listToolNames(): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools({ cursor });
    names.push(...page.tools.map((t) => t.name));
    cursor = page.nextCursor;
  } while (cursor);
  await client.close();
  await server.close();
  return names;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// Internal diagnostic/probe tools were showing up in the everyday connector
// tool list (reported 2026-07-03). They must register only when the
// deployment explicitly opts in with ENABLE_DIAGNOSTIC_TOOLS=true.
describe("diagnostic tool gating", () => {
  it("hides all diagnostic tools by default", async () => {
    vi.stubEnv("ENABLE_DIAGNOSTIC_TOOLS", "");
    const names = await listToolNames();
    for (const tool of DIAGNOSTIC_TOOLS) {
      expect(names, `${tool} should be hidden`).not.toContain(tool);
    }
    // Sanity: the everyday surface is still there.
    expect(names).toContain("get_bill_line_items");
    expect(names).toContain("get_time_entries");
    expect(names).toContain("audit_draft_bills");
  });

  it("registers diagnostic tools when ENABLE_DIAGNOSTIC_TOOLS=true", async () => {
    vi.stubEnv("ENABLE_DIAGNOSTIC_TOOLS", "true");
    const names = await listToolNames();
    for (const tool of DIAGNOSTIC_TOOLS) {
      expect(names, `${tool} should be registered`).toContain(tool);
    }
  });

  // Railway's dashboard stores whatever casing the operator typed; a strict
  // === "true" silently no-opped on "True" (2026-07-14). Accept the common
  // truthy spellings, keep rejecting everything else.
  it("accepts common truthy spellings (True, TRUE, 1, padded)", async () => {
    for (const value of ["True", "TRUE", "1", " true "]) {
      vi.stubEnv("ENABLE_DIAGNOSTIC_TOOLS", value);
      const names = await listToolNames();
      expect(names, `probe tools should register for ${JSON.stringify(value)}`).toContain(
        "probe_billing_write_apis"
      );
    }
  });

  it("still hides diagnostics for non-truthy values", async () => {
    for (const value of ["false", "0", "ture", "enabled"]) {
      vi.stubEnv("ENABLE_DIAGNOSTIC_TOOLS", value);
      const names = await listToolNames();
      expect(names, `probe tools should stay hidden for ${JSON.stringify(value)}`).not.toContain(
        "probe_billing_write_apis"
      );
    }
  });
});
