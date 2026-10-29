import type { GmxBoard, GmxLastTrade, GmxPosition, GmxRow, GmxTrade, GmxWallet } from "@shared/gmx";
import { boardRows, dailyStats, marketMap, marketSymbols, ohlcv, positions, trades, usd, netPnl, type PeriodRow } from "./client";
import { computeSeries } from "../indicators";

/**
 * GMX screen and wallet detail.
 *
 * The board is GMX's own accounting: PNL ($) is the venue's realizedPnl, and
 * the percentage is their formula over the capital used in the window. Mixing
 * in our own equity ratio would make the numbers disagree with app.gmx.io.
 */

const BOARD_TTL_MS = 5 * 60_000;
const WALLET_TTL_MS = 60_000;

const boardCache = new Map<string, { at: number; data: GmxBoard }>();
const marketCache: { at: number; map: Awaited<ReturnType<typeof marketMap>> } = { at: 0, map: new Map() };

const midnight = (ts = Date.now()) => Math.floor(ts / 1000 / 86_400) * 86_400;

function toRow(r: PeriodRow): GmxRow {
  const capital = usd(r.maxCapital);
  const so = Number(r.cumsumSize ?? 0);
  const sc = Number(r.cumsumCollateral ?? 0);
  const closed = Number(r.closedCount ?? 0);
  return {
    addr: r.id,
    pnl: usd(r.realizedPnl),
    roi: capital > 0 ? netPnl(r) / capital : 0,
    volume: usd(r.volume),
    avgSize: closed > 0 ? usd(r.sumMaxSize) / closed : 0,
    avgLev: sc > 0 && so > 0 ? so / sc : 0,
    wins: Number(r.wins ?? 0),
    losses: Number(r.losses ?? 0),
    trades: closed,
    trades48: null,
    capital,
  };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function gmxBoard(window: "7d" | "30d" = "30d"): Promise<GmxBoard> {
  const hit = boardCache.get(window);
  if (hit && Date.now() - hit.at < BOARD_TTL_MS) return hit.data;

  const days = window === "7d" ? 7 : 30;
  const to = midnight() + 86_400;
  const from = midnight() - days * 86_400;
  const raw = await boardRows(from, to, 1_000);
  const rows = raw
    .map(toRow)
    .filter((r) => r.pnl > 0 && r.trades >= 1)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 60);

  // Fill counts for the last 48h come from the trade API, one call per row.
  // Without them the board would have no short window at all.
  const withFills = await mapPool(rows, 6, async (r) => ({
    ...r,
    trades48: await trades(r.addr, 48)
      .then((list) => list.length)
      .catch(() => null),
  }));

  const data: GmxBoard = { at: Date.now(), window, from, to, rows: withFills };
  boardCache.set(window, { at: data.at, data });
  return data;
}

async function markets() {
  if (Date.now() - marketCache.at > 10 * 60_000) {
    marketCache.map = await marketMap();
    marketCache.at = Date.now();
  }
  return marketCache.map;
}

const ORDER_KIND: Record<number, string> = {
  2: "open",
  3: "open",
  8: "open",
  4: "close",
  5: "close",
  6: "close",
  7: "liquidation",
};

function marketLabel(map: Map<string, { symbol: string }>, marketAddress?: string, indexName?: string): string {
  if (indexName) return indexName;
  const hit = marketAddress ? map.get(marketAddress.toLowerCase()) : undefined;
  return hit?.symbol ?? marketAddress ?? "-";
}

const lastCache = new Map<string, { at: number; last: GmxLastTrade | null }>();

/** The newest executed fill in the last 48h, for the favourites cards. */
export async function gmxLastTrade(addr: string): Promise<GmxLastTrade | null> {
  const key = addr.toLowerCase();
  const hit = lastCache.get(key);
  if (hit && Date.now() - hit.at < 2 * 60_000) return hit.last;

  let last: GmxLastTrade | null = null;
  try {
    const [rows, map] = await Promise.all([trades(addr, 48), markets()]);
    const t = rows[0];
    if (t) {
      const size = usd(t.sizeDeltaUsd);
      const pnl = usd(t.pnlUsd);
      last = {
        side: t.isLong ? "LONG" : "SHORT",
        market: marketLabel(map, t.marketAddress),
        pnlPct: size > 0 ? pnl / size : null,
        kind: ORDER_KIND[t.orderType ?? -1] ?? "trade",
        at: (t.timestamp ?? 0) * 1000,
      };
    }
  } catch {
    last = hit?.last ?? null;
  }
  lastCache.set(key, { at: Date.now(), last });
  return last;
}

