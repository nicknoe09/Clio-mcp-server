import { ENV } from "../utils/env";
import { getAccessToken } from "../utils/tokenStore";
import { refreshAccessToken } from "./auth";
import { withBackoff } from "./rateLimit";
import https from "https";

/**
 * Build a query string preserving Clio field syntax (curly braces, commas).
 */
export function buildQueryString(params: Record<string, any>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    // Encode then restore { } , as literal chars — Clio requires these unencoded
    // (Clio's own pagination URLs use %7B/%7D but initial requests need literal braces)
    const encoded = encodeURIComponent(String(value))
      .replace(/%7B/gi, "{")
      .replace(/%7D/gi, "}")
      .replace(/%2C/gi, ",");
    parts.push(`${encodeURIComponent(key)}=${encoded}`);
  }
  return parts.join("&");
}

/**
 * Make a raw HTTPS GET request, bypassing axios entirely.
 * Axios mangles curly braces in URLs which breaks Clio field syntax.
 */
function rawGet(fullUrl: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const path = fullUrl.slice(fullUrl.indexOf(parsed.pathname));

    // No safety assertion needed — rawGet sends URLs as-is via https.request

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${getAccessToken()}`,
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err: any = new Error(`Request failed with status code ${res.statusCode}`);
            err.response = { status: res.statusCode, data: parsed, headers: res.headers };
            reject(err);
          }
        } catch (parseErr) {
          const err: any = new Error(`Request failed with status ${res.statusCode}: ${body.slice(0, 200)}`);
          err.response = { status: res.statusCode, data: body.slice(0, 500), headers: res.headers };
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetch all pages from a Clio API endpoint.
 * Uses raw HTTPS to avoid axios mangling curly braces in field syntax.
 */
export async function fetchAllPages<T>(
  url: string,
  params: Record<string, any> = {}
): Promise<T[]> {
  const baseUrl = ENV.CLIO_API_BASE_URL.replace(/\/$/, "");
  const results: T[] = [];

  // Build initial URL — use order=id(asc) for unlimited cursor pagination
  // unless the caller specifies their own order (which falls back to offset pagination)
  const allParams = { order: "id(asc)", ...params, limit: 200 };
  const qs = buildQueryString(allParams);
  let nextUrl: string | undefined = `${baseUrl}${url}?${qs}`;

  while (nextUrl) {
    const data = await withBackoff(async () => {
      try {
        return await rawGet(nextUrl!);
      } catch (err: any) {
        if (err.response?.status === 401) {
          await refreshAccessToken();
          return await rawGet(nextUrl!);
        }
        throw err;
      }
    });

    const items = data.data ?? [];
    results.push(...items);

    // Follow Clio's next URL directly (cursor pagination)
    nextUrl = data.meta?.paging?.next ?? undefined;
  }

  return results;
}

/**
 * Fetch a single resource from Clio (non-paginated).
 * Uses raw HTTPS like fetchAllPages. Returns the full JSON body.
 */
export async function rawGetSingle(
  url: string,
  params: Record<string, any> = {}
): Promise<any> {
  const baseUrl = ENV.CLIO_API_BASE_URL.replace(/\/$/, "");
  const qs = buildQueryString(params);
  const fullUrl = qs ? `${baseUrl}${url}?${qs}` : `${baseUrl}${url}`;

  return withBackoff(async () => {
    try {
      return await rawGet(fullUrl);
    } catch (err: any) {
      if (err.response?.status === 401) {
        await refreshAccessToken();
        return await rawGet(fullUrl);
      }
      throw err;
    }
  });
}

/**
 * Make a raw HTTPS POST request, bypassing axios entirely.
 */
function rawPost(fullUrl: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const data = JSON.stringify(body);

    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${getAccessToken()}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => (responseBody += chunk));
      res.on("end", () => {
        try {
          const parsed = responseBody ? JSON.parse(responseBody) : {};
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err: any = new Error(`Request failed with status code ${res.statusCode}`);
            err.response = { status: res.statusCode, data: parsed, headers: res.headers };
            reject(err);
          }
        } catch (parseErr) {
          const err: any = new Error(`Request failed with status ${res.statusCode}: ${responseBody.slice(0, 200)}`);
          err.response = { status: res.statusCode, data: responseBody.slice(0, 500), headers: res.headers };
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

/**
 * POST a resource to Clio. Returns the full JSON response body.
 */
export async function rawPostSingle(
  url: string,
  body: any
): Promise<any> {
  const baseUrl = ENV.CLIO_API_BASE_URL.replace(/\/$/, "");
  const fullUrl = `${baseUrl}${url}`;

  return withBackoff(async () => {
    try {
      return await rawPost(fullUrl, body);
    } catch (err: any) {
      if (err.response?.status === 401) {
        await refreshAccessToken();
        return await rawPost(fullUrl, body);
      }
      throw err;
    }
  });
}
