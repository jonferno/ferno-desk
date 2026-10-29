import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FollowedWallet, FollowingView } from "@shared/hl";
import { info } from "./client";
import { spotNameMap } from "./desk";
import { alertPayload, iconFor, iconMap, postWebhook, testPayload } from "../alerts";

/** Open Long / Close Short / Buy add to a long; the rest reduce it. */
const isBuyFill = (dir: string) => dir.startsWith("Open Long") || dir.startsWith("Close Short") || dir === "Buy";

/**
 * Following list and trade alerts.
 *
 * One message per token per 15 minutes at most. Active wallets fire dozens of
 * fills on the same coin within a minute, so the window is per token, not per
 * wallet: the first fill opens the window and later ones are folded into it.
 */

const WINDOW_MS = 15 * 60_000;
const POLL_MS = 60_000;

interface Store {
  webhook: string | null;
  wallets: FollowedWallet[];
}

interface RawFill {
  time: number;
  coin: string;
  dir: string;
  px: string;
  sz: string;
}

const mask = (url: string) => url.replace(/\/[^/]+$/, "/…" + url.slice(-4));

export class Following {
  private path: string;
  private store: Store;
  private lastAlert = new Map<string, number>();
  private alertsSent = 0;
  private polledAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(dataDir: string) {
    this.path = join(dataDir, "following.json");
    this.store = this.load();
  }

  private load(): Store {
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Store>;
        return {
          webhook: typeof raw.webhook === "string" ? raw.webhook : null,
          wallets: Array.isArray(raw.wallets) ? raw.wallets.slice(0, 50) : [],
        };
      }
    } catch {
      /* a corrupt file must not stop the desk */
    }
    return { webhook: null, wallets: [] };
  }

  private save(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.store, null, 1));
    } catch {
      /* ignore */
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  view(): FollowingView {
    return {
      webhook: this.store.webhook ? mask(this.store.webhook) : null,
      wallets: this.store.wallets,
      polledAt: this.polledAt,
      alertsSent: this.alertsSent,
      windowMinutes: WINDOW_MS / 60_000,
    };
  }

  async add(addr: string): Promise<{ added: boolean; trades: number | null; coins: number | null }> {
    const existing = this.store.wallets.find((w) => w.addr.toLowerCase() === addr.toLowerCase());
    if (existing) return { added: false, trades: null, coins: null };
    const now = Date.now();
    let trades: number | null = null;
    let coins: number | null = null;
    try {
      const fills = await info<RawFill[]>({
        type: "userFillsByTime",
        user: addr,
        startTime: now - 24 * 3_600_000,
        endTime: now,
        aggregateByTime: false,
      });
      trades = fills.length;
      coins = new Set(fills.map((f) => f.coin)).size;
    } catch {
      /* still allow following, activity unknown */
    }
    this.store.wallets.push({ addr, addedAt: now, alerts: true, lastFillAt: now, trades24h: trades, coins24h: coins });
    this.save();
    return { added: true, trades, coins };
  }

  remove(addr: string): boolean {
    const before = this.store.wallets.length;
    this.store.wallets = this.store.wallets.filter((w) => w.addr.toLowerCase() !== addr.toLowerCase());
    this.save();
    return this.store.wallets.length !== before;
  }

  setAlerts(addr: string, enabled: boolean): boolean {
    const w = this.store.wallets.find((x) => x.addr.toLowerCase() === addr.toLowerCase());
    if (!w) return false;
    w.alerts = enabled;
    this.save();
    return true;
  }

  setWebhook(url: string | null): void {
    this.store.webhook = url && /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url) ? url : null;
    this.save();
  }

  async testWebhook(): Promise<boolean> {
    if (!this.store.webhook) return false;
    return this.post(testPayload("hyperliquid"));
  }

  isFollowing(addr: string): boolean {
    return this.store.wallets.some((w) => w.addr.toLowerCase() === addr.toLowerCase());
  }

  private async post(body: unknown): Promise<boolean> {
    if (!this.store.webhook) return false;
    return postWebhook(this.store.webhook, body);
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.store.wallets.length) return;
    this.polling = true;
    const now = Date.now();
    try {
      for (const w of this.store.wallets) {
        if (!w.alerts) continue;
        try {
          const fills = await info<RawFill[]>({
            type: "userFillsByTime",
            user: w.addr,
            startTime: w.lastFillAt + 1,
            endTime: now,
            aggregateByTime: false,
          });
          const fresh = fills.filter((f) => Number(f.time) > w.lastFillAt);
          if (!fresh.length) continue;
          w.lastFillAt = Math.max(...fresh.map((f) => Number(f.time)));
          w.trades24h = fresh.length;
          this.save();

          const byCoin = new Map<string, RawFill[]>();
          for (const f of fresh) {
            const list = byCoin.get(f.coin) ?? [];
            list.push(f);
            byCoin.set(f.coin, list);
          }

          const names = await spotNameMap();
          const icons = await iconMap();
          for (const [coin, list] of byCoin) {
            const key = `${w.addr.toLowerCase()}:${coin}`;
            if (now - (this.lastAlert.get(key) ?? 0) < WINDOW_MS) continue;
            this.lastAlert.set(key, now);
            const first = list[0]!;
            const size = list.reduce((a, f) => a + Number(f.sz), 0);
            const notional = list.reduce((a, f) => a + Number(f.sz) * Number(f.px), 0);
            const label = names.get(coin) ?? coin;
            const buy = isBuyFill(first.dir);
            const payload = alertPayload({
              venue: "hyperliquid",
              coin: label,
              side: buy ? "buy" : "sell",
              size,
              notional,
              price: Number(first.px),
              wallet: w.addr,
              fills: list.length,
              chartUrl: `https://app.hyperliquid.xyz/trade/${encodeURIComponent(coin)}`,
              explorerUrl: `https://app.hyperliquid.xyz/explorer/address/${w.addr}`,
              iconUrl: iconFor(label.split("/")[0] ?? label, icons),
              windowMinutes: WINDOW_MS / 60_000,
            });
            if (await this.post(payload)) this.alertsSent++;
          }
        } catch {
          /* one wallet failing must not stop the others */
        }
      }
      this.polledAt = Date.now();
    } finally {
      this.polling = false;
    }
  }
}
