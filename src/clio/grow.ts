import https from "https";
import { ENV } from "../utils/env";
import { getAccessToken } from "../utils/tokenStore";
import { getContext } from "../auth/identity";
import { refreshAccessToken } from "./auth";
import { withBackoff } from "./rateLimit";
import {
  buildQueryString,
  assertActingClioIdentity,
  formatClioWriteLog,
} from "./pagination";

// HTTP layer for the Clio Grow API v2 (docs/clio-grow-api-reference.md).
// Grow is a separate host from Manage v4 (api.clio.com/grow vs app.clio.com/api/v4)
// but uses the same per-user OAuth bearer tokens (Clio unified login), so this
// module reuses the Manage token store, 401-refresh, and 429-backoff machinery.
// Grow has no `fields`/`order`/`limit` params — lists paginate purely via
// `page_token` cursors surfaced as absolute `meta.paging.next` URLs.

function growRequest(
  method: "GET" | "POST" | "DELETE",
  fullUrl: string,
  body?: any
): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const path = fullUrl.slice(fullUrl.indexOf(parsed.pathname));
    const data = body !== undefined ? JSON.stringify(body) : undefined;

    const headers: Record<string, string | number> = {
      "Authorization": `Bearer ${getAccessToken()}`,
      "Content-Type": "application/json",
    };
    if (data !== undefined) headers["Content-Length"] = Buffer.byteLength(data);

    const req = https.request(
      { hostname: parsed.hostname, port: 443, path, method, headers },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          try {
            const json = responseBody ? JSON.parse(responseBody) : {};
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              const err: any = new Error(`Request failed with status code ${res.statusCode}`);
              err.response = { status: res.statusCode, data: json, headers: res.headers };
              reject(err);
            }
          } catch {
            const err: any = new Error(
              `Request failed with status ${res.statusCode}: ${responseBody.slice(0, 200)}`
            );
            err.response = { status: res.statusCode, data: responseBody.slice(0, 500), headers: res.headers };
            reject(err);
          }
        });
      }
    );

    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function growBaseUrl(): string {
  return ENV.GROW_API_BASE_URL.replace(/\/$/, "");
}

async function withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
  return withBackoff(async () => {
    try {
      return await fn();
    } catch (err: any) {
      if (err.response?.status === 401) {
        await refreshAccessToken();
        return await fn();
      }
      throw err;
    }
  });
}

/** GET a single Grow resource. Returns the full JSON body ({ data: ... }). */
export async function growGetSingle(
  url: string,
  params: Record<string, any> = {}
): Promise<any> {
  const qs = buildQueryString(params);
  const fullUrl = qs ? `${growBaseUrl()}${url}?${qs}` : `${growBaseUrl()}${url}`;
  return withAuthRetry(() => growRequest("GET", fullUrl));
}

/**
 * Fetch all pages of a Grow list endpoint by following meta.paging.next
 * (absolute URLs). Stops early at maxResults when provided.
 */
export async function growFetchAllPages<T>(
  url: string,
  params: Record<string, any> = {},
  maxResults?: number
): Promise<T[]> {
  const results: T[] = [];
  const qs = buildQueryString(params);
  let nextUrl: string | undefined = qs
    ? `${growBaseUrl()}${url}?${qs}`
    : `${growBaseUrl()}${url}`;

  while (nextUrl) {
    const data = await withAuthRetry(() => growRequest("GET", nextUrl!));
    results.push(...(data.data ?? []));
    if (maxResults && results.length >= maxResults) {
      return results.slice(0, maxResults);
    }
    nextUrl = data.meta?.paging?.next ?? undefined;
  }

  return results;
}

function logGrowWrite(method: string, path: string, outcome: string): void {
  const ctx = getContext();
  console.log(formatClioWriteLog(method, `grow:${path}`, ctx?.userEmail, ctx?.clioIdentity, outcome));
}

/** POST to Grow. Payloads are envelope-wrapped by the caller ({ data: {...} }). */
export async function growPostSingle(url: string, body: any): Promise<any> {
  await assertActingClioIdentity();
  const fullUrl = `${growBaseUrl()}${url}`;
  try {
    const result = await withAuthRetry(() => growRequest("POST", fullUrl, body));
    const createdId = result?.data?.id;
    logGrowWrite("POST", url, createdId != null ? `ok id=${createdId}` : "ok");
    return result;
  } catch (err: any) {
    logGrowWrite("POST", url, `failed status=${err.response?.status ?? "network"}`);
    throw err;
  }
}

/** DELETE a Grow resource. */
export async function growDeleteSingle(url: string): Promise<any> {
  await assertActingClioIdentity();
  const fullUrl = `${growBaseUrl()}${url}`;
  try {
    const result = await withAuthRetry(() => growRequest("DELETE", fullUrl));
    logGrowWrite("DELETE", url, "ok");
    return result;
  } catch (err: any) {
    logGrowWrite("DELETE", url, `failed status=${err.response?.status ?? "network"}`);
    throw err;
  }
}
