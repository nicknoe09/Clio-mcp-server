import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";
import { ENV } from "../utils/env";

/**
 * Per-user Microsoft OAuth identity. Validates a Microsoft v2 access token
 * against Microsoft's JWKS, checks audience + scope, and extracts the email.
 * Mirrors the platform's `auth.py` (lean Microsoft-OAuth connector, no DCR).
 */

const issuer = `https://login.microsoftonline.com/${ENV.MS_TENANT_ID}/v2.0`;
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
 * Verify a Microsoft v2 access token. Throws AuthError on any failure
 * (signature, issuer, audience, expiry, missing scope, missing email).
 */
export async function verifyMicrosoftToken(token: string): Promise<{ email: string }> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, JWKS, {
      issuer,
      audience: acceptedAudiences(),
    }));
  } catch (err) {
    // Never log token contents — code only.
    throw new AuthError("invalid_token", `Token validation failed: ${(err as Error).name}`);
  }

  if (!hasRequiredScope(payload)) {
    throw new AuthError("insufficient_scope", "Token is missing the required scope");
  }

  const email = extractEmail(payload);
  if (!email) {
    throw new AuthError("invalid_token", "Token has no email/preferred_username/upn claim");
  }

  return { email };
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
