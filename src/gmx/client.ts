/**
 * GMX v2 public data, read-only.
 *
 * Two sources: the HTTP API for live positions and trade history, and the
 * Subsquid index for the 30-day leaderboard rows. Both are anonymous, but the
 * trade routes intermittently answer 500 after ten seconds, so every call is
 * retried on the peer host. The squid rejects non-browser user agents.
 */

const API_HOSTS = ["https://arbitrum.gmxapi.io/v1", "https://arbitrum.gmxapi.ai/v1"];
const SQUID = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** GET the GMX API, alternating peers and retrying the flaky trade routes. */
async function api<T>(path: string, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    for (const host of API_HOSTS) {
      try {
        const res = await fetch(host + path, {
          headers: { "user-agent": UA, accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`gmx ${res.status}`);
        return (await res.json()) as T;
      } catch (err) {
        last = err;
      }
    }
    await sleep(400 * (i + 1));
  }
  throw last instanceof Error ? last : new Error("gmx api failed");
}

/** POST the GMX API with the same peer rotation as the GET helper. */
async function apiPost<T>(path: string, payload: unknown, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    for (const host of API_HOSTS) {
      try {
        const res = await fetch(host + path, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": UA, accept: "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`gmx ${res.status}`);
        return (await res.json()) as T;
      } catch (err) {
        last = err;
      }
    }
    await sleep(400 * (i + 1));
  }
  throw last instanceof Error ? last : new Error("gmx api failed");
}

interface GqlError {
  message?: string;
}

/** POST one GraphQL query to the indexer. */
async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(SQUID, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`gmx index ${res.status}`);
      const body = (await res.json()) as { data?: T; errors?: GqlError[] };
      if (body.errors?.length) throw new Error(body.errors[0]?.message ?? "gmx index error");
      if (!body.data) throw new Error("gmx index returned nothing");
      return body.data;
    } catch (err) {
      last = err;
      await sleep(800 * (i + 1));
    }
  }
  throw last instanceof Error ? last : new Error("gmx index failed");
}

// 30-decimal fixed point in, plain dollars out.
const usd = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n / 1e30 : 0;
};

export interface MarketInfo {
  name: string;
  symbol: string;
  marketToken: string;
  indexToken: string;
}

let marketsCache: { at: number; map: Map<string, MarketInfo> } | null = null;

/** market address -> market name, cached for ten minutes. */
export async function marketMap(): Promise<Map<string, MarketInfo>> {
  if (marketsCache && Date.now() - marketsCache.at < 10 * 60_000) return marketsCache.map;
  const map = new Map<string, MarketInfo>();
  try {
    const rows = await api<Array<{ name?: string; marketTokenAddress?: string; indexTokenAddress?: string }>>(
      "/markets/info",
    );
    for (const m of rows) {
      if (!m.marketTokenAddress || !m.name) continue;
      const symbol = m.name.split("/")[0]?.trim() ?? m.name;
      map.set(m.marketTokenAddress.toLowerCase(), {
        name: m.name,
        symbol,
        marketToken: m.marketTokenAddress,
        indexToken: m.indexTokenAddress ?? "",
      });
    }
  } catch {
    /* names fall back to the raw address */
  }
  marketsCache = { at: Date.now(), map };
  return map;
}

export interface RawPosition {
  key: string;
  indexName?: string;
  poolName?: string;
  marketAddress?: string;
  isLong?: boolean;
  sizeInUsd?: string;
  collateralUsd?: string;
  entryPrice?: string;
  markPrice?: string;
  liquidationPrice?: string | null;
  leverage?: string;
  pnl?: string;
  pnlPercentage?: string;
}

