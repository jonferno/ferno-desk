import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DeskSnapshot, WalletDetail } from "@shared/hl";
import { candles, chartPayload, markets, screenLeaderboard, walletDetail, walletFillsPage, walletStats } from "../hl/desk";
import { Following } from "../hl/follow";
import { Favorites } from "../hl/favorites";
import { registerAuth } from "./auth";
import { gmxBoard, gmxChart, gmxLastTrade, gmxWallet, marketSymbols } from "../gmx/desk";
import { GmxFollowing } from "../gmx/follow";
import type { GmxWallet } from "@shared/gmx";

/**
 * Read-only Hyperliquid desk, plus a following list that can post trade alerts
 * to a Discord webhook. No wallet, no keys, no orders.
 */

const REFRESH_MS = 10 * 60_000;
const WALLET_TTL_MS = 5 * 60_000;

let cache: DeskSnapshot | null = null;
let building: Promise<void> | null = null;
const wallets = new Map<string, { at: number; data: WalletDetail }>();
const inflightWallets = new Map<string, Promise<WalletDetail>>();
const gmxWallets = new Map<string, { at: number; data: GmxWallet }>();
const GMX_WALLET_TTL_MS = 60_000;
const chartCache = new Map<string, { at: number; payload: unknown }>();
const statsCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof walletStats>> | null }>();
const STATS_TTL_MS = 5 * 60_000;
const CHART_TTL_MS = 30_000;

