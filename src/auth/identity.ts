import { AsyncLocalStorage } from "async_hooks";

/**
 * Per-request user identity + Clio token context.
 *
 * The whole server used to act as ONE shared Clio identity. Now every
 * authenticated /mcp request runs inside an AsyncLocalStorage scope carrying
 * the acting attorney's identity and their own Clio token, preloaded from the
 * platform vault. The Clio HTTP layer (pagination.ts) reads the token
 * synchronously via tokenStore.getAccessToken(), which just reads this store —
 * so none of the ~18 tool modules or pagination.ts had to change.
 */
export interface UserContext {
  userEmail: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  // Set when the user is provisioned on the platform but has no usable Clio
  // token (not connected, or decrypt failed). getAccessToken() throws this so
  // initialize/tools-list still work and only Clio-touching tools fail, with a
  // clear, user-actionable message.
  clioError?: string;
  // The acting attorney's Clio user id (NOT the vault userId above), resolved
  // lazily from /users/who_am_i and cached for the rest of the request. Lets
  // write tools attribute actions to whoever is actually calling instead of a
  // caller-supplied (and easily wrong) id. See clio/actingUser.ts.
  clioUserId?: number;
  // The acting attorney's full Clio identity (id/email/name) from who_am_i,
  // cached per request. Used by the central write guard to verify the Clio
  // token actually belongs to the signed-in attorney. See clio/pagination.ts.
  clioIdentity?: { id: number; email: string; name: string };
  // Per-user Clio Grow (Platform app) tokens, lazily loaded from the vault on
  // first Grow call in the request (growTokensLoaded guards the one-time read).
  // Absent → Grow calls fall back to the Manage accessToken. See clio/grow.ts.
  growAccessToken?: string;
  growRefreshToken?: string;
  growTokensLoaded?: boolean;
}

export const als = new AsyncLocalStorage<UserContext>();

export function getContext(): UserContext | undefined {
  return als.getStore();
}

/**
 * Update the in-flight context after a token refresh so subsequent calls in
 * the same request reuse the fresh token.
 */
export function updateContextTokens(accessToken: string, refreshToken: string): void {
  const store = als.getStore();
  if (store) {
    store.accessToken = accessToken;
    store.refreshToken = refreshToken;
    store.clioError = undefined;
  }
}

/** Same as updateContextTokens, for the per-user Clio Grow token pair. */
export function updateContextGrowTokens(accessToken: string, refreshToken: string): void {
  const store = als.getStore();
  if (store) {
    store.growAccessToken = accessToken;
    store.growRefreshToken = refreshToken;
    store.growTokensLoaded = true;
  }
}
