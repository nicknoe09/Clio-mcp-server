/**
 * Execute an async function with exponential backoff on 429 responses.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  retries: number = 4
): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err.response?.status === 429) {
        const retryAfter = parseInt(
          err.response.headers["retry-after"] || "2",
          10
        );
        const delay = Math.max(retryAfter * 1000, Math.pow(2, i) * 1000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}
