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
    // Keep everything percent-encoded — Clio accepts %7B/%7D/%2C
    // (confirmed: Clio's own pagination URLs use this encoding)
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
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

    // Safety check: if we're requesting fields with braces, make sure they survived
    // Braces are percent-encoded as %7B/%7D in the URL
    if (path.includes("fields=") && !path.includes("%7B") && !path.includes("{")) {
      reject(new Error("BUG: Curly braces were stripped from field syntax. URL: " + path));
      return;
    }

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
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          const err: any = new Error(`Request failed with status code ${res.statusCode}`);
          err.response = { status: res.statusCode, data: JSON.parse(body), headers: res.headers };
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

  // Build initial URL
  const qs = buildQueryString({ ...params, limit: 200 });
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
