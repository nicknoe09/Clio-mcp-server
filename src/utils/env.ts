import dotenv from "dotenv";
dotenv.config();

export function getEnv(key: string, fallback?: string): string {
    const value = process.env[key] ?? fallback;
    if (value === undefined) {
          throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

export const ENV = {
    PORT: parseInt(getEnv("PORT", "3000"), 10),
    get CLIO_BASE_URL() { return getEnv("CLIO_BASE_URL", "https://app.clio.com"); },
    get CLIO_API_BASE_URL() { return getEnv("CLIO_API_BASE_URL", "https://app.clio.com/api/v4"); },
    // CLIO_CLIENT_ID / SECRET are still required — they refresh each attorney's
    // per-user Clio token (must be the SAME Clio OAuth app the platform uses).
    get CLIO_CLIENT_ID() { return getEnv("CLIO_CLIENT_ID"); },
    get CLIO_CLIENT_SECRET() { return getEnv("CLIO_CLIENT_SECRET"); },

    // --- Platform vault (shared Postgres holding per-user Clio tokens) ---
    get DATABASE_URL() { return getEnv("DATABASE_URL"); },
    get APP_KEK_B64() { return getEnv("APP_KEK_B64"); },

    // --- Microsoft OAuth (per-user identity) ---
    get MS_CLIENT_ID() { return getEnv("MS_CLIENT_ID"); },
    // Optional: only needed when the upstream Microsoft app is a confidential
    // (web) client. Public/PKCE clients leave this unset.
    get MS_CLIENT_SECRET() { return process.env.MS_CLIENT_SECRET ?? ""; },
    get MS_TENANT_ID() { return getEnv("MS_TENANT_ID"); },
    // Audience expected on the Microsoft v2 access token, e.g. api://<client-id>.
    get MCP_AUDIENCE() { return getEnv("MCP_AUDIENCE"); },
    // Required scope name (matched against `scp` or `roles`), e.g. mcp.access.
    get MCP_SCOPE_NAME() { return getEnv("MCP_SCOPE_NAME"); },
    get ALLOWED_EMAILS() { return process.env.ALLOWED_EMAILS ?? ""; },
    get ALLOWED_EMAIL_DOMAINS() { return process.env.ALLOWED_EMAIL_DOMAINS ?? ""; },
    // Comma-separated Microsoft app (client) IDs allowed to call machine-to-
    // machine routes (POST /upload) with an app-only client-credentials token.
    // App-only tokens carry no user/email, so they're gated by appid here
    // instead of the email allowlist. Empty = allow any app that already holds
    // the required app role (logged as a warning), mirroring ALLOWED_EMAILS.
    get ALLOWED_APP_IDS() { return process.env.ALLOWED_APP_IDS ?? ""; },

    // --- Box (unchanged — out of scope) ---
    get BOX_CLIENT_ID() { return getEnv("BOX_CLIENT_ID", ""); },
    get BOX_CLIENT_SECRET() { return getEnv("BOX_CLIENT_SECRET", ""); },
    get BOX_REDIRECT_URI() { return getEnv("BOX_REDIRECT_URI", "https://clio-mcp-server-production-032d.up.railway.app/box/oauth/callback"); },
    // Public, externally reachable origin for this server. Used both for
    // /download/:token URLs (Box upload fallback) and as the OAuth
    // `baseUrl` advertised in the discovery + proxy endpoints.
    get PUBLIC_BASE_URL() { return getEnv("PUBLIC_BASE_URL", "https://clio-mcp-server-production-032d.up.railway.app"); },
};