async function build(): Promise<void> {
  if (building) return building;
  building = (async () => {
    const started = Date.now();
    try {
      const [screen, marketRows] = await Promise.all([screenLeaderboard(), markets()]);
      cache = { at: Date.now(), leaderboard: screen.pass, nearMiss: screen.near, markets: marketRows };
      console.log(
        `[desk] refreshed in ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
          `${screen.pass.length} consistent, ${screen.near.length} near misses, ${marketRows.length} markets`,
      );
    } catch (err) {
      console.error("[desk] refresh failed:", (err as Error).message);
      if (!cache) cache = { at: 0, leaderboard: [], nearMiss: [], markets: [] };
    }
  })().finally(() => {
    building = null;
  });
  return building;
}

export function createServer(deps: { following: Following; favorites: Favorites; gmxFollow: GmxFollowing }) {
  const app = Fastify({ logger: false, trustProxy: true });
  const { following, favorites, gmxFollow } = deps;
  registerAuth(app, process.env.SITE_PASSCODE ?? "");

  app.get("/api/health", async () => ({
    ok: true,
    mode: "read-only",
    builtAt: cache?.at ?? 0,
    wallets: cache?.leaderboard.length ?? 0,
    nearMiss: cache?.nearMiss.length ?? 0,
    markets: cache?.markets.length ?? 0,
    following: following.view().wallets.length,
    favorites: favorites.list().length,
  }));

  app.get("/api/desk", async () => {
    if (!cache) await build();
    return { ok: true, desk: cache };
  });

  app.get<{ Params: { addr: string } }>("/api/wallet/:addr", async (req, reply) => {
    const addr = String(req.params.addr ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return reply.code(400).send({ ok: false, error: "bad address" });
    const hit = wallets.get(addr);
    if (hit && Date.now() - hit.at < WALLET_TTL_MS) return { ok: true, wallet: hit.data, following: following.isFollowing(addr) };
    try {
      // One load per wallet: two tabs opening the same address must not double
      // the upstream calls that a throttle is already punishing.
      let job = inflightWallets.get(addr);
      if (!job) {
        job = walletDetail(addr, 50).finally(() => inflightWallets.delete(addr));
        inflightWallets.set(addr, job);
      }
      const data = await job;
      wallets.set(addr, { at: Date.now(), data });
      return { ok: true, wallet: data, following: following.isFollowing(addr) };
    } catch (err) {
      // A throttle must not empty the page: the last good copy is better than
      // an error, as long as the client says how old it is.
      const stale = wallets.get(addr);
      if (stale) return { ok: true, wallet: stale.data, following: following.isFollowing(addr), stale: true, staleAt: stale.at };
      return reply.code(502).send({ ok: false, error: (err as Error).message });
    }
  });

  app.get<{ Querystring: { coin?: string; interval?: string; bars?: string } }>("/api/candles", async (req, reply) => {
    const coin = String(req.query.coin ?? "BTC").toUpperCase();
    const interval = String(req.query.interval ?? "15m");
    const bars = Math.max(60, Math.min(900, Number(req.query.bars ?? 400) || 400));
    try {
      return { ok: true, ...(await candles(coin, interval, bars)) };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: (err as Error).message });
    }
  });

  app.get<{ Params: { addr: string }; Querystring: { offset?: string; limit?: string } }>(
    "/api/wallet/:addr/fills",
    async (req, reply) => {
      const addr = String(req.params.addr ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return reply.code(400).send({ ok: false, error: "bad address" });
      const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
      const limit = Math.max(5, Math.min(100, Number(req.query.limit ?? 25) || 25));
      try {
        return { ok: true, ...(await walletFillsPage(addr, offset, limit)) };
      } catch (err) {
        return reply.code(502).send({ ok: false, error: (err as Error).message });
      }
    },
  );

  app.get<{ Querystring: { coin?: string; interval?: string; bars?: string } }>("/api/chart", async (req, reply) => {
    const coin = String(req.query.coin ?? "BTC").toUpperCase();
    const interval = String(req.query.interval ?? "15m");
    const bars = Math.max(120, Math.min(900, Number(req.query.bars ?? 400) || 400));
    const key = `${coin}:${interval}:${bars}`;
    const hit = chartCache.get(key);
    if (hit && Date.now() - hit.at < CHART_TTL_MS) return { ok: true, ...(hit.payload as object) };
    try {
      const payload = await chartPayload(coin, interval, bars);
      chartCache.set(key, { at: Date.now(), payload });
      return { ok: true, ...payload };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: (err as Error).message });
    }
  });

  app.get("/api/following", async () => {
    const view = following.view();
    const wallets = await Promise.all(
      view.wallets.map(async (w) => {
        const hit = statsCache.get(w.addr);
        if (hit && Date.now() - hit.at < STATS_TTL_MS) return { ...w, stats: hit.data };
        let data: Awaited<ReturnType<typeof walletStats>> | null = null;
        try {
          data = await walletStats(w.addr);
        } catch {
          // Never cache a failure: a throttle spike must not blank the card for minutes.
          return { ...w, stats: hit?.data ?? null };
        }
        statsCache.set(w.addr, { at: Date.now(), data });
        return { ...w, stats: data };
      }),
    );
    return { ok: true, ...view, wallets };
  });

  app.post<{ Body: { addr?: string } }>("/api/following", async (req, reply) => {
    const addr = String(req.body?.addr ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return reply.code(400).send({ ok: false, error: "bad address" });
    const res = await following.add(addr);
    return { ok: true, ...res, following: following.view() };
  });

  app.delete<{ Params: { addr: string } }>("/api/following/:addr", async (req) => {
    following.remove(String(req.params.addr));
    return { ok: true, following: following.view() };
  });

  app.post<{ Params: { addr: string }; Body: { enabled?: boolean } }>("/api/following/:addr/alerts", async (req) => {
    const ok = following.setAlerts(String(req.params.addr), Boolean(req.body?.enabled));
    return { ok, following: following.view() };
  });

  app.put<{ Body: { url?: string } }>("/api/following/webhook", async (req) => {
    following.setWebhook(String(req.body?.url ?? "").trim() || null);
    return { ok: true, following: following.view() };
  });

  app.post("/api/following/test", async () => ({ ok: await following.testWebhook() }));

  app.get("/api/favorites", async () => ({ ok: true, coins: favorites.list() }));

  app.post<{ Body: { coin?: string } }>("/api/favorites", async (req, reply) => {
    const coin = String(req.body?.coin ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9@/._-]{1,24}$/.test(coin)) return reply.code(400).send({ ok: false, error: "coin required" });
    return { ok: true, coins: favorites.add(coin) };
  });

  app.delete<{ Params: { coin: string } }>("/api/favorites/:coin", async (req) => ({
    ok: true,
    coins: favorites.remove(String(req.params.coin)),
  }));

  app.get("/api/gmx/markets", async (_req, reply) => {
    try {
      return { ok: true, symbols: await marketSymbols() };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: (err as Error).message });
    }
  });

  app.get<{ Querystring: { symbol?: string; interval?: string; bars?: string } }>(
    "/api/gmx/chart",
    async (req, reply) => {
      const symbol = String(req.query.symbol ?? "BTC").toUpperCase();
      const interval = String(req.query.interval ?? "1h");
      const bars = Math.min(1_000, Math.max(80, Number(req.query.bars ?? 400) || 400));
      try {
        return { ok: true, ...(await gmxChart(symbol, interval, bars)) };
      } catch (err) {
        return reply.code(502).send({ ok: false, error: (err as Error).message });
      }
    },
  );

  app.get<{ Querystring: { window?: string } }>("/api/gmx/board", async (req, reply) => {    const window = req.query.window === "7d" ? "7d" : "30d";
    try {
      return { ok: true, board: await gmxBoard(window) };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: (err as Error).message });
    }
  });

  app.get("/api/gmx/following", async () => {
    const board = await gmxBoard("30d").catch(() => null);
    const addrs = gmxFollow.list();
    const wallets: Array<{ addr: string; row: unknown; last: unknown }> = new Array(addrs.length);
    // Newest fill per wallet; the desk's trade helper caches each one for two
    // minutes, and four at a time keeps the API from being hammered.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, addrs.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= addrs.length) return;
        const addr = addrs[i]!;
        wallets[i] = {
          addr,
          row: board?.rows.find((r) => r.addr.toLowerCase() === addr.toLowerCase()) ?? null,
          last: await gmxLastTrade(addr),
        };
      }
    });
    await Promise.all(workers);
    return { ok: true, wallets };
  });

  app.post<{ Body: { addr?: string } }>("/api/gmx/following", async (req, reply) => {
    const addr = String(req.body?.addr ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return reply.code(400).send({ ok: false, error: "bad address" });
    gmxFollow.add(addr);
    return { ok: true, wallets: gmxFollow.list() };
  });

  app.delete<{ Params: { addr: string } }>("/api/gmx/following/:addr", async (req) => ({
    ok: true,
    wallets: gmxFollow.remove(String(req.params.addr)),
  }));

  app.get<{ Params: { addr: string } }>("/api/gmx/wallet/:addr", async (req, reply) => {    const addr = String(req.params.addr ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return reply.code(400).send({ ok: false, error: "bad address" });
    const key = addr.toLowerCase();
    const hit = gmxWallets.get(key);
    if (hit && Date.now() - hit.at < GMX_WALLET_TTL_MS) return { ok: true, wallet: hit.data };
    try {
      const data = await gmxWallet(addr);
      gmxWallets.set(key, { at: Date.now(), data });
      return { ok: true, wallet: data };
    } catch (err) {
      // Same rule as the Hyperliquid side: a flaky upstream serves the last
      // good copy instead of an empty page.
      if (hit) return { ok: true, wallet: hit.data, stale: true };
      return reply.code(502).send({ ok: false, error: (err as Error).message });
    }
  });

  const dist = resolve(import.meta.dirname, "../../dist");
  if (existsSync(dist)) {
    app.register(fastifyStatic, {
      root: dist,
      wildcard: false,
      cacheControl: false,
      setHeaders(res, filePath) {
        const name = filePath.replace(/\\/g, "/");
        if (name.endsWith(".html")) {
          // A new build must show up on the next visit, and no-store also keeps
          // the page out of the back-forward cache so an old bundle cannot linger.
          res.setHeader("cache-control", "no-store, must-revalidate");
        } else if (/\/assets\/[^/]+\.(js|css|woff2?|svg|png|jpe?g|webp)$/.test(name)) {
          res.setHeader("cache-control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("cache-control", "public, max-age=300");
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && !req.raw.url.startsWith("/api")) {
        reply.header("cache-control", "no-store, must-revalidate");
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ ok: false, error: "not found" });
    });
  }

  return { app };
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8899);
  const dataDir = process.env.DATA_DIR ?? resolve(import.meta.dirname, "../../data");
  const following = new Following(dataDir);
  const favorites = new Favorites(dataDir);
  const gmxFollow = new GmxFollowing(dataDir);
  const { app } = createServer({ following, favorites, gmxFollow });
  await app.listen({ port, host: "127.0.0.1" });
  console.log(`hl desk  http://localhost:${port}  (read only)`);

  following.start();
  void build();
  setInterval(() => void build(), REFRESH_MS);

  const shutdown = async () => {
    following.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}
