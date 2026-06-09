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
