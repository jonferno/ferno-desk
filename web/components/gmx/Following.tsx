import { useEffect, useState } from "react";
import type { GmxFollowCard } from "@shared/gmx";

const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}b` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}m` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : a.toFixed(0);
  return `${n < 0 ? "-" : ""}$${s}`;
};
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const short = (a: string) => `${a.slice(0, 6)}.${a.slice(-4)}`;
const ago = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};
const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function GmxFollowingView({
  onPick,
  onRemove,
}: {
  onPick: (addr: string) => void;
  onRemove: (addr: string) => void;
}) {
  const [cards, setCards] = useState<GmxFollowCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hook, setHook] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [windowMinutes, setWindowMinutes] = useState(15);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/gmx/following");
      const body = (await res.json()) as {
        ok: boolean;
        wallets?: GmxFollowCard[];
        webhook?: string | null;
        windowMinutes?: number;
        error?: string;
      };
      if (!body.ok) throw new Error(body.error ?? "favourites unavailable");
      setCards(body.wallets ?? []);
      setSaved(body.webhook ?? null);
      if (body.windowMinutes) setWindowMinutes(body.windowMinutes);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const saveHook = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/gmx/following/webhook", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: hook.trim() }),
      });
      const body = (await res.json()) as { ok: boolean; following?: { webhook?: string | null } };
      if (!body.ok) throw new Error("webhook rejected");
      setSaved(body.following?.webhook ?? null);
      setHook("");
      setMsg(body.following?.webhook ? "saved" : "cleared, that did not look like a discord webhook");
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/gmx/following/test", { method: "POST" });
      const body = (await res.json()) as { ok: boolean };
      setMsg(body.ok ? "test sent, check the channel" : "test failed, check the webhook");
    } catch {
      setMsg("test failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleAlerts = async (addr: string, enabled: boolean) => {
    setCards((prev) => (prev ? prev.map((c) => (c.addr === addr ? { ...c, alerts: enabled } : c)) : prev));
    try {
      await fetch(`/api/gmx/following/${addr}/alerts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    } catch {
      setCards((prev) => (prev ? prev.map((c) => (c.addr === addr ? { ...c, alerts: !enabled } : c)) : prev));
    }
  };

  return (
    <>
      <section className="hl-panel">
        <div className="hl-panel__head">
          <h2 className="lab">TRADE ALERTS</h2>
          <span className="hl-grow" />
          <span className="hl-lab">
            {cards?.length ?? 0} favourites · one alert per wallet every {windowMinutes} min
          </span>
        </div>
        <div className="hl-hook">
          <input
            className="hl-input"
            placeholder="https://discord.com/api/webhooks/…"
            value={hook}
            onChange={(e) => setHook(e.target.value)}
            aria-label="discord webhook url"
          />
          <button type="button" className="chip is-on" onClick={saveHook} disabled={busy}>
            save webhook
          </button>
          <button type="button" className="chip" onClick={test} disabled={busy || !saved}>
            send test
          </button>
          <span className="hl-note">{msg ?? (saved ? `saved: ${saved}` : "no webhook saved yet")}</span>
        </div>
      </section>

      <section className="hl-panel hl-nearpanel">
        <div className="hl-panel__head">
          <h2 className="lab">FAVOURITES</h2>
          <span className="hl-grow" />
          <span className="hl-lab">{cards ? `${cards.length} wallets` : "loading"}</span>
        </div>

        {error ? <div className="hl-error">{error}</div> : null}

        {cards && cards.length === 0 ? (
          <p className="hl-empty">no favourites yet. star a wallet on the board and it lands here.</p>
        ) : null}

        <div className="hl-cards">
          {(cards ?? []).map((w) => {
            const r = w.row;
            const l = w.last;
            return (
              <article key={w.addr} className="hl-card" onClick={() => onPick(w.addr)} title="open this wallet">
                <header className="hl-card__head">
                  <span className="hl-star" aria-label="favourite">
                    ★
                  </span>
                  <code className="hl-code">{short(w.addr)}</code>
                  <span className="hl-grow" />
                  <button
                    type="button"
                    className={`chip ${w.alerts !== false ? "is-on" : ""}`}
                    title="turn this wallet's discord alerts on or off"
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleAlerts(w.addr, w.alerts === false);
                    }}
                  >
                    alerts {w.alerts !== false ? "on" : "off"}
                  </button>
                  <button
                    type="button"
                    className="chip"
                    title="remove from favourites"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(w.addr);
                    }}
                  >
                    remove
                  </button>
                </header>

                <div className="hl-card__equity">
                  {r ? money(r.pnl) : "-"}
                  {r ? <span className={`hl-card__roi ${r.roi >= 0 ? "is-up" : "is-down"}`}>{pct(r.roi)}</span> : null}
                </div>

                {r ? (
                  <div className="hl-card__stats">
                    <span>
                      <i>VOLUME</i>
                      <b>{money(r.volume)}</b>
                    </span>
                    <span>
                      <i>WIN/LOSS</i>
                      <b>
                        {r.wins.toFixed(0)}/{r.losses.toFixed(0)}
                      </b>
                    </span>
                    <span>
                      <i>AVG LEV</i>
                      <b>{r.avgLev.toFixed(1)}x</b>
                    </span>
                    <span>
                      <i>TRADES</i>
                      <b>{r.trades.toFixed(0)}</b>
                    </span>
                  </div>
                ) : (
                  <p className="hl-note">no 30d row for this wallet right now</p>
                )}

                <footer className="hl-card__foot">
                  {l ? (
                    <span
                      className="hl-last"
                      title={`${l.kind} ${l.side} ${l.market} · ${when(l.at)}${
                        l.pnlPct != null ? ` · ${(l.pnlPct * 100).toFixed(1)}% on the fill` : ""
                      }`}
                    >
                      <span className="hl-last__kind">{l.kind.toUpperCase()}</span> {l.side} {l.market}
                      {l.pnlPct != null ? (
                        <b className={l.pnlPct >= 0 ? "is-up" : "is-down"}>
                          {" "}
                          {l.pnlPct >= 0 ? "+" : ""}
                          {(l.pnlPct * 100).toFixed(1)}%
                        </b>
                      ) : null}{" "}
                      <span className="hl-note">· {ago(l.at)}</span>
                    </span>
                  ) : (
                    <span className="hl-note">no fills in the last 48h</span>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}
