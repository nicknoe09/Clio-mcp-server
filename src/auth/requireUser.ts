import { Request, Response, NextFunction } from "express";
import { ENV } from "../utils/env";
import { verifyUploadCaller, AuthError } from "./microsoft";

const BASE_URL = ENV.PUBLIC_BASE_URL.replace(/\/$/, "");

// Express requests that have passed requireMicrosoftUser carry the verified
// caller: a user's email, or an app (client) id for client-credentials tokens.
export interface AuthedRequest extends Request {
  caller?: { kind: "user" | "app"; subject: string };
}

/**
 * Express middleware for machine-to-machine HTTP routes (POST /upload) that need
 * authentication but not the full per-request Clio-token context the /mcp
 * handler builds. Validates `Authorization: Bearer <Microsoft token>` and
 * accepts EITHER a delegated user token (gated by the email allowlist) OR an
 * app-only client-credentials token (gated by ALLOWED_APP_IDS) — so an
 * identity-less sandbox can authenticate non-interactively without a shared
 * secret. Attaches `req.caller`; responds 401 on any failure.
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

  try {
    req.caller = await verifyUploadCaller(token);
  } catch (err) {
    console.warn(`[auth] upload caller rejected: ${err instanceof AuthError ? err.code : "invalid_token"}`);
    send401();
    return;
  }

  next();
}
