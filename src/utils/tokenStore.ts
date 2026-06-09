import https from "https";
import { als } from "../auth/identity";

const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";

// --- Clio Tokens (per-user) ---
//
// Clio tokens are no longer a single shared secret. Each /mcp request runs
// inside an AsyncLocalStorage scope (see auth/identity.ts) carrying the acting
// attorney's own Clio token, preloaded from the platform vault. getAccessToken
// stays SYNCHRONOUS so the central HTTP layer (clio/pagination.ts) and the ~18
// tool modules need no changes — they just read the in-flight context.

async function persistToRailway(): Promise<void> {
    const token = process.env.RAILWAY_API_TOKEN;
    const projectId = process.env.RAILWAY_PROJECT_ID;
    const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
    const serviceId = process.env.RAILWAY_SERVICE_ID;

  if (!token || !projectId || !environmentId || !serviceId) return;

  const variables: Record<string, string> = {
    BOX_USER_TOKENS: serializeBoxTokenMap(),
  };

  const body = JSON.stringify({
        query: `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
              variableCollectionUpsert(input: $input)
                  }`,
        variables: {
                input: {
                          projectId,
                          environmentId,
                          serviceId,
                          variables,
                },
        },
  });

  await new Promise<void>((resolve, reject) => {
        const req = https.request(
                RAILWAY_API_URL,
          {
                    method: "POST",
                    headers: {
                                "Content-Type": "application/json",
                                Authorization: `Bearer ${token}`,
                    },
          },
                (res) => {
                          res.resume();
                          res.on("end", resolve);
                }
              );
        req.on("error", reject);
        req.write(body);
        req.end();
  });
}

/**
 * Per-user Clio access token for the in-flight request. SYNCHRONOUS by design:
 * the token was preloaded into the request's ALS context before the MCP
 * handler ran. Throws (rather than returning "") when called outside a request
 * context or when the user has no usable Clio token, so failures are loud and
 * the message is actionable instead of producing a silent `Bearer ` 401.
 */
export function getAccessToken(): string {
    const ctx = als.getStore();
    if (!ctx) {
          throw new Error(
                "No user context: Clio access is only available inside an authenticated /mcp request.",
          );
    }
    if (!ctx.accessToken) {
          throw new Error(ctx.clioError || "No Clio access token available for this user.");
    }
    return ctx.accessToken;
}

export function getRefreshToken(): string {
    return als.getStore()?.refreshToken ?? "";
}

// --- Box Tokens (per-user by email) ---

interface BoxUserTokens {
  access: string;
  refresh: string;
}

const boxTokenMap = new Map<string, BoxUserTokens>();

// Load persisted Box tokens on startup
function loadBoxTokensFromEnv(): void {
  const raw = process.env.BOX_USER_TOKENS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, BoxUserTokens>;
      for (const [email, tokens] of Object.entries(parsed)) {
        boxTokenMap.set(email, tokens);
      }
      console.log(`[tokenStore] Loaded Box tokens for ${boxTokenMap.size} user(s)`);
    } catch (err) {
      console.error("[tokenStore] Failed to parse BOX_USER_TOKENS:", err);
    }
  }
}

loadBoxTokensFromEnv();

function serializeBoxTokenMap(): string {
  const obj: Record<string, BoxUserTokens> = {};
  for (const [email, tokens] of boxTokenMap) {
    obj[email] = tokens;
  }
  return JSON.stringify(obj);
}

export async function persistBoxTokens(email: string, access: string, refresh: string): Promise<void> {
  boxTokenMap.set(email.toLowerCase(), { access, refresh });
  console.log(`[tokenStore] Stored Box tokens for ${email} (${boxTokenMap.size} total Box users)`);
  await persistToRailway().catch((err) =>
    console.error("[tokenStore] Failed to persist Box tokens to Railway:", err)
  );
}

export function getBoxAccessToken(email: string): string {
  return boxTokenMap.get(email.toLowerCase())?.access ?? "";
}

export function getBoxRefreshToken(email: string): string {
  return boxTokenMap.get(email.toLowerCase())?.refresh ?? "";
}

export function isBoxUserRegistered(email: string): boolean {
  return boxTokenMap.has(email.toLowerCase());
}

export function getBoxRegisteredUsers(): string[] {
  return Array.from(boxTokenMap.keys());
}
