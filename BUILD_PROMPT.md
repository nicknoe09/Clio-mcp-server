# Build prompt — make clio-mcp-server per-user, persistent, Streamable-HTTP

Paste everything below into a fresh Claude Code session pointed at this repo. It assumes no
prior context.

---

## Goal
Retrofit this TypeScript Clio MCP server so it is **per-user and persistent**, matching the
architecture of our companion "noe-reminders" platform. Three changes, and the ~18 Clio tool
modules and all billing logic must remain UNTOUCHED:

1. Replace the deprecated **SSE transport** (`/sse` + `/messages`) with **Streamable HTTP at `/mcp`**
   (the SDK already ships `StreamableHTTPServerTransport`; this repo is on @modelcontextprotocol/sdk 1.27.1).
2. Replace the **static `MCP_AUTH_TOKEN`** bearer with **per-user Microsoft OAuth identity**
   (Microsoft v2 JWT validated against Microsoft's JWKS — no static tokens, no `?token=`).
3. Replace the **single shared Clio OAuth token** with **per-user Clio tokens read from the platform's
   shared Postgres vault** — so every Clio action is attributed to the acting attorney's own Clio account.

## Why
Today the server authenticates clients with one shared secret and acts on Clio as ONE shared identity,
so in a multi-user firm every write (time entries, tasks, bills) is misattributed. The platform already
stores each attorney's Clio token (encrypted, per user). This server should consume that, not duplicate it.

## Current architecture (read these first)
- `src/index.ts` — Express + SSE transport; `MCP_AUTH_TOKEN` guard; registers ~18 tool modules.
- `src/utils/tokenStore.ts` — single shared `CLIO_ACCESS_TOKEN`/`CLIO_REFRESH_TOKEN`; `getAccessToken()` (SYNC).
  (Note: Box tokens are already a per-user-by-email map here — useful pattern reference.)
- `src/clio/auth.ts` — `refreshAccessToken()` (single token).
- `src/clio/pagination.ts` — the CENTRAL Clio HTTP layer; every tool flows through here and calls
  `getAccessToken()`. This is the only place tokens are acquired → the lever for per-user.

## TRANSPORT (SSE -> Streamable HTTP)
- Single `/mcp` endpoint handling POST/GET/DELETE via `StreamableHTTPServerTransport`
  (`@modelcontextprotocol/sdk/server/streamableHttp.js`). Stateful: generate `mcp-session-id`; reuse the
  transport/server per session id. Follow the SDK's StreamableHTTP server example.
- NOTE: unlike the SSE `/messages` route, the streamable transport works on the PARSED JSON body —
  enable `express.json()` for `/mcp` and pass the body to `transport.handleRequest(req, res, req.body)`.
- Remove `/sse`, `/messages`, `SSEServerTransport`, the `MCP_AUTH_TOKEN` guard, and the origin/sessionId hacks.

## AUTH (mirror our platform's `auth.py` — Microsoft-OAuth connector, LEAN model, no DCR)
Gate `/mcp` with a requireBearer step that runs before the transport:
- Read the token from `Authorization: Bearer <jwt>` ONLY (never `?token=`).
- Validate as a Microsoft v2 access token using `jose`:
    - issuer   = `https://login.microsoftonline.com/<MS_TENANT_ID>/v2.0`
    - jwks_uri = `https://login.microsoftonline.com/<MS_TENANT_ID>/discovery/v2.0/keys`
    - audience = accept BOTH `<MCP_AUDIENCE>` and the same value with a leading `api://` stripped
    - Require scope `<MCP_SCOPE_NAME>` present in `scp` (space-delimited) OR `roles` (array).
    - Extract email = first of email | preferred_username | upn, lowercased.
- On any failure: 401 with header
    `WWW-Authenticate: Bearer realm="clio-mcp", resource_metadata="<baseUrl>/.well-known/oauth-protected-resource"`
- Onboarding allowlist: `ALLOWED_EMAILS` (comma list) then `ALLOWED_EMAIL_DOMAINS` (comma list); if both
  unset, log a warning and allow.
- Add OAuth discovery + proxy endpoints (forward to Microsoft; this is how the connector logs in):
    - `GET /.well-known/oauth-protected-resource` (RFC 9728: resource, authorization_servers=[baseUrl],
      scopes_supported, bearer_methods_supported:["header"])
    - `GET /.well-known/oauth-authorization-server` (RFC 8414: issuer, authorization_endpoint=`<baseUrl>/authorize`,
      token_endpoint=`<baseUrl>/token`, jwks_uri=Microsoft's, S256+plain)
    - `GET /authorize` -> 302 to `https://login.microsoftonline.com/<MS_TENANT_ID>/oauth2/v2.0/authorize`,
      forwarding all query params verbatim EXCEPT dropping any `resource` param (RFC 8707 — it triggers
      AADSTS9010010 on v2). If `scope` is absent, default it to
      `"openid profile email offline_access <MCP_AUDIENCE>/<MCP_SCOPE_NAME>"`.
    - `POST /token` -> proxy to `https://login.microsoftonline.com/<MS_TENANT_ID>/oauth2/v2.0/token` as
      application/x-www-form-urlencoded, dropping `resource`; if client creds arrive via HTTP Basic, fold
      them into the body; return Microsoft's status + JSON unchanged.
- Reference implementation to mirror: repo `nicknoe09/noe-reminders`, branch `master`, file `auth.py`
  (Python). Port it faithfully to TS.

## PER-USER WIRING (low-touch — do NOT edit the 18 tool modules)
- Add an `AsyncLocalStorage` context holding `{ userEmail, userId, accessToken, refreshToken }`.
- Bind each `mcp-session-id` to the verified email at initialize. On EVERY `/mcp` request: verify the JWT,
  confirm its email matches the session's bound email (else 404 — don't confirm the session exists), then
  before calling `transport.handleRequest`, PRELOAD the user's Clio token from the vault (see below) and
  run the handler inside `als.run({...}, () => transport.handleRequest(...))`.
- Make `tokenStore.getAccessToken()` return `als.getStore().accessToken` SYNCHRONOUSLY (the preload made it
  available; pagination.ts stays unchanged). Make `clio/auth.ts refreshAccessToken()` refresh THAT user's
  token (using CLIO_CLIENT_ID/SECRET) and write the new token back to the vault + update the ALS store.
  pagination.ts's 401-refresh path is already async — keep it.

## VAULT (shared Postgres, connect as bounded role `noe_app`)
The platform's Postgres holds per-user Clio tokens. Use `pg` (node-postgres). `DATABASE_URL` connects as the
NON-superuser role `noe_app`, so row-level security is enforced — you MUST set the tenant context per read.

Read flow (per request, given the verified email):
1. `SELECT id, token_version FROM users WHERE lower(email) = lower($1)`  (the `users` table has no RLS).
   If no row -> 401 (user not provisioned on the platform).
2. In a transaction: `SELECT set_config('app.user_id', $userId, true)` then
   `SELECT access_token_ct, access_token_nonce, access_token_dek_ct,
           refresh_token_ct, refresh_token_nonce, refresh_token_dek_ct, expires_at
      FROM user_integrations WHERE provider = 'clio'`  (RLS scopes this to that user; expect 0 or 1 row).
   If no row -> return a clear "Clio not connected — connect it on the platform's /setup" error.
3. Decrypt (see crypto below). On refresh, re-encrypt with the SAME scheme and
   `UPDATE user_integrations SET access_token_ct=..., access_token_nonce=..., access_token_dek_ct=...,
    refresh_token_*=..., expires_at=..., updated_at=now() WHERE provider='clio'` inside the same
   tenant-scoped transaction.
- Do NOT run platform migrations from this server. It only reads/writes the `clio` integration row.

## CRYPTO PARITY (the #1 place to get wrong — be exact)
The platform encrypts each token with AES-256-GCM envelope encryption (see `app/crypto.py`, branch
`claude/test-noe-reminders-WYH2G`). Replicate in TS with Node `crypto` (aes-256-gcm). Key facts:
- KEK = base64-decode(`APP_KEK_B64`) -> 32 bytes.
- Python's AESGCM.encrypt APPENDS the 16-byte auth tag to the ciphertext. Node needs it split:
  `data = ct[0 : len-16]`, `tag = ct[len-16 :]`, and use `setAuthTag(tag)`.
- bytea columns come back from `pg` as Buffers.
- Unwrap the per-row DEK:  `wrapped = access_token_dek_ct`;  `nonce = wrapped[0:12]`;  `rest = wrapped[12:]`;
  decipher aes-256-gcm with key=KEK, iv=nonce, AAD = `Buffer.from("dek")`, authTag = `rest[-16:]`,
  data = `rest[0:-16]`  ->  dek (32 bytes).
- Decrypt the token:  iv = `access_token_nonce` (12 bytes);  ct = `access_token_ct`;
  AAD = `` `noe-reminders:${userId}:clio:access_token` ``  (for refresh use `...:clio:refresh_token`);
  authTag = `ct[-16:]`, data = `ct[0:-16]`, key = dek  ->  utf8 plaintext.
- To ENCRYPT for write-back, reverse it: generate `dek = randomBytes(32)`, `iv = randomBytes(12)`; cipher with
  AAD as above; `ciphertext_to_store = Buffer.concat([cipherUpdateFinal, cipher.getAuthTag()])`; wrap the dek
  under KEK the same way (`iv = randomBytes(12)`; `dek_ct_to_store = Buffer.concat([iv, ct, getAuthTag()])`; AAD="dek").

## ENV VARS (the human will set these on the Clio service's Railway)
- ADD:    `DATABASE_URL` (`postgresql://noe_app:<pw>@<public-proxy-host>:<port>/railway`),
          `APP_KEK_B64` (SAME value as the platform), `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`,
          `MCP_AUDIENCE` (`api://<client-id>`), `MCP_SCOPE_NAME`, `ALLOWED_EMAILS` and/or `ALLOWED_EMAIL_DOMAINS`.
- KEEP:   `CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET` (needed to REFRESH tokens — must be the SAME Clio OAuth app
          the platform uses).
- REMOVE: `MCP_AUTH_TOKEN`, `CLIO_ACCESS_TOKEN`, `CLIO_REFRESH_TOKEN` (no longer a shared token), and the Clio
          OAuth bootstrap routes `/oauth/start` + `/oauth/callback` (Clio is connected on the platform now).
- LEAVE BOX AS-IS — out of scope for this change.

## KNOWN GOTCHAS
- Streamable HTTP needs the parsed JSON body on `/mcp` (opposite of the old SSE `/messages`).
- Connect as `noe_app` (NOT the postgres superuser) so RLS is real; ALWAYS `set_config('app.user_id', …)`
  before touching `user_integrations`.
- `getAccessToken()` is SYNC and called deep in pagination.ts — solve by preloading the token into ALS at
  request start; do not try to make pagination.ts async.
- Never log token or JWT contents — error codes/messages only.
- jose works on Node 18+; if you hit a WebCrypto error, add a `globalThis.crypto` polyfill as the first import.

## ACCEPTANCE CRITERIA
- Unauthenticated `/mcp` -> 401 with the RFC 9728 `WWW-Authenticate` header above.
- A valid Microsoft JWT (right audience + scope, allowlisted email) -> tools work, acting on that
  attorney's own Clio token; a different user's JWT on the same session id -> 404.
- A write (e.g., create time entry) posts under the CALLING attorney's Clio account (verify attribution).
- No `MCP_AUTH_TOKEN`, no `?token=`, no SSE endpoints remain.
- All 18 tool modules and billing logic unchanged; `npm run build` / typecheck passes; boot smoke test OK.
- Work on a branch; provide deploy steps for the Clio Railway service and a short verification checklist.

## Secrets the human must supply as env vars (NOT in this file)
- `noe_app` DB password, `APP_KEK_B64` (must match the platform), Microsoft app client id/secret
  (can reuse the platform's app; add this server's `/oauth/...callback` redirect URI).
- Confirm `CLIO_CLIENT_ID/SECRET` is the SAME Clio OAuth app whose tokens the platform stored (refresh
  requires it).
