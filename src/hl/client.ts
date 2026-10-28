/** Minimal Hyperliquid info client. Public endpoints only, no keys, read-only. */

export const HL_INFO = "https://api.hyperliquid.xyz/info";
export const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";

export async function info<T>(body: unknown, timeoutMs = 20_000): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(HL_INFO, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`hyperliquid ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      last = err;
      const limited = String((last as Error)?.message ?? last).includes("429");
      await new Promise((r) => setTimeout(r, (limited ? 2500 : 700) * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error("hyperliquid failed");
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run jobs with a small concurrency cap so the public API is not hammered. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
