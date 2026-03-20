import axios from "axios";
import { ENV } from "../utils/env";
import { persistTokens, getRefreshToken } from "../utils/tokenStore";

/**
 * Refresh the Clio OAuth access token using the refresh token.
 * Persists both new tokens to process.env and .env file.
 */
export async function refreshAccessToken(): Promise<string> {
    const refreshToken = getRefreshToken();
    if (!refreshToken) {
          throw new Error("No refresh token available. Complete OAuth flow at /oauth/start");
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

  const { access_token, refresh_token } = response.data;
    persistTokens(access_token, refresh_token);
    return access_token;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeCodeForTokens(code: string): Promise<{
    access_token: string;
    refresh_token: string;
}> {
    const params = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: ENV.CLIO_CLIENT_ID,
          client_secret: ENV.CLIO_CLIENT_SECRET,
          redirect_uri: ENV.CLIO_REDIRECT_URI,
          code,
    });

  const response = await axios.post(
        `${ENV.CLIO_BASE_URL}/oauth/token`,
        params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

  const { access_token, refresh_token } = response.data;
    persistTokens(access_token, refresh_token);
    return { access_token, refresh_token };
}

/**
 * Build the Clio OAuth authorization URL.
 */
export function getAuthorizationUrl(): string {
    const params = new URLSearchParams({
          response_type: "code",
          client_id: ENV.CLIO_CLIENT_ID,
          redirect_uri: ENV.CLIO_REDIRECT_URI,
    });
    return `${ENV.CLIO_BASE_URL}/oauth/authorize?${params.toString()}`;
}
