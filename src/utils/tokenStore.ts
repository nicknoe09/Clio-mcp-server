import https from "https";

const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";

// --- Clio Tokens (single-user) ---

async function persistToRailway(): Promise<void> {
    const token = process.env.RAILWAY_API_TOKEN;
    const projectId = process.env.RAILWAY_PROJECT_ID;
    const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
    const serviceId = process.env.RAILWAY_SERVICE_ID;

  if (!token || !projectId || !environmentId || !serviceId) return;

  const variables: Record<string, string> = {
    CLIO_ACCESS_TOKEN: process.env.CLIO_ACCESS_TOKEN ?? "",
    CLIO_REFRESH_TOKEN: process.env.CLIO_REFRESH_TOKEN ?? "",
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

export async function persistTokens(access: string, refresh: string): Promise<void> {
    process.env.CLIO_ACCESS_TOKEN = access;
    process.env.CLIO_REFRESH_TOKEN = refresh;
    await persistToRailway().catch((err) =>
          console.error("[tokenStore] Failed to persist tokens to Railway:", err)
                                                    );
}

export function getAccessToken(): string {
    return process.env.CLIO_ACCESS_TOKEN ?? "";
}

export function getRefreshToken(): string {
    return process.env.CLIO_REFRESH_TOKEN ?? "";
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
