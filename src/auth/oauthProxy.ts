import express, { Express, Request, Response } from "express";
import axios from "axios";
import { ENV } from "../utils/env";

/**
 * OAuth discovery + proxy endpoints. This is how the MCP connector logs in:
 * it discovers this server as a protected resource, then runs the auth-code
 * flow against /authorize + /token, which forward to Microsoft.
 *
 * Lean model, no Dynamic Client Registration. We forward to Microsoft v2 and
 * drop the RFC 8707 `resource` param, which otherwise triggers AADSTS9010010.
 */

function msAuthorizeUrl(): string {
  return `https://login.microsoftonline.com/${ENV.MS_TENANT_ID}/oauth2/v2.0/authorize`;
}
function msTokenUrl(): string {
  return `https://login.microsoftonline.com/${ENV.MS_TENANT_ID}/oauth2/v2.0/token`;
}

/**
 * Build the scope string Microsoft needs for a durable, refreshable login:
 * the fully-qualified API scope (bare names resolve against Graph on the v2
 * endpoint), plus openid/profile/email and — critically — offline_access,
 * which is what makes Microsoft return a refresh token.
 */
function normalizeScope(requested: string | null | undefined): string {
  const scopes = new Set((requested ?? "").split(/\s+/).filter(Boolean));
  scopes.delete(ENV.MCP_SCOPE_NAME);
  scopes.add(`${ENV.MCP_AUDIENCE}/${ENV.MCP_SCOPE_NAME}`);
  for (const s of ["openid", "profile", "email", "offline_access"]) scopes.add(s);
  return [...scopes].join(" ");
}

export function registerOAuthProxyRoutes(app: Express): void {
  const baseUrl = ENV.PUBLIC_BASE_URL.replace(/\/$/, "");

  // RFC 9728 — Protected Resource Metadata.
  app.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    res.json({
      resource: ENV.MCP_AUDIENCE,
      authorization_servers: [baseUrl],
      scopes_supported: [ENV.MCP_SCOPE_NAME],
      bearer_methods_supported: ["header"],
    });
  });

  // RFC 8414 — Authorization Server Metadata. We are the authorization server
  // the connector talks to; we proxy to Microsoft underneath.
  app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      jwks_uri: `https://login.microsoftonline.com/${ENV.MS_TENANT_ID}/discovery/v2.0/keys`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
        "none",
      ],
    });
  });

  // GET /authorize -> 302 to Microsoft, forwarding all query params verbatim
  // EXCEPT `resource` (RFC 8707 — triggers AADSTS9010010 on v2).
  app.get("/authorize", (req: Request, res: Response) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (key === "resource") continue;
      if (Array.isArray(value)) {
        value.forEach((v) => params.append(key, String(v)));
      } else if (value !== undefined) {
        params.append(key, String(value));
      }
    }
    // Help connectors that don't carry a client_id of their own.
    if (!params.has("client_id")) params.set("client_id", ENV.MS_CLIENT_ID);
    // Connectors request only the scope advertised by the resource metadata
    // (the bare scope name), so never rely on them asking for more. Always:
    //  - qualify the bare scope name to api://<audience>/<scope> (Microsoft v2
    //    resolves unqualified names against Graph, not our app), and
    //  - merge in offline_access — WITHOUT it Microsoft issues no refresh
    //    token, the access token dies after ~1h, and the user is forced
    //    through an interactive reconnect every time it expires.
    params.set("scope", normalizeScope(params.get("scope")));
    res.redirect(302, `${msAuthorizeUrl()}?${params.toString()}`);
  });

  // POST /token -> proxy to Microsoft as application/x-www-form-urlencoded,
  // dropping `resource`. Fold HTTP Basic client creds into the body. Return
  // Microsoft's status + JSON unchanged.
  app.post("/token", express.urlencoded({ extended: true }), async (req: Request, res: Response) => {
    const form = new URLSearchParams();
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      if (key === "resource") continue;
      if (Array.isArray(value)) {
        value.forEach((v) => form.append(key, String(v)));
      } else if (value !== undefined && value !== null) {
        form.append(key, String(value));
      }
    }

    // Scope handling differs by grant:
    //  - authorization_code: qualify the bare scope to api://<audience>/<scope>
    //    + offline_access (interactive consent supports the app tokening itself).
    //  - refresh_token: DROP scope entirely. This app is its own API resource
    //    (client_id == MCP_AUDIENCE app), and Azure rejects a non-interactive
    //    request for the app's own scope with AADSTS90009 ("requesting a token
    //    for itself"). With no scope, Azure reuses the scopes already consented
    //    at auth-code time, so the refreshed access token still carries
    //    aud=<MCP_AUDIENCE> — without tripping AADSTS90009.
    const grantType = String((body as Record<string, unknown>).grant_type ?? "");
    if (grantType === "refresh_token") {
      form.delete("scope");
    } else if (form.has("scope")) {
      form.set("scope", normalizeScope(form.get("scope")));
    }

    // If client creds arrive via HTTP Basic, fold them into the body.
    const authz = req.headers.authorization;
    if (authz && authz.startsWith("Basic ")) {
      const decoded = Buffer.from(authz.slice(6), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep >= 0) {
        const cid = decoded.slice(0, sep);
        const secret = decoded.slice(sep + 1);
        if (cid && !form.has("client_id")) form.set("client_id", cid);
        if (secret && !form.has("client_secret")) form.set("client_secret", secret);
      }
    }

    // Fallbacks so a confidential Microsoft app still authenticates when the
    // connector is a public client that only knows the client_id.
    if (!form.has("client_id")) form.set("client_id", ENV.MS_CLIENT_ID);
    if (!form.has("client_secret") && ENV.MS_CLIENT_SECRET) {
      form.set("client_secret", ENV.MS_CLIENT_SECRET);
    }

    try {
      const upstream = await axios.post(msTokenUrl(), form.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        validateStatus: () => true,
      });
      // Diagnostic: never logs token values — only grant type, status, whether
      // a refresh_token came back (the thing that decides if the session can
      // survive past the ~1h access-token lifetime), and Microsoft's error
      // code on failure. Lets us tell "refresh worked" from "AADSTS rejected"
      // from "connector never refreshed" without guessing.
      const grant = String((body as Record<string, unknown>).grant_type ?? "unknown");
      const data = (upstream.data ?? {}) as Record<string, unknown>;
      if (upstream.status >= 200 && upstream.status < 300) {
        console.log(
          `[oauth] token grant=${grant} status=${upstream.status} ` +
            `access_token=${data.access_token ? "yes" : "no"} ` +
            `refresh_token=${data.refresh_token ? "yes" : "no"} ` +
            `expires_in=${data.expires_in ?? "?"}`
        );
      } else {
        console.warn(
          `[oauth] token grant=${grant} status=${upstream.status} ` +
            `error=${data.error ?? "?"} ` +
            `desc=${String(data.error_description ?? "").replace(/\s+/g, " ").slice(0, 200)}`
        );
      }
      res.status(upstream.status).json(upstream.data);
    } catch (err) {
      console.error("[oauth] token proxy error:", (err as Error).message);
      res.status(502).json({ error: "token_proxy_error" });
    }
  });
}
