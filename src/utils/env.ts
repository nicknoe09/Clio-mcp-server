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
    get CLIO_CLIENT_ID() { return getEnv("CLIO_CLIENT_ID"); },
    get CLIO_CLIENT_SECRET() { return getEnv("CLIO_CLIENT_SECRET"); },
    get CLIO_REDIRECT_URI() { return getEnv("CLIO_REDIRECT_URI"); },
    get CLIO_ACCESS_TOKEN() { return process.env.CLIO_ACCESS_TOKEN ?? ""; },
    get CLIO_REFRESH_TOKEN() { return process.env.CLIO_REFRESH_TOKEN ?? ""; },
    get BOX_CLIENT_ID() { return getEnv("BOX_CLIENT_ID", ""); },
    get BOX_CLIENT_SECRET() { return getEnv("BOX_CLIENT_SECRET", ""); },
    get BOX_REDIRECT_URI() { return getEnv("BOX_REDIRECT_URI", "https://clio-mcp-server-production-032d.up.railway.app/box/oauth/callback"); },
    // Public base URL for this server. Used to construct /download/:token
    // URLs when the MCP client needs to retrieve generated files directly
    // (Box upload fallback path). Must be the externally reachable origin.
    get PUBLIC_BASE_URL() { return getEnv("PUBLIC_BASE_URL", "https://clio-mcp-server-production-032d.up.railway.app"); },
};
