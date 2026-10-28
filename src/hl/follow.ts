import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FollowedWallet, FollowingView } from "@shared/hl";
import { info } from "./client";
import { spotNameMap } from "./desk";

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
    return this.post("HL DESK test message. Alerts are wired up.");
  }

  isFollowing(addr: string): boolean {
    return this.store.wallets.some((w) => w.addr.toLowerCase() === addr.toLowerCase());
  }

  private async post(content: string): Promise<boolean> {
    if (!this.store.webhook) return false;
    try {
      const res = await fetch(this.store.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, username: "HL DESK" }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
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
          for (const [coin, list] of byCoin) {
            const key = `${w.addr.toLowerCase()}:${coin}`;
            if (now - (this.lastAlert.get(key) ?? 0) < WINDOW_MS) continue;
            this.lastAlert.set(key, now);
            const first = list[0]!;
            const notional = list.reduce((a, f) => a + Number(f.sz) * Number(f.px), 0);
            const dir = first.dir;
            const label = names.get(coin) ?? coin;
            const lines = [
              `**${w.addr.slice(0, 6)}…${w.addr.slice(-4)}** · ${label} · ${dir}`,
              `${list.length} fill${list.length === 1 ? "" : "s"} · ${notional.toFixed(0)} USDC notional`,
              `price ${Number(first.px)} · ${new Date(now).toLocaleTimeString()}`,
            ];
            if (await this.post(lines.join("\n"))) this.alertsSent++;
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
