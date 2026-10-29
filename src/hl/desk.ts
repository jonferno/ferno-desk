import type {
  CandleResponse,
  CurvePoint,
  FollowedLastTrade,
  LeaderRow,
  MarketRow,
  PerpPosition,
  SpotBalance,
  WalletDetail,
  WalletFill,
} from "@shared/hl";
import { existsSync as exists, readFileSync as readFile, writeFileSync as writeFile } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { info, LEADERBOARD_URL, pool } from "./client";
import { computeSeries } from "../indicators";

const DAY = 86_400_000;
const MIN_ORDER = 10;

interface LbRow {
  ethAddress: string;
  accountValue: string;
  windowPerformances: Array<[string, { pnl?: string; roi?: string; vlm?: string }]>;
}

async function leaderboardRaw(): Promise<LbRow[]> {
  const res = await fetch(LEADERBOARD_URL, { signal: AbortSignal.timeout(40_000) });
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  const body = (await res.json()) as { leaderboardRows?: LbRow[] };
  return body.leaderboardRows ?? [];
}

async function portfolio(addr: string): Promise<Record<string, { accountValueHistory?: [number, string][]; pnlHistory?: [number, string][] }>> {
  const p = await info<Array<[string, Record<string, [number, string][]>]>>({ type: "portfolio", user: addr });
  const out: Record<string, { accountValueHistory?: [number, string][]; pnlHistory?: [number, string][] }> = {};
  for (const [k, v] of p) out[k] = v as { accountValueHistory?: [number, string][]; pnlHistory?: [number, string][] };
  return out;
}

/** pnlHistory is cumulative, so daily statistics come from the differences. */
function dailyStats(cumulative: number[]): { pnl: number; greenDays: number; worstDay: number; concentration: number } {
  const deltas = cumulative.slice(1).map((v, i) => v - cumulative[i]!);
  const pnl = cumulative.length ? cumulative[cumulative.length - 1]! : 0;
  const greenDays = deltas.length ? (100 * deltas.filter((d) => d > 0).length) / deltas.length : 0;
  const worstDay = deltas.length ? Math.min(...deltas) : 0;
  const best = deltas.length ? Math.max(...deltas) : 0;
  return { pnl, greenDays, worstDay, concentration: pnl > 0 ? best / pnl : 1 };
}

interface Fills24 {
  trades: number;
  coins: number;
}

async function fillsSince(addr: string, hours: number): Promise<Fills24> {
  const now = Date.now();
  const fills = await info<Array<{ coin: string }>>({
    type: "userFillsByTime",
    user: addr,
    startTime: now - hours * 3_600_000,
    endTime: now,
    aggregateByTime: false,
  });
  return { trades: fills.length, coins: new Set(fills.map((f) => f.coin)).size };
}

/**
 * Merge the four portfolio windows into one equity series.
 *
 * Each window samples the same account value at a different resolution: the
 * day view is ~2h apart, the month view ~16h, all-time ~18h. Using only
 * all-time leaves the last day as one or two points, which is exactly the
 * stretch someone opens a wallet to look at. Timestamps are deduplicated and
 * non-positive values dropped: all-time starts at 0 before the account was
 * funded, and that one point flattens the whole chart.
 */
