import { getClioClient } from "./client";
import { withBackoff } from "./rateLimit";

/**
 * Build a query string preserving Clio field syntax (curly braces, commas).
 * Axios mangles these, so we build the URL ourselves.
 */
export function buildQueryString(params: Record<string, any>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(
      `${encodeURIComponent(key)}=${encodeURIComponent(String(value))
        .replace(/%7B/gi, "{")
        .replace(/%7D/gi, "}")
        .replace(/%2C/gi, ",")}`
    );
  }
  return parts.join("&");
}

/**
 * Fetch all pages from a Clio API endpoint.
 * Clio paginates all list endpoints at 200 records max per page.
 * Without this, you silently receive only the first page.
 */
export async function fetchAllPages<T>(
  url: string,
  params: Record<string, any> = {}
): Promise<T[]> {
  const client = getClioClient();
  const results: T[] = [];
  let pageToken: string | undefined;

  while (true) {
    const allParams = {
      ...params,
      limit: 200,
      ...(pageToken ? { page_token: pageToken } : {}),
    };
    const qs = buildQueryString(allParams);
    const fullUrl = qs ? `${url}?${qs}` : url;

    const res = await withBackoff(() =>
      client.get(fullUrl)
    );

    const data = res.data.data ?? [];
    results.push(...data);

    const next: string | undefined = res.data.meta?.paging?.next;
    if (!next) break;

    try {
      const nextUrl = new URL(next);
      pageToken = nextUrl.searchParams.get("page_token") ?? undefined;
    } catch {
      pageToken = undefined;
    }

    if (!pageToken) break;
  }

  return results;
}
