import { createRemoteJWKSet, jwtVerify, decodeJwt, JWTPayload } from "jose";
import { ENV } from "../utils/env";

/**
 * Per-user Microsoft OAuth identity. Validates a Microsoft v2 access token
 * against Microsoft's JWKS, checks audience + scope, and extracts the email.
 * Mirrors the platform's `auth.py` (lean Microsoft-OAuth connector, no DCR).
 */

// Accept BOTH the v2 issuer and the v1 (sts.windows.net) issuer for this
// tenant. A freshly-created API app registration issues v1.0 access tokens by
// default (iss=sts.windows.net, ver=1.0); their signature still verifies
// against the v2 JWKS and their aud/scp are correct, so the only thing that
// differs is the issuer string. Accepting both means the server works whether
// the API app issues v1 or v2 tokens — no dependence on the app's
// accessTokenAcceptedVersion manifest setting.
const issuers = [
  `https://login.microsoftonline.com/${ENV.MS_TENANT_ID}/v2.0`,
  `https://sts.windows.net/${ENV.MS_TENANT_ID}/`,
];
const jwksUri = `https://login.microsoftonline.com/${ENV.MS_TENANT_ID}/discovery/v2.0/keys`;

// Cached remote JWKS — jose handles fetching + key rotation.
const JWKS = createRemoteJWKSet(new URL(jwksUri));

export class AuthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** Accept both `<MCP_AUDIENCE>` and the same value with a leading `api://` stripped. */
function acceptedAudiences(): string[] {
  const aud = ENV.MCP_AUDIENCE;
  const stripped = aud.replace(/^api:\/\//, "");
  return stripped === aud ? [aud] : [aud, stripped];
}

function hasRequiredScope(payload: JWTPayload): boolean {
  const scopeName = ENV.MCP_SCOPE_NAME;
  // Delegated tokens carry space-delimited `scp`; app tokens carry `roles[]`.
  const scp = typeof payload.scp === "string" ? payload.scp.split(/\s+/).filter(Boolean) : [];
  if (scp.includes(scopeName)) return true;
  const roles = Array.isArray((payload as any).roles) ? ((payload as any).roles as unknown[]) : [];
  return roles.includes(scopeName);
}

function extractEmail(payload: JWTPayload): string {
  const candidate =
    (payload as any).email ?? (payload as any).preferred_username ?? (payload as any).upn ?? "";
  return String(candidate).trim().toLowerCase();
}

/**
 * Verify signature + issuer + audience + required scope/role, returning the
 * validated payload. Throws AuthError on any failure. This is the shared core;
 * callers decide what identity they need from the payload (user email vs app).
 */
export async function verifyMicrosoftJwtPayload(token: string): Promise<JWTPayload> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, JWKS, {
      issuer: issuers,
      audience: acceptedAudiences(),
    }));
  } catch (err) {
    // Decode (NOT verify) to surface *why* it failed — expiry vs audience vs
    // issuer vs signature — without ever logging the token itself. Claims like
    // aud/iss/scp/exp are not secrets and are exactly what we need to debug an
    // audience mismatch after re-pointing MCP_AUDIENCE.
    try {
      const c = decodeJwt(token);
      console.warn(
        `[auth] token rejected reason=${(err as Error).name} ` +
          `token_aud=${JSON.stringify(c.aud)} expected_aud=${JSON.stringify(acceptedAudiences())} ` +
          `iss=${c.iss} ver=${(c as any).ver} scp=${(c as any).scp ?? ""} ` +
          `roles=${JSON.stringify((c as any).roles ?? [])} ` +
          `exp=${c.exp} now=${Math.floor(Date.now() / 1000)}`
      );
    } catch {
      console.warn(`[auth] token rejected reason=${(err as Error).name} (token undecodable)`);
    }
    throw new AuthError("invalid_token", `Token validation failed: ${(err as Error).name}`);
  }

  if (!hasRequiredScope(payload)) {
    throw new AuthError("insufficient_scope", "Token is missing the required scope");
  }

  return payload;
}

/**
 * Verify a Microsoft v2 access token carrying a USER identity (the /mcp path).
 * Throws AuthError on any failure (signature, issuer, audience, expiry,
 * missing scope, missing email).
 */
export async function verifyMicrosoftToken(token: string): Promise<{ email: string }> {
  const payload = await verifyMicrosoftJwtPayload(token);
  const email = extractEmail(payload);
  if (!email) {
    throw new AuthError("invalid_token", "Token has no email/preferred_username/upn claim");
  }
  return { email };
}

/** The app (client) id of an app-only token: `azp` (v2) or `appid` (v1). */
function extractAppId(payload: JWTPayload): string {
  return String((payload as any).azp ?? (payload as any).appid ?? "").trim();
}

/**
 * Allowlist for machine callers (app-only client-credentials tokens), keyed by
 * app/client id. If ALLOWED_APP_IDS is unset, allow any app that already holds
 * the required app role (warn once) — mirrors isEmailAllowed's open default.
 */
let warnedOpenAppAllowlist = false;
export function isAppAllowed(appId: string): boolean {
  const ids = ENV.ALLOWED_APP_IDS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (ids.length === 0) {
    if (!warnedOpenAppAllowlist) {
      console.warn(
        "[auth] ALLOWED_APP_IDS is not set — allowing ANY app that holds the required role to call machine routes."
      );
      warnedOpenAppAllowlist = true;
    }
    return true;
  }
  return appId !== "" && ids.includes(appId.toLowerCase());
}

export type Caller =
  | { kind: "user"; subject: string }
  | { kind: "app"; subject: string };

/**
 * Verify a token for a machine-to-machine route (POST /upload) that accepts
 * EITHER a delegated USER token or an app-only client-credentials token.
 * A user token (has email) is gated by the email allowlist; an app token (no
 * user, identified by appid) is gated by the app-id allowlist. Throws
 * AuthError (code "forbidden") when verified but not allowlisted.
 */
export async function verifyUploadCaller(token: string): Promise<Caller> {
  const payload = await verifyMicrosoftJwtPayload(token);
  const email = extractEmail(payload);
  if (email) {
    if (!isEmailAllowed(email)) {
      throw new AuthError("forbidden", "Authenticated email is not on the onboarding allowlist");
    }
    return { kind: "user", subject: email };
  }
  // No user claims → app-only (client-credentials) token. The required app role
  // was already verified by verifyMicrosoftJwtPayload; gate the app id too.
  const appId = extractAppId(payload);
  if (!isAppAllowed(appId)) {
    throw new AuthError("forbidden", `App ${appId || "<unknown>"} is not on the ALLOWED_APP_IDS allowlist`);
  }
  return { kind: "app", subject: appId };
}

/**
 * Onboarding allowlist: ALLOWED_EMAILS first, then ALLOWED_EMAIL_DOMAINS.
 * If BOTH are unset, log a warning and allow (open onboarding).
 */
let warnedOpenAllowlist = false;
export function isEmailAllowed(email: string): boolean {
  const emails = ENV.ALLOWED_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const domains = ENV.ALLOWED_EMAIL_DOMAINS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  if (emails.length === 0 && domains.length === 0) {
    if (!warnedOpenAllowlist) {
      console.warn(
        "[auth] Neither ALLOWED_EMAILS nor ALLOWED_EMAIL_DOMAINS is set — allowing ALL authenticated users."
      );
      warnedOpenAllowlist = true;
    }
    return true;
  }

  if (emails.includes(email)) return true;
  const domain = email.split("@")[1] || "";
  return domain !== "" && domains.includes(domain);
}