export async function positions(addr: string): Promise<RawPosition[]> {
  try {
    const rows = await api<RawPosition[]>(`/positions?address=${addr}`);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export interface RawTrade {
  eventName?: string;
  timestamp?: number;
  account?: string;
  marketAddress?: string;
  isLong?: boolean;
  sizeDeltaUsd?: string;
  pnlUsd?: string;
  orderType?: number;
}

/** The last `hours` of executed trades for one account, newest first. */
export async function trades(addr: string, hours = 48): Promise<RawTrade[]> {
  const now = Math.floor(Date.now() / 1000);
  const since = now - hours * 3600;
  const out: RawTrade[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 4; page++) {
    // /trades/search, not /trades: the plain route drops sizeDeltaUsd on some
    // decrease events, which showed up as zero-sized fills.
    const body: { trades?: RawTrade[]; nextCursor?: string | null; hasMore?: boolean } = await apiPost(
      "/trades/search",
      { address: addr, fromTimestamp: since, toTimestamp: now, limit: 300, ...(cursor ? { cursor } : {}) },
    );
    out.push(...(body.trades ?? []));
    if (!body.hasMore || !body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return out.filter((t) => t.eventName === "OrderExecuted").sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export interface PeriodRow {  id: string;
  realizedPnl?: string;
  realizedFees?: string;
  realizedSwapFees?: string;
  realizedPriceImpact?: string;
  realizedSwapImpact?: string;
  positiveFundingFeesUsd?: string;
  maxCapital?: string;
  volume?: string;
  closedCount?: number;
  wins?: number;
  losses?: number;
  cumsumSize?: string;
  cumsumCollateral?: string;
  sumMaxSize?: string;
}

const BOARD_QUERY = `
query Board($from: Int!, $to: Int!, $min: String!, $limit: Float!) {
  periodAccountStats(where: { from: $from, to: $to, maxCapital_gte: $min }, limit: $limit) {
    id
    realizedPnl
    realizedFees
    realizedSwapFees
    realizedPriceImpact
    realizedSwapImpact
    positiveFundingFeesUsd
    maxCapital
    volume
    closedCount
    wins
    losses
    cumsumSize
    cumsumCollateral
    sumMaxSize
  }
}
`;

/**
 * One window of the board, sorted by realised PnL.
 *
 * The resolver rejects a `from` that is not UTC midnight, so windows are day
 * aligned; `to` is tomorrow's midnight so today's trades count.
 */
export async function boardRows(fromTs: number, toTs: number, minCapitalUsd = 1_000): Promise<PeriodRow[]> {
  const data = await gql<{ periodAccountStats: PeriodRow[] }>(BOARD_QUERY, {
    from: fromTs,
    to: toTs,
    min: (BigInt(Math.round(minCapitalUsd)) * 10n ** 30n).toString(),
    limit: 20000,
  });
  return data.periodAccountStats ?? [];
}

/** Net realised PnL in USD: GMX's own definition, price impact and funding included. */
export function netPnl(r: PeriodRow): number {
  const raw =
    Number(r.realizedPnl ?? 0) -
    Number(r.realizedFees ?? 0) -
    Number(r.realizedSwapFees ?? 0) +
    Number(r.realizedPriceImpact ?? 0) +
    Number(r.realizedSwapImpact ?? 0) +
    Number(r.positiveFundingFeesUsd ?? 0);
  return Number.isFinite(raw) ? raw / 1e30 : 0;
}

export interface DailyStat {
  dayTimestamp: number;
  realizedPnl: string;
}

const DAILY_QUERY = `
query Daily($a: String!, $from: Int!) {
  accountStats(where: { account_eq: $a, period_eq: "1d", dayTimestamp_gte: $from }, orderBy: dayTimestamp_ASC, limit: 40) {
    dayTimestamp
    realizedPnl
  }
}
`;

/** Daily realised PnL rows for one account, oldest first. */
export async function dailyStats(addr: string, fromTs: number): Promise<DailyStat[]> {
  try {
    const data = await gql<{ accountStats: DailyStat[] }>(DAILY_QUERY, { a: addr, from: fromTs });
    return data.accountStats ?? [];
  } catch {
    return [];
  }
}

export { usd };
