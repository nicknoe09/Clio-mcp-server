import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// auth/microsoft builds a remote JWKS at import time from strict env vars —
// mock the whole module. Everything the test needs is a verified email.
vi.mock("../src/auth/microsoft", () => ({
  AuthError: class AuthError extends Error {
    code = "invalid_token";
  },
  verifyMicrosoftToken: async () => ({ email: "test@romanosumner.com" }),
  isEmailAllowed: () => true,
}));

// auth/vault talks to the platform Postgres — stub every export other
// modules import so app.ts, clio/auth.ts, utils/box.ts and routes/upload.ts
// all resolve.
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

import { createApp } from "../src/app";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  Authorization: "Bearer test-jwt",
};

function postMcp(body: unknown): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Parse the JSON-RPC message(s) out of an SSE or JSON /mcp response body. */
async function readJsonRpc(res: globalThis.Response): Promise<any[]> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice("data: ".length)));
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Regression tests for the 2026-07-02 cross-wired-response bug: the old
// per-session shared StreamableHTTPServerTransport routed responses via a
// session-global map keyed only by JSON-RPC message id. Two concurrent
// requests with the same id (parallel subagents numbering independently)
// overwrote each other's routing entry, so each caller silently received the
// other's response. Stateless per-request transports make that impossible.
describe("stateless /mcp transport", () => {
  it("serves initialize without minting a session id", async () => {
    const res = await postMcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const [msg] = await readJsonRpc(res);
    expect(msg.id).toBe(1);
    expect(msg.result?.serverInfo?.name).toBe("clio-mcp");
  });

  it("routes concurrent requests with COLLIDING JSON-RPC ids to their own callers", async () => {
    // Same id (7) on both in-flight requests — the exact collision the shared
    // transport mis-routed. Different methods so a swap is detectable.
    const [listRes, callRes] = await Promise.all([
      postMcp({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
      postMcp({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "get_server_version", arguments: {} },
      }),
    ]);

    expect(listRes.status).toBe(200);
    expect(callRes.status).toBe(200);

    const listMsgs = await readJsonRpc(listRes);
    const callMsgs = await readJsonRpc(callRes);
    const listReply = listMsgs.find((m) => m.id === 7);
    const callReply = callMsgs.find((m) => m.id === 7);

    // tools/list caller must get a tool list…
    expect(listReply.result?.tools?.length).toBeGreaterThan(0);
    expect(listReply.result?.content).toBeUndefined();
    // …and the tools/call caller must get the tool result, not the list.
    expect(callReply.result?.content?.[0]?.text).toContain("git_sha");
    expect(callReply.result?.tools).toBeUndefined();
  });

  it("keeps many colliding concurrent tool calls each on their own response", async () => {
    // Ten concurrent tools/list requests, all id 3, interleaved with ten
    // tools/call requests, all also id 3. Every response must match its
    // request's method — any cross-wiring shows up as a mismatched shape.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0
          ? postMcp({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
          : postMcp({
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "get_server_version", arguments: {} },
            })
        ).then(async (res) => ({
          wantedList: i % 2 === 0,
          reply: (await readJsonRpc(res)).find((m) => m.id === 3),
        })),
      ),
    );
    for (const { wantedList, reply } of results) {
      if (wantedList) {
        expect(reply.result?.tools?.length).toBeGreaterThan(0);
      } else {
        expect(reply.result?.content?.[0]?.text).toContain("git_sha");
      }
    }
  });

  it("rejects GET and DELETE with 405 (no session stream to serve)", async () => {
    const get = await fetch(`${baseUrl}/mcp`, { headers: MCP_HEADERS });
    expect(get.status).toBe(405);
    const del = await fetch(`${baseUrl}/mcp`, { method: "DELETE", headers: MCP_HEADERS });
    expect(del.status).toBe(405);
  });

  it("still requires authentication", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });
});
