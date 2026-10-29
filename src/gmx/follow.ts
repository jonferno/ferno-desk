import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alertPayload, iconFor, iconMap, maskWebhook, postWebhook, testPayload } from "../alerts";
import { marketMap, tradesSince, usd, type RawTrade } from "./client";

/**
 * Starred GMX wallets, and their Discord alerts.
 *
 * Alerting polls each favourite's executed fills once a minute and folds a
 * burst into one message per wallet per market per 15 minutes. The last seen
 * timestamp per wallet is persisted so a restart does not replay the day.
 */

const WINDOW_MS = 15 * 60_000;
const POLL_MS = 60_000;

interface Store {
  webhook: string | null;
  wallets: string[];
  lastSeen: Record<string, number>;
}

export class GmxFollowing {
  private path: string;
  private store: Store;
  private lastAlert = new Map<string, number>();
  private alertsSent = 0;
  private polledAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(dataDir: string) {
    this.path = join(dataDir, "gmx-following.json");
    this.store = this.load();
  }

  private load(): Store {
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Store>;
        const wallets: string[] = [];
        for (const a of Array.isArray(raw.wallets) ? raw.wallets : []) {
          if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) continue;
          if (!wallets.some((x) => x.toLowerCase() === a.toLowerCase())) wallets.push(a);
        }
        return {
          webhook: typeof raw.webhook === "string" ? raw.webhook : null,
          wallets: wallets.slice(0, 50),
          lastSeen: raw.lastSeen && typeof raw.lastSeen === "object" ? raw.lastSeen : {},
        };
      }
    } catch {
      /* a corrupt file must not stop the desk */
    }
    return { webhook: null, wallets: [], lastSeen: {} };
  }

  private save(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.store, null, 1));
    } catch {
      /* ignore */
    }
  }

  list(): string[] {
    return [...this.store.wallets];
  }

  has(addr: string): boolean {
    return this.store.wallets.some((x) => x.toLowerCase() === addr.toLowerCase());
  }

  add(addr: string): string[] {
    if (/^0x[0-9a-fA-F]{40}$/.test(addr) && !this.has(addr)) {
      this.store.wallets = [...this.store.wallets, addr].slice(0, 50);
      // Start watching from now, not from before the wallet was starred.
      this.store.lastSeen[addr.toLowerCase()] = Math.floor(Date.now() / 1000);
      this.save();
    }
    return this.list();
  }

  remove(addr: string): string[] {
    const next = this.store.wallets.filter((x) => x.toLowerCase() !== addr.toLowerCase());
    if (next.length !== this.store.wallets.length) {
      this.store.wallets = next;
      delete this.store.lastSeen[addr.toLowerCase()];
      this.save();
    }
    return this.list();
  }

  setWebhook(url: string | null): void {
    this.store.webhook = url && /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(url) ? url : null;
    this.save();
  }

  view() {
    return {
      webhook: this.store.webhook ? maskWebhook(this.store.webhook) : null,
      wallets: this.list(),
      windowMinutes: WINDOW_MS / 60_000,
      alertsSent: this.alertsSent,
      polledAt: this.polledAt,
    };
  }

  async testWebhook(): Promise<boolean> {
    if (!this.store.webhook) return false;
    return postWebhook(this.store.webhook, testPayload("gmx"));
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

  private async post(body: unknown): Promise<boolean> {
    if (!this.store.webhook) return false;
    const ok = await postWebhook(this.store.webhook, body);
    if (ok) this.alertsSent++;
    return ok;
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.store.wallets.length) return;
    // Without a webhook there is nothing to send, so only keep the last-seen
    // marks moving; every fifth minute is enough for that.
    if (!this.store.webhook && Date.now() - this.polledAt < 5 * 60_000) return;
    this.polling = true;
    const now = Date.now();
    try {
      const markets = await marketMap();
      const icons = await iconMap();
      const names = new Map<string, string>();
      for (const [addr, info] of markets) names.set(addr.toLowerCase(), info.symbol);

      for (const addr of this.store.wallets) {
        const key = addr.toLowerCase();
        const since = this.store.lastSeen[key] ?? Math.floor(now / 1000) - 120;
        try {
          const fills = await tradesSince(addr, since);
          if (!fills.length) continue;
          const newest = Math.max(...fills.map((f) => f.timestamp ?? 0));
          if (newest > since) {
            this.store.lastSeen[key] = newest;
            this.save();
          }
          const fresh = fills.filter((f) => (f.timestamp ?? 0) > since);

          const byMarket = new Map<string, RawTrade[]>();
          for (const f of fresh) {
            const id = (f.marketAddress ?? "").toLowerCase();
            if (!id) continue;
            const list = byMarket.get(id) ?? [];
            list.push(f);
            byMarket.set(id, list);
          }

          for (const [marketId, list] of byMarket) {
            const alertKey = `${key}:${marketId}`;
            if (now - (this.lastAlert.get(alertKey) ?? 0) < WINDOW_MS) continue;
            this.lastAlert.set(alertKey, now);

            const first = list[0]!;
            const notional = list.reduce((sum, f) => sum + usd(f.sizeDeltaUsd), 0);
            const meta = markets.get(marketId);
            const coin = names.get(marketId) ?? meta?.symbol ?? "GMX";
            const side = first.isLong ? "buy" : "sell";
            await this.post(
              alertPayload({
                venue: "gmx",
                coin,
                side,
                size: 0,
                notional,
                price: 0,
                wallet: addr,
                fills: list.length,
                chartUrl: `https://app.gmx.io/#/trade/?market=${first.marketAddress ?? ""}`,
                explorerUrl: `https://arbiscan.io/address/${addr}`,
                iconUrl: iconFor(coin, icons),
                windowMinutes: WINDOW_MS / 60_000,
              }),
            );
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
