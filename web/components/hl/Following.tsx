import { useEffect, useState } from "react";
import type { FollowingView } from "@shared/hl";

const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}b` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}m` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : a.toFixed(0);
  return `${n < 0 ? "-" : ""}$${s}`;
};
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;
const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ago = (ms: number) => {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};
const signed = (n: number) => `${n > 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const px = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });

export function Following({ onPick }: { onPick: (addr: string) => void }) {
  const [view, setView] = useState<FollowingView | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/following");
      const body = (await res.json()) as { ok: boolean } & FollowingView;
      if (body.ok) setView(body);
    } catch {
      /* keep the last view */
    }
  };

  useEffect(() => {
    void load();
    const t = window.setInterval(load, 30_000);
    return () => window.clearInterval(t);
  }, []);

  const saveHook = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/following/webhook", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json()) as { ok: boolean; following: FollowingView };
      if (body.ok) {
        setView(body.following);
        setMsg(body.following.webhook ? "webhook saved" : "that does not look like a Discord webhook url");
        void load();
      }
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/following/test", { method: "POST" });
      const body = (await res.json()) as { ok: boolean };
      setMsg(body.ok ? "test message sent to Discord" : "test failed, check the webhook url");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (addr: string, enabled: boolean) => {
    await fetch(`/api/following/${addr}/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    void load();
  };

  const remove = async (addr: string) => {
    await fetch(`/api/following/${addr}`, { method: "DELETE" });
    void load();
  };

  const wallets = view?.wallets ?? [];

  return (
    <>
      <section className="hl-panel">
        <div className="hl-panel__head">
          <h2 className="lab">TRADE ALERTS</h2>
          <span className="hl-grow" />
          <span className="hl-lab">
            {wallets.length} followed · one alert per token every {view?.windowMinutes ?? 15} min
          </span>
        </div>

        <div className="hl-hook">
          <input
            className="hl-input"
            placeholder="https://discord.com/api/webhooks/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="discord webhook"
          />
          <button type="button" className="chip is-on" onClick={saveHook} disabled={busy}>
            save webhook
          </button>
          <button type="button" className="chip" onClick={test} disabled={busy || !view?.webhook}>
            send test
          </button>
          <span className="hl-note">
            {view?.webhook ? `saved: ${view.webhook}` : "no webhook yet"} · {view?.alertsSent ?? 0} alerts sent
          </span>
        </div>
        {msg ? <p className="hl-note">{msg}</p> : null}
      </section>

      <section className="hl-panel hl-nearpanel">
        <div className="hl-panel__head">
          <h2 className="lab">FAVOURITES</h2>
          <span className="hl-grow" />
          <span className="hl-lab">{view?.polledAt ? `checked ${when(view.polledAt)}` : "waiting for first check"}</span>
        </div>

        {wallets.length === 0 ? (
          <p className="hl-empty">open a wallet from the leaderboard and star it. alerts go to the webhook above.</p>
        ) : (
          <div className="hl-cards">
            {wallets.map((w) => {
              const s = w.stats;
              return (
                <article key={w.addr} className="hl-card" onClick={() => onPick(w.addr)} title="open this wallet">
                  <header className="hl-card__head">
                    <span className="hl-star" aria-label="following">★</span>
                    <code className="hl-code">{w.addr.slice(0, 6)}…{w.addr.slice(-4)}</code>
                    <span className="hl-grow" />
                    <button
                      type="button"
                      className={`chip ${w.alerts ? "is-on" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggle(w.addr, !w.alerts);
                      }}
                    >
                      alerts {w.alerts ? "on" : "off"}
                    </button>
                  </header>

                  <div className="hl-card__equity">
                    {s ? money(s.equity) : "-"}
                    {s ? (
                      <span className={`hl-card__roi ${s.roi30 >= 0 ? "is-up" : "is-down"}`}>{pct(s.roi30)}</span>
                    ) : null}
                  </div>

                  {s ? (
                    <div className="hl-card__stats">
                      <span><i>30D P&L</i><b className={s.pnl30 >= 0 ? "is-up" : "is-down"}>{money(s.pnl30)}</b></span>
                      <span><i>GREEN</i><b>{s.greenDays.toFixed(0)}%</b></span>
                      <span><i>WORST</i><b className="is-down">{money(s.worstDay)}</b></span>
                      <span><i>BEST/TOT</i><b className={s.concentration >= 0.7 ? "is-down" : ""}>{pct(s.concentration, 0)}</b></span>
                      <span><i>48H</i><b>{s.trades48h}</b></span>
                    </div>
                  ) : (
                    <p className="hl-note">stats unavailable right now</p>
                  )}

                  <footer className="hl-card__foot">
                    {s?.last ? (
                      <span
                        className="hl-last"
                        title={`${s.last.side} ${s.last.coin} · ${when(s.last.at)}${
                          s.last.entryPx ? ` · entry ${px(s.last.entryPx)}` : " · position closed"
                        }${s.last.markPx ? ` · mark ${px(s.last.markPx)}` : ""}`}
                      >
                        <b className={s.last.side === "LONG" ? "is-up" : "is-down"}>{s.last.side}</b>
                        <span className="hl-last__coin">{s.last.coin}</span>
                        <span
                          className={`hl-last__pct ${
                            s.last.pct === null ? "hl-last__pct--flat" : s.last.pct >= 0 ? "is-up" : "is-down"
                          }`}
                        >
                          {s.last.pct === null ? "closed" : signed(s.last.pct)}
                        </span>
                        <span className="hl-last__when">{ago(s.last.at)}</span>
                      </span>
                    ) : (
                      <span className="hl-when">no fills on record</span>
                    )}
                    <span className="hl-grow" />
                    <button
                      type="button"
                      className="chip"
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(w.addr);
                      }}
                    >
                      remove
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        )}

        <p className="hl-note">
          Same numbers as the leaderboard, refreshed every 5 minutes. Click a card to open the wallet. Alerts fire on new
          fills only; the first fill for a token opens a {view?.windowMinutes ?? 15}-minute window and later fills on that
          token fold into the same message.
        </p>
      </section>
    </>
  );
}
