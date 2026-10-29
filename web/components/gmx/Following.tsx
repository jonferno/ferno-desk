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

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/gmx/following");
        const body = (await res.json()) as { ok: boolean; wallets?: GmxFollowCard[]; error?: string };
        if (!alive) return;
        if (!body.ok) throw new Error(body.error ?? "favourites unavailable");
        setCards(body.wallets ?? []);
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section className="hl-panel">
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
                    {l.side} {l.market}
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
  );
}
