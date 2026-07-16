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
    // Clio Grow API v2 (see docs/clio-grow-api-reference.md). Region-specific
    // hosts exist (eu./ca./au. prefixes) if the firm's Grow account is not US.
    get GROW_API_BASE_URL() { return getEnv("GROW_API_BASE_URL", "https://api.clio.com/grow"); },
    // Clio Platform app credentials for the Grow API (created in the developer
    // portal at developers.api.clio.com — a SEPARATE app from the legacy Manage
    // one behind CLIO_CLIENT_ID). When set, /grow/oauth/start runs the connect
    // flow and Grow calls use the per-user tokens it stores; when unset, Grow
    // calls fall back to the Manage token.
    get GROW_CLIENT_ID() { return process.env.GROW_CLIENT_ID ?? ""; },
    get GROW_CLIENT_SECRET() { return process.env.GROW_CLIENT_SECRET ?? ""; },
    // OAuth endpoints for the Platform (Grow) app. Grow apps are registered in
    // the developer portal (developers.api.clio.com) but authorize through Clio
    // IDENTITY at account.clio.com — an Ory Hydra OAuth2 server, NOT the legacy
    // Manage OAuth on app.clio.com and NOT the portal domain. (Confirmed: logging
    // into grow.clio.com redirects to account.clio.com/login?login_challenge=…,
    // and Clio's SSO docs document account.clio.com/oauth2/{auth,token}.) A Grow
    // client_id is unknown to app.clio.com's registry, which is why that host
    // returned "client_id is incorrect". Hydra's standard paths are /oauth2/auth
    // and /oauth2/token. Account host is global (not region-prefixed); the region
    // lives in GROW_API_BASE_URL. Override if the app page says otherwise.
    get GROW_OAUTH_AUTHORIZE_URL() { return getEnv("GROW_OAUTH_AUTHORIZE_URL", "https://account.clio.com/oauth2/auth"); },
    get GROW_OAUTH_TOKEN_URL() { return getEnv("GROW_OAUTH_TOKEN_URL", "https://account.clio.com/oauth2/token"); },
    // Space-separated OAuth scopes. account.clio.com (Hydra) requires a scope on
    // the authorize request — omitting it returns a 400 "could not complete the
    // request as formatted". Default to "openid" (the baseline Clio Identity
    // scope, per Clio's SSO docs). If the Grow API then rejects the token
    // (401/403), the app needs its Grow-specific scope(s) too — set this to
    // "openid <grow-scope…>" using whatever the app's page in the portal lists.
    get GROW_OAUTH_SCOPE() { return process.env.GROW_OAUTH_SCOPE ?? "openid"; },
    get GROW_REDIRECT_URI() {
        return getEnv("GROW_REDIRECT_URI", `${ENV.PUBLIC_BASE_URL.replace(/\/$/, "")}/grow/oauth/callback`);
    },
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
    // Comma-separated emails of the "owner(s)" who can set the custom RomSum/NRN
    // calendar event types. Everyone else has those inputs ignored. Calendar
    // placement/reassignment is NOT gated by this. Defaults to the original
    // author when unset (see src/clio/owner.ts).
    get OWNER_EMAILS() { return process.env.OWNER_EMAILS ?? ""; },

    // --- Box (unchanged — out of scope) ---
    get BOX_CLIENT_ID() { return getEnv("BOX_CLIENT_ID", ""); },
    get BOX_CLIENT_SECRET() { return getEnv("BOX_CLIENT_SECRET", ""); },
    get BOX_REDIRECT_URI() { return getEnv("BOX_REDIRECT_URI", "https://clio-mcp-server-production-032d.up.railway.app/box/oauth/callback"); },
    // Public, externally reachable origin for this server. Used both for
    // /download/:token URLs (Box upload fallback) and as the OAuth
    // `baseUrl` advertised in the discovery + proxy endpoints.
    get PUBLIC_BASE_URL() { return getEnv("PUBLIC_BASE_URL", "https://clio-mcp-server-production-032d.up.railway.app"); },
};
