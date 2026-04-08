import axios from "axios";
import { ENV } from "../utils/env";
import {
  persistBoxTokens,
  getBoxRefreshToken,
} from "../utils/tokenStore";

const BOX_AUTH_URL = "https://account.box.com/api/oauth2/authorize";
const BOX_TOKEN_URL = "https://api.box.com/oauth2/token";

export function getBoxAuthorizationUrl(): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: ENV.BOX_CLIENT_ID,
    redirect_uri: ENV.BOX_REDIRECT_URI,
  });
  return `${BOX_AUTH_URL}?${params.toString()}`;
}

export async function exchangeBoxCodeForTokens(code: string): Promise<{
  email: string;
  access_token: string;
  refresh_token: string;
}> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: ENV.BOX_CLIENT_ID,
    client_secret: ENV.BOX_CLIENT_SECRET,
    redirect_uri: ENV.BOX_REDIRECT_URI,
  });

  const response = await axios.post(BOX_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  const { access_token, refresh_token } = response.data;

  // Get user's email from Box
  const meResponse = await axios.get("https://api.box.com/2.0/users/me", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const email = (meResponse.data.login || "").toLowerCase();

  await persistBoxTokens(email, access_token, refresh_token);
  return { email, access_token, refresh_token };
}

// Mutex for single-use refresh tokens — Box invalidates old refresh tokens
const refreshLocks = new Map<string, Promise<string>>();

export async function refreshBoxAccessToken(userEmail: string): Promise<string> {
  const existing = refreshLocks.get(userEmail);
  if (existing) return existing;

  const promise = doRefresh(userEmail);
  refreshLocks.set(userEmail, promise);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(userEmail);
  }
}

async function doRefresh(userEmail: string): Promise<string> {
  const refreshToken = getBoxRefreshToken(userEmail);
  if (!refreshToken) {
    throw new Error(`No Box refresh token for ${userEmail}. Complete Box OAuth flow at /box/oauth/start`);
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: ENV.BOX_CLIENT_ID,
    client_secret: ENV.BOX_CLIENT_SECRET,
  });

  const response = await axios.post(BOX_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  const { access_token, refresh_token } = response.data;
  await persistBoxTokens(userEmail, access_token, refresh_token ?? refreshToken);
  return access_token;
}
