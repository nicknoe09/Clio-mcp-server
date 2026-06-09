import axios from "axios";
import { ENV } from "../utils/env";
import { als, updateContextTokens } from "../auth/identity";
import { updateClioTokens } from "../auth/vault";

/**
 * Refresh the in-flight attorney's Clio access token.
 *
 * Reads the user's refresh token from the request context, exchanges it with
 * Clio using the shared Clio OAuth app credentials (CLIO_CLIENT_ID/SECRET),
 * writes the new tokens back to the platform vault, and updates the in-flight
 * context so the retried request reuses the fresh token. pagination.ts's async
 * 401-refresh path calls this; it stays unchanged.
 */
export async function refreshAccessToken(): Promise<string> {
    const ctx = als.getStore();
    if (!ctx) {
          throw new Error("No user context: cannot refresh Clio token outside an /mcp request.");
    }
    const refreshToken = ctx.refreshToken;
    if (!refreshToken) {
          throw new Error(
                "No Clio refresh token for your account — reconnect Clio on the platform's /setup page.",
          );
    }

  const params = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: ENV.CLIO_CLIENT_ID,
        client_secret: ENV.CLIO_CLIENT_SECRET,
        refresh_token: refreshToken,
  });

  const response = await axios.post(
        `${ENV.CLIO_BASE_URL}/oauth/token`,
        params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

  const { access_token, refresh_token, expires_in } = response.data;
    const newRefresh = refresh_token || refreshToken;
    const expiresAt =
          typeof expires_in === "number" ? new Date(Date.now() + expires_in * 1000) : null;

  // Update the in-flight context first so the immediate retry uses the new
  // token even if the vault write is briefly delayed, then persist.
    updateContextTokens(access_token, newRefresh);
    await updateClioTokens(ctx.userId, access_token, newRefresh, expiresAt);

  return access_token;
}