export async function gmxWallet(addr: string): Promise<GmxWallet> {
  const [pos, rawTrades, map, board] = await Promise.all([
    positions(addr),
    trades(addr, 48).catch(() => []),
    markets(),
    gmxBoard("30d").catch(() => null),
  ]);

  const row = board?.rows.find((r) => r.addr.toLowerCase() === addr.toLowerCase()) ?? null;
  // The index compares addresses exactly, and the board carries the venue's
  // checksummed casing, which is the one that returns rows.
  const canonical = row?.addr ?? addr;
  const daily = await dailyStats(canonical, midnight() - 30 * 86_400);

  let running = 0;
  const curve = daily.map((d) => {
    running += usd(d.realizedPnl);
    return { t: d.dayTimestamp * 1000, v: running };
  });

  const label = (marketAddress?: string, indexName?: string) => marketLabel(map, marketAddress, indexName);

  const rows: GmxPosition[] = pos
    .map((p) => ({
      key: p.key,
      market: p.indexName ?? label(p.marketAddress),
      pool: p.poolName ?? "",
      isLong: Boolean(p.isLong),
      sizeUsd: usd(p.sizeInUsd),
      collateralUsd: usd(p.collateralUsd),
      entryPx: usd(p.entryPrice),
      markPx: usd(p.markPrice),
      liqPx: p.liquidationPrice ? usd(p.liquidationPrice) : null,
      leverage: Number(p.leverage ?? 0) / 10_000,
      pnlUsd: usd(p.pnl),
      pnlPct: Number(p.pnlPercentage ?? 0) / 100,
    }))
    .sort((a, b) => b.sizeUsd - a.sizeUsd);

  const tradeRows: GmxTrade[] = rawTrades
    .filter((t) => (t.orderType ?? 0) >= 2)
    .map((t) => ({
      time: (t.timestamp ?? 0) * 1000,
      market: label(t.marketAddress),
      kind: ORDER_KIND[t.orderType ?? -1] ?? "trade",
      isLong: Boolean(t.isLong),
      sizeUsd: usd(t.sizeDeltaUsd),
      pnlUsd: usd(t.pnlUsd),
    }))
    // A few decrease events report no USD size at all; a row with neither size
    // nor pnl carries nothing a reader can use.
    .filter((t) => t.sizeUsd > 0 || t.pnlUsd !== 0);

  const unrealized = rows.reduce((sum, p) => sum + p.pnlUsd, 0);
  const collateral = rows.reduce((sum, p) => sum + p.collateralUsd, 0);

  return {
    addr: canonical,
    positions: rows,
    trades: tradeRows,
    tradesTotal: tradeRows.length,
    row,
    curve,
    unrealized,
    collateral,
  };
}

const TIMEFRAMES: Record<string, string> = { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };

/** Candles plus the same zero-lag band and MACD the Hyperliquid chart uses. */
export async function gmxChart(symbol: string, interval: string, bars = 400) {
  const timeframe = TIMEFRAMES[interval] ?? "1h";
  const rows = await ohlcv(symbol.toUpperCase(), timeframe, bars);
  const candles = rows
    .map((r) => ({
      time: Math.floor(r.timestamp / 1000),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    }))
    .filter((c) => Number.isFinite(c.close) && c.time > 0)
    .sort((a, b) => a.time - b.time);

  const base = { symbol: symbol.toUpperCase(), interval: timeframe, candles };
  const input = candles.map((c) => ({ ts: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close, volume: 0 }));
  if (input.length < 80) return { ...base, band: null, basis: [], macd: null, markers: null };

  const series = computeSeries(input);
  const at = (i: number) => candles[i]!.time;
  const line = (arr: number[], from: number) =>
    arr
      .map((v, i) => (i >= from && Number.isFinite(v) ? { time: at(i), value: v } : null))
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

export { marketSymbols };
