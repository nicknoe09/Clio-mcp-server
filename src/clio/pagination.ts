import { getClioClient } from "./client";
import { withBackoff } from "./rateLimit";

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
    const res = await withBackoff(() =>
      client.get(url, {
        params: {
          ...params,
          limit: 200,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      })
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
