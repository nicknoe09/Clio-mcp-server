import { describe, it, expect } from "vitest";

process.env.GROW_CLIENT_ID = "test-grow-client";
process.env.GROW_CLIENT_SECRET = "test-grow-secret";
process.env.GROW_REDIRECT_URI = "https://example.test/grow/oauth/callback";
delete process.env.GROW_OAUTH_SCOPE; // exercise the default

import {
  issueOAuthState,
  consumeOAuthState,
  getGrowAuthorizationUrl,
} from "../src/clio/growAuth";

describe("Grow OAuth state", () => {
  it("issues single-use states", () => {
    const state = issueOAuthState();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(consumeOAuthState(state)).toBe(true);
    // Single-use: a second consume of the same state fails.
    expect(consumeOAuthState(state)).toBe(false);
  });

  it("rejects unknown or missing states", () => {
    expect(consumeOAuthState("not-a-real-state")).toBe(false);
    expect(consumeOAuthState(undefined)).toBe(false);
  });
});

describe("getGrowAuthorizationUrl", () => {
  it("builds the authorize URL with code flow params and state", () => {
    const url = new URL(getGrowAuthorizationUrl("abc123"));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-grow-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.test/grow/oauth/callback");
    expect(url.searchParams.get("state")).toBe("abc123");
    // account.clio.com (Hydra) requires a scope; default is "openid".
    expect(url.searchParams.get("scope")).toBe("openid");
  });
});