function equityCurve(p: Awaited<ReturnType<typeof portfolio>>): CurvePoint[] {
  const byTime = new Map<number, number>();
  for (const key of ["allTime", "month", "week", "day"] as const) {
    for (const [t, v] of p[key]?.accountValueHistory ?? []) {
      const value = Number(v);
      if (!Number.isFinite(value) || value <= 0) continue;
      byTime.set(Number(t), value);
    }
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

export interface ScreenResult {
  pass: LeaderRow[];
  near: LeaderRow[];
}

/**
 * Consistency screen. Two lists so the near misses stay visible instead of
 * being hidden: a wallet that fails exactly one test is still worth watching.
 */
interface Stats {
  greenDays: number;
  worstDay: number;
  concentration: number;
}

interface CacheEntry extends Stats {
  at: number;
  /** Last successful fills classification, reused when a refresh cannot reach the API. */
  fillsAt?: number;
  trades?: number;
  coins?: number;
  fails?: string;
}

const STATS_TTL_MS = 6 * 3_600_000;
const STATS_STALE_MS = 24 * 3_600_000;
const STATS_PATH = resolvePath(process.env.DATA_DIR ?? "./data", "stats.json");

let statsCache: Map<string, CacheEntry> | null = null;

function loadStats(): Map<string, CacheEntry> {
  if (statsCache) return statsCache;
  statsCache = new Map();
  try {
    if (exists(STATS_PATH)) {
      const raw = JSON.parse(readFile(STATS_PATH, "utf8")) as Record<string, CacheEntry>;
      for (const [k, v] of Object.entries(raw)) {
        if (v && Number.isFinite(v.greenDays)) statsCache.set(k, v);
      }
    }
  } catch {
    /* a corrupt cache just means a cold start */
  }
  return statsCache;
}

function saveStats(): void {
  try {
    const out: Record<string, CacheEntry> = {};
    for (const [k, v] of loadStats()) out[k] = v;
    writeFile(STATS_PATH, JSON.stringify(out));
  } catch {
    /* ignore */
  }
}

/**
 * Consistency screen.
 *
 * Portfolio stats move slowly, so they are cached for six hours and reused for a
 * day if a refresh cannot reach the API. Without that, a throttled refresh drops
 * wallets at random and the board flickers.
 */
export async function screenLeaderboard(limit = 25, nearLimit = 14): Promise<ScreenResult> {
  const raw = await leaderboardRaw();
  const all = raw
    .map((r) => {
      const perf = Object.fromEntries(r.windowPerformances) as Record<string, { pnl?: string; roi?: string }>;
      const month = perf.month ?? {};
      return {
        addr: r.ethAddress,
        equity: Number(r.accountValue) || 0,
        pnl30: Number(month.pnl ?? 0) || 0,
        roi30: Number(month.roi ?? 0) || 0,
      };
    })
    .filter((r) => r.equity >= 10_000 && r.pnl30 > 0);

  const candidates = [...all].sort((a, b) => b.pnl30 - a.pnl30).slice(0, 400);
  const cache = loadStats();
  const now = Date.now();

  const stale = candidates.filter((r) => {
    const hit = cache.get(r.addr);
    return !hit || now - hit.at > STATS_TTL_MS;
  });

  await pool(stale, 4, async (r) => {
    try {
      const p = await portfolio(r.addr);
      const series = (p.month?.pnlHistory ?? p.allTime?.pnlHistory ?? []).map(([, v]) => Number(v)).filter(Number.isFinite);
      if (series.length < 10) return;
      const st = dailyStats(series);
      cache.set(r.addr, { at: now, greenDays: st.greenDays, worstDay: st.worstDay, concentration: st.concentration });
    } catch {
      /* keep the old entry, if any */
    }
  });
  saveStats();

  const withStats = candidates
    .map((r) => ({ r, hit: cache.get(r.addr) }))
    .filter((x): x is { r: (typeof candidates)[number]; hit: CacheEntry } =>
      Boolean(x.hit) && now - x.hit!.at < STATS_STALE_MS,
    );

  const ranked = withStats.slice(0, 70);
  const pass: LeaderRow[] = [];
  const near: LeaderRow[] = [];
  let failed = 0;

  await pool(ranked, 4, async ({ r, hit }) => {
    let f: Fills24 | null = null;
    for (let attempt = 0; attempt < 2 && !f; attempt++) {
      try {
        f = await fillsSince(r.addr, 48);
      } catch {
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      }
    }

    const fails: string[] = [];
    let trades: number | null = null;
    let coins: number | null = null;

    if (f) {
      trades = f.trades;
      coins = f.coins;
      if (f.trades < 3) fails.push("inactive 48h");
      if (hit.greenDays < 48) fails.push(`green ${hit.greenDays.toFixed(0)}%`);
      if (hit.concentration >= 0.7) fails.push(`one day ${(hit.concentration * 100).toFixed(0)}% of profit`);
      if (hit.worstDay < -0.3 * r.equity) fails.push(`drawdown ${((-hit.worstDay / r.equity) * 100).toFixed(0)}%`);
      hit.fillsAt = now;
      hit.trades = trades;
      hit.coins = coins;
      hit.fails = fails.join(", ");
    } else if (hit.fillsAt && now - hit.fillsAt < 2 * 3_600_000) {
      // reuse the last known classification rather than dropping the wallet
      trades = hit.trades ?? null;
      coins = hit.coins ?? null;
      if (hit.fails) fails.push(...hit.fails.split(", ").filter(Boolean));
    } else {
      failed++;
      return;
    }

    const row: LeaderRow = {
      ...r,
      greenDays: hit.greenDays,
      worstDay: hit.worstDay,
      concentration: hit.concentration,
      followable: null,
      trades24h: trades,
      coins24h: coins,
      verdict: fails.length ? "lucky" : "consistent",
      reason: fails.join(", "),
    };
    if (!fails.length) pass.push(row);
    else if (fails.length === 1) near.push(row);
  });

  console.log(
    `[screen] stats fresh ${candidates.length - stale.length}/${candidates.length}, ` +
      `refreshed ${stale.length}, fills failed ${failed}`,
  );

  return {
    pass: pass.sort((a, b) => b.pnl30 - a.pnl30).slice(0, limit),
    near: near.sort((a, b) => b.pnl30 - a.pnl30).slice(0, nearLimit),
  };
}

/** Spot fills carry an asset id like "@162", not a ticker. Resolve it once. */
let spotLabels: { at: number; map: Map<string, string> } | null = null;

export async function spotNameMap(): Promise<Map<string, string>> {
  if (spotLabels && Date.now() - spotLabels.at < 30 * 60_000) return spotLabels.map;
  const map = new Map<string, string>();
  try {
    const meta = await info<{
      universe: Array<{ name: string; index: number; tokens?: number[] }>;
      tokens: Array<{ name: string; index: number }>;
    }>({ type: "spotMeta" });
    const tokenName = new Map<number, string>();
    for (const t of meta.tokens ?? []) tokenName.set(t.index, t.name);
    for (const a of meta.universe ?? []) {
      const [t0, t1] = a.tokens ?? [];
      const n0 = t0 != null ? tokenName.get(t0) : undefined;
      const n1 = t1 != null ? tokenName.get(t1) : undefined;
      const label = n0 && n1 ? `${n0}/${n1}` : n0 ?? a.name;
      map.set(a.name, label);
      map.set(String(a.index + 10000), label);
    }
  } catch {
    /* fall back to the raw id */
  }
  spotLabels = { at: Date.now(), map };
  return map;
}

const FILLS_TTL_MS = 60_000;
const fillsCache = new Map<string, { at: number; raw: Array<{ time: number; coin: string; dir: string; px: string; sz: string; closedPnl?: string }> }>();

async function rawFills48(addr: string) {
  const hit = fillsCache.get(addr);
  if (hit && Date.now() - hit.at < FILLS_TTL_MS) return hit.raw;
  const now = Date.now();
  const raw = await info<Array<{ time: number; coin: string; dir: string; px: string; sz: string; closedPnl?: string }>>({
    type: "userFillsByTime",
    user: addr,
    startTime: now - 48 * 3_600_000,
    endTime: now,
    aggregateByTime: false,
  });
  fillsCache.set(addr, { at: now, raw });
  return raw;
}

async function toFills(list: Array<{ time: number; coin: string; dir: string; px: string; sz: string; closedPnl?: string }>): Promise<WalletFill[]> {
  const names = await spotNameMap();
  return list.map((f) => ({
    time: f.time,
    coin: f.coin,
    name: names.get(f.coin) ?? f.coin,
    dir: f.dir,
    px: Number(f.px),
    sz: Number(f.sz),
    notional: Number(f.sz) * Number(f.px),
    closedPnl: Number(f.closedPnl ?? 0),
  }));
}

/** One page of the 48h trade log, newest first. */
export async function walletFillsPage(addr: string, offset: number, limit: number) {
  const raw = await rawFills48(addr);
  const ordered = [...raw].sort((a, b) => b.time - a.time);
  return {
    total: ordered.length,
    offset,
    fills: await toFills(ordered.slice(offset, offset + limit)),
  };
}

interface VenuePosition {
  coin: string;
  szi: string;
  leverage?: { type?: string; value?: number };
}

interface ClearinghouseState {
  assetPositions?: Array<{ position?: VenuePosition }>;
}

interface SpotState {
  balances?: Array<{ coin: string; total: string; entryNtl?: string }>;
}

let midsCache: { at: number; map: Record<string, number> } | null = null;

async function mids(): Promise<Record<string, number>> {
  if (midsCache && Date.now() - midsCache.at < 30_000) return midsCache.map;
  try {
    const map = await info<Record<string, string>>({ type: "allMids" });
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(map)) out[k] = Number(v);
    midsCache = { at: Date.now(), map: out };
    return out;
  } catch {
    return midsCache?.map ?? {};
  }
}

interface Bucket {
  q: number;
  a: number;
  fills: number;
  since: number;
}

function accumulate(b: Bucket, d: number, px: number, t: number): void {
  if (b.q === 0 || (b.q > 0) === (d > 0)) {
    const total = Math.abs(b.q) + Math.abs(d);
    b.a = total ? (b.a * Math.abs(b.q) + px * Math.abs(d)) / total : px;
    b.q += d;
  } else {
    const newQ = b.q + d;
    if (Math.abs(d) > Math.abs(b.q)) b.a = px;
    b.q = Math.abs(newQ) < 1e-9 ? 0 : newQ;
    if (b.q === 0) b.a = 0;
  }
  b.fills += 1;
  if (!b.since) b.since = t;
}

const isBuyFill = (dir: string) =>
  dir.startsWith("Open Long") || dir.startsWith("Close Short") || dir === "Buy";

/** Positions implied by the 48h of fills only, priced at current mids. */
async function windowPositions(
  addr: string,
  raw: Array<{ time: number; coin: string; dir: string; px: string; sz: string }>,
): Promise<{ positions: PerpPosition[]; spot: SpotBalance[] }> {
  const [priceMap, names] = await Promise.all([mids(), spotNameMap()]);

  let venue = new Map<string, { size: number; leverage: number | null }>();
  try {
    const state = await info<ClearinghouseState>({ type: "clearinghouseState", user: addr });
    venue = new Map(
      (state.assetPositions ?? [])
        .map((a) => a.position)
        .filter((p): p is VenuePosition => Boolean(p?.coin))
        .map((p) => {
          const lev = Number(p.leverage?.value);
          return [p.coin, { size: Number(p.szi), leverage: Number.isFinite(lev) && lev > 0 ? lev : null }];
        }),
    );
  } catch {
    /* the venue size and leverage are only context */
  }

  const perp = new Map<string, Bucket>();
  const spot = new Map<string, Bucket>();

  for (const f of raw) {
    const px = Number(f.px);
    const size = Number(f.sz);
    if (!(px > 0) || !(size > 0)) continue;
    const signed = (isBuyFill(f.dir) ? 1 : -1) * size;
    const isSpot = f.coin.startsWith("@") || f.coin.includes("/");
    const bucket = isSpot ? spot : perp;
    const hit = bucket.get(f.coin) ?? { q: 0, a: 0, fills: 0, since: 0 };
    accumulate(hit, signed, px, f.time);
    bucket.set(f.coin, hit);
  }

  const positions: PerpPosition[] = [];
  for (const [coin, b] of perp) {
    if (Math.abs(b.q) < 1e-9) continue;
    const mark = priceMap[coin] ?? b.a;
    positions.push({
      coin,
      name: names.get(coin) ?? coin,
      size: b.q,
      entryPx: b.a,
      markPx: mark,
      unrealizedPnl: (mark - b.a) * b.q,
      fills: b.fills,
      since: b.since,
      venueSize: venue.get(coin)?.size ?? null,
      leverage: venue.get(coin)?.leverage ?? null,
    });
  }

  const spotRows: SpotBalance[] = [];
  for (const [coin, b] of spot) {
    if (Math.abs(b.q) < 1e-9) continue;
    const mark = priceMap[coin] ?? b.a;
    spotRows.push({
      coin,
      name: names.get(coin) ?? coin,
      total: b.q,
      value: b.q * mark,
      fills: b.fills,
    });
  }

  return {
    positions: positions.sort((a, b) => Math.abs(b.size * b.markPx) - Math.abs(a.size * a.markPx)),
    spot: spotRows.sort((a, b) => b.value - a.value).slice(0, 8),
  };
}

interface FillRow {
  time: number;
  coin: string;
  dir: string;
  px: string;
  sz: string;
}

/** The newest fill this wallet made, and how the position it left behind is doing. */
async function lastTrade(addr: string): Promise<FollowedLastTrade | null> {
  let window: FillRow[] = [];
  try {
    window = await rawFills48(addr);
  } catch {
    window = [];
  }

  let newest: FillRow | null = window.length
    ? window.reduce((a, b) => (b.time > a.time ? b : a), window[0]!)
    : null;

  if (!newest) {
    // Nothing in 48h: ask the venue for the latest fills without a window.
    try {
      const recent = await info<FillRow[]>({ type: "userFills", user: addr });
      newest = recent.length ? recent.reduce((a, b) => (b.time > a.time ? b : a), recent[0]!) : null;
    } catch {
      newest = null;
    }
  }
  if (!newest) return null;

  let coinName = newest.coin;
  let mark = 0;
  try {
    const [names, priceMap] = await Promise.all([spotNameMap(), mids()]);
    coinName = names.get(newest.coin) ?? newest.coin;
    mark = priceMap[newest.coin] ?? 0;
  } catch {
    /* keep the raw coin and no mark */
  }

  // Rebuild just this coin's position from the 48h fills, same rules as the wallet page.
  const b: Bucket = { q: 0, a: 0, fills: 0, since: 0 };
  for (const f of window) {
    if (f.coin !== newest.coin) continue;
    const px = Number(f.px);
    const size = Number(f.sz);
    if (!(px > 0) || !(size > 0)) continue;
    accumulate(b, (isBuyFill(f.dir) ? 1 : -1) * size, px, f.time);
  }

  const open = Math.abs(b.q) > 1e-9;
  const side: "LONG" | "SHORT" = open ? (b.q > 0 ? "LONG" : "SHORT") : isBuyFill(newest.dir) ? "LONG" : "SHORT";
  const entry = open && b.a > 0 ? b.a : null;
  const pct = open && entry && mark > 0 ? ((mark - entry) / entry) * (b.q > 0 ? 1 : -1) : null;

  return {
    at: newest.time,
    coin: coinName,
    side,
    pct: pct === null ? null : Number(pct.toFixed(5)),
    entryPx: entry,
    markPx: open && mark > 0 ? mark : null,
  };
}

/** The leaderboard's quality numbers for a single address. */
export async function walletStats(addr: string): Promise<{
  equity: number;
  pnl30: number;
  roi30: number;
  greenDays: number;
  worstDay: number;
  concentration: number;
  trades48h: number;
  last: FollowedLastTrade | null;
}> {
  const p = await portfolio(addr);
  const series = (p.month?.pnlHistory ?? p.allTime?.pnlHistory ?? []).map(([, v]) => Number(v)).filter(Number.isFinite);
  const st = dailyStats(series);
  const curve = p.allTime?.accountValueHistory ?? p.month?.accountValueHistory ?? [];
  const equity = curve.length ? Number(curve[curve.length - 1]![1]) : 0;
  let trades48h = 0;
  try {
    trades48h = (await fillsSince(addr, 48)).trades;
  } catch {
    /* leave zero */
  }
  let last: FollowedLastTrade | null = null;
  try {
    last = await lastTrade(addr);
  } catch {
    last = null;
  }
  return {
    equity,
    pnl30: st.pnl,
    roi30: equity ? st.pnl / equity : 0,
    greenDays: st.greenDays,
    worstDay: st.worstDay,
    concentration: st.concentration,
    trades48h,
    last,
  };
}

export async function walletDetail(addr: string, limit = 50): Promise<WalletDetail> {
  const p = await portfolio(addr);
  const curve = equityCurve(p);
  const stats = dailyStats((p.month?.pnlHistory ?? p.allTime?.pnlHistory ?? []).map(([, v]) => Number(v)).filter(Number.isFinite));
  const equity = curve.length ? curve[curve.length - 1]!.v : 0;
  const raw = await rawFills48(addr);
  const ordered = [...raw].sort((a, b) => b.time - a.time);
  const live = await windowPositions(addr, raw);

  return {
    addr,
    equity,
    pnl30: stats.pnl,
    roi30: equity ? stats.pnl / equity : 0,
    greenDays: stats.greenDays,
    worstDay: stats.worstDay,
    curve,
    positions: live.positions,
    spot: live.spot,
    fills: await toFills(ordered.slice(0, limit)),
    fillsTotal: ordered.length,
  };
}

export async function chartPayload(coin: string, interval: string, bars = 400) {
  const base = await candles(coin, interval, bars);
  const input = base.candles.map((c) => ({
    ts: c.time * 1000,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: 0,
  }));
  if (input.length < 80) return { ...base, band: null, basis: [], macd: null, markers: null };

  const series = computeSeries(input);
  const t = (i: number) => base.candles[i]!.time;
  const line = (arr: number[], from: number) =>
    arr
      .map((v, i) => (i >= from && Number.isFinite(v) ? { time: t(i), value: v } : null))
      .filter((x): x is { time: number; value: number } => x !== null);

  return {
    ...base,
    band: {
      upper: line(series.zerolag.bandUpper, 70),
      lower: line(series.zerolag.bandLower, 70),
    },
    basis: line(series.zerolag.basis, 70),
    macd: {
      line: line(series.macd.macd, 35),
      signal: line(series.macd.signal, 35),
      hist: line(series.macd.hist, 35),
    },
    markers: {
      long: input.map((c, i) => (series.zerolag.entryLong[i] ? Math.floor(c.ts / 1000) : 0)).filter(Boolean),
      short: input.map((c, i) => (series.zerolag.entryShort[i] ? Math.floor(c.ts / 1000) : 0)).filter(Boolean),
    },
    trend: series.zerolag.trend[series.zerolag.trend.length - 1] ?? 0,
    macdTrend: series.macd.trend[series.macd.trend.length - 1] ?? 0,
  };
}

export async function markets(): Promise<MarketRow[]> {
  const [meta, ctxs] = await info<[{ universe: Array<{ name: string; isDelisted?: boolean }> }, Array<Record<string, string>>]>({
    type: "metaAndAssetCtxs",
  });
  const rows: MarketRow[] = [];
  meta.universe.forEach((u, i) => {
    if (u.isDelisted) return;
    const c = ctxs[i];
    if (!c) return;
    const markPx = Number(c.markPx ?? 0);
    const oi = Number(c.openInterest ?? 0) * markPx;
    if (!(markPx > 0) || oi <= 0) return;
    rows.push({ coin: u.name, markPx, funding: Number(c.funding ?? 0), oiUsd: oi });
  });
  return rows.sort((a, b) => b.oiUsd - a.oiUsd);
}

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export async function candles(coin: string, interval: string, bars = 400): Promise<CandleResponse> {
  const step = INTERVAL_MS[interval] ?? 900_000;
  const now = Date.now();
  const rows = await info<Array<{ t: number; o: string; h: string; l: string; c: string }>>({
    type: "candleSnapshot",
    req: { coin, interval, startTime: now - bars * step, endTime: now },
  });
  return {
    coin,
    interval,
    candles: rows.map((c) => ({
      time: Math.floor(Number(c.t) / 1000),
      open: Number(c.o),
      high: Number(c.h),
      low: Number(c.l),
      close: Number(c.c),
    })),
  };
}
