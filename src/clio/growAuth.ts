import axios from "axios";
import { randomBytes } from "node:crypto";
import https from "https";
import { ENV } from "../utils/env";
import { als, updateContextGrowTokens } from "../auth/identity";
import { getUserByEmail, upsertGrowTokens } from "../auth/vault";

/**
 * OAuth flow for the Clio Grow API (Clio Platform app).
 *
 * Grow API access is granted per-application in the new developer portal
 * (developers.api.clio.com), separately from the legacy Manage app. Tokens
 * minted by that app are per-attorney; the connect flow lives on this server
 * (/grow/oauth/start → Clio → /grow/oauth/callback) and stores each user's
 * pair in the platform vault under provider 'clio_grow'.
 *
 * The attorney is identified the same way the Box flow identifies its user:
 * after the code exchange we call the Grow API's own who_am_i with the new
 * token, and match its email to a provisioned platform user.
 */

// --- CSRF state (single-instance in-memory; entries expire after 10 min) ---

const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

export function issueOAuthState(): string {
  // Prune expired entries opportunistically so the map can't grow unbounded.
  const now = Date.now();
  for (const [s, exp] of pendingStates) {
    if (exp < now) pendingStates.delete(s);
  }
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, now + STATE_TTL_MS);
  return state;
}

export function consumeOAuthState(state: string | undefined): boolean {
  if (!state) return false;
  const exp = pendingStates.get(state);
  pendingStates.delete(state);
  return exp !== undefined && exp >= Date.now();
}

// --- Authorization URL ---

export function getGrowAuthorizationUrl(state: string): string {
  if (!ENV.GROW_CLIENT_ID) {
    throw new Error("GROW_CLIENT_ID is not set — add the Clio Platform app credentials first.");
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: ENV.GROW_CLIENT_ID,
    redirect_uri: ENV.GROW_REDIRECT_URI,
    state,
  });
  if (ENV.GROW_OAUTH_SCOPE) params.set("scope", ENV.GROW_OAUTH_SCOPE);
  return `${ENV.GROW_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

// --- Code exchange + user identification ---

interface GrowTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function postTokenGrant(params: URLSearchParams): Promise<GrowTokenResponse> {
  const response = await axios.post(ENV.GROW_OAUTH_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return response.data;
}

/** GET the Grow who_am_i with an explicit token (outside any request context). */
function growWhoAmIWithToken(accessToken: string): Promise<any> {
  const base = ENV.GROW_API_BASE_URL.replace(/\/$/, "");
  const url = new URL(`${base}/users/who_am_i`);
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(body));
              } catch {
                reject(new Error(`who_am_i returned unparseable body: ${body.slice(0, 200)}`));
              }
            } else {
              reject(new Error(`who_am_i failed with status ${res.statusCode}: ${body.slice(0, 300)}`));
            }
          });
        }
      )
      .on("error", reject);
  });
}

function expiryFrom(expiresIn: number | undefined): Date | null {
  return typeof expiresIn === "number" ? new Date(Date.now() + expiresIn * 1000) : null;
}

/**
 * Exchange the authorization code, identify the attorney via Grow who_am_i,
 * and persist the token pair to the vault under provider 'clio_grow'.
 */
export async function exchangeGrowCodeForTokens(code: string): Promise<{ email: string }> {
  const tokens = await postTokenGrant(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: ENV.GROW_CLIENT_ID,
      client_secret: ENV.GROW_CLIENT_SECRET,
      redirect_uri: ENV.GROW_REDIRECT_URI,
    })
  );

  const me = await growWhoAmIWithToken(tokens.access_token);
  const email = String(me?.data?.email ?? "").trim().toLowerCase();
  if (!email) {
    throw new Error("Grow who_am_i returned no email — cannot attribute the tokens to a user.");
  }

  const user = await getUserByEmail(email);
  if (!user) {
    throw new Error(
      `Grow account ${email} is not a provisioned platform user — provision them on the platform first.`
    );
  }

  await upsertGrowTokens(
    user.id,
    tokens.access_token,
    tokens.refresh_token ?? "",
    expiryFrom(tokens.expires_in)
  );
  console.log(`[grow-oauth] stored Grow tokens for ${email}`);
  return { email };
}

/**
 * Refresh the in-flight attorney's Grow access token (mirrors
 * clio/auth.ts:refreshAccessToken for the 'clio_grow' provider row).
 */
export async function refreshGrowAccessToken(): Promise<string> {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error("No user context: cannot refresh Grow token outside an /mcp request.");
  }
  const refreshToken = ctx.growRefreshToken;
  if (!refreshToken) {
    throw new Error(
      "No Grow refresh token for your account — reconnect at /grow/oauth/start."
    );
  }

  const tokens = await postTokenGrant(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ENV.GROW_CLIENT_ID,
      client_secret: ENV.GROW_CLIENT_SECRET,
      refresh_token: refreshToken,
    })
  );

  const newRefresh = tokens.refresh_token || refreshToken;
  // Context first so the immediate retry uses the new token, then persist.
  updateContextGrowTokens(tokens.access_token, newRefresh);
  await upsertGrowTokens(ctx.userId, tokens.access_token, newRefresh, expiryFrom(tokens.expires_in));
  return tokens.access_token;
}
