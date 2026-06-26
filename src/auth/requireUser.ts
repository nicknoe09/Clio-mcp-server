import { Request, Response, NextFunction } from "express";
import { ENV } from "../utils/env";
import { verifyMicrosoftToken, isEmailAllowed, AuthError } from "./microsoft";

const BASE_URL = ENV.PUBLIC_BASE_URL.replace(/\/$/, "");

// Express requests that have passed requireMicrosoftUser carry the verified,
// allowlisted email.
export interface AuthedRequest extends Request {
  userEmail?: string;
}

/**
 * Express middleware enforcing the same per-user Microsoft Bearer identity the
 * /mcp transport uses: validate `Authorization: Bearer <Microsoft v2 JWT>`
 * against Microsoft's JWKS (issuer/audience/scope), check the onboarding
 * allowlist, and attach `req.userEmail`. Responds 401 on any failure.
 *
 * Used by plain HTTP routes (e.g. POST /upload) that need authentication but
 * not the full per-request Clio-token context the /mcp handler builds.
 */
export async function requireMicrosoftUser(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const send401 = () => {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="clio-mcp", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`,
    );
    res.status(401).json({ ok: false, error: "unauthorized" });
  };

  const header = req.headers.authorization;
  const token = header && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    send401();
    return;
  }

  let email: string;
  try {
    ({ email } = await verifyMicrosoftToken(token));
  } catch (err) {
    console.warn(`[auth] upload token rejected: ${err instanceof AuthError ? err.code : "invalid_token"}`);
    send401();
    return;
  }

  if (!isEmailAllowed(email)) {
    console.warn("[auth] upload — authenticated email is not on the onboarding allowlist");
    send401();
    return;
  }

  req.userEmail = email;
  next();
}
