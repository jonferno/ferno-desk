import { useEffect, useMemo, useRef, useState } from "react";
import type { PerpPosition, WalletDetail } from "@shared/hl";

const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}m` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(2);
  return `${n < 0 ? "-" : ""}$${s}`;
};
const px = (n: number) =>
  n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(3) : n.toFixed(5);

/** Unlevered price move from the window's average entry, signed for the side. */
const movePct = (p: PerpPosition) =>
  p.entryPx > 0 ? ((p.markPx - p.entryPx) / p.entryPx) * (p.size > 0 ? 100 : -100) : null;

const clock = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

interface LCChart {
  addAreaSeries: (o: Record<string, unknown>) => { setData: (d: unknown[]) => void };
  applyOptions: (o: Record<string, unknown>) => void;
  timeScale: () => { fitContent: () => void };
  remove: () => void;
}
type LCModule = { createChart: (el: HTMLElement, o: Record<string, unknown>) => LCChart };

const RANGES = [
  { id: "24h", label: "24H", ms: 24 * 3_600_000 },
  { id: "7d", label: "7D", ms: 7 * 86_400_000 },
  { id: "30d", label: "30D", ms: 30 * 86_400_000 },
  { id: "all", label: "ALL", ms: 0 },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

function EquityChart({ points }: { points: WalletDetail["curve"] }) {
  const host = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<RangeId>("all");

  // The chart wants strictly ascending integer seconds, so dedupe on the
  // second after trimming to the selected window.
  const series = useMemo(() => {
    const clean = points
      .filter((p) => Number.isFinite(p.v) && p.v > 0 && p.t > 0)
      .sort((a, b) => a.t - b.t);
    const span = RANGES.find((r) => r.id === range)?.ms ?? 0;
    const from = span ? Date.now() - span : 0;
    const seen = new Set<number>();
    const out: Array<{ time: number; value: number }> = [];
    for (const p of clean) {
      if (p.t < from) continue;
      const time = Math.floor(p.t / 1000);
      if (seen.has(time)) continue;
      seen.add(time);
      out.push({ time, value: p.v });
    }
    return out;
  }, [points, range]);

  const first = series[0];
  const last = series[series.length - 1];
  const up = Boolean(first && last && last.value >= first.value);
  const delta = first && last ? last.value - first.value : 0;
  const pct = first && first.value ? (delta / first.value) * 100 : 0;
  // A wallet funded with a few dollars and grown into millions reads as
  // +63,000%, which tells nobody anything. Past 999% show the multiple.
  const multiple = first && first.value ? (last?.value ?? first.value) / first.value : 0;
  const change = Math.abs(pct) >= 999 ? `${multiple.toFixed(multiple >= 10 ? 0 : 1)}×` : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;

  useEffect(() => {
    const LC = (window as unknown as { LightweightCharts?: LCModule }).LightweightCharts;
    const el = host.current;
    if (!LC || !el || series.length < 2) return;
    const c = LC.createChart(el, {
      height: 340,
      layout: { background: { color: "transparent" }, textColor: "rgba(255,255,255,0.45)", fontSize: 11 },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)", scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      localization: { priceFormatter: (n: number) => money(n) },
    });
    const s = c.addAreaSeries({
      lineColor: up ? "#4aa8ff" : "#ff8c42",
      topColor: up ? "rgba(74,168,255,0.26)" : "rgba(255,140,66,0.26)",
      bottomColor: "rgba(0,0,0,0)",
      lineWidth: 2,
      priceLineVisible: false,
    });
    s.setData(series);
    c.timeScale().fitContent();
    const ro = new ResizeObserver(() => c.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      c.remove();
    };
  }, [series, up]);

  return (
    <>
      <div className="hl-chart__head">
        <span className="lab">equity timeline</span>
        <div className="hl-seg">
          {RANGES.map((r) => (
            <button key={r.id} type="button" className={`chip ${range === r.id ? "is-on" : ""}`} onClick={() => setRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
        <span className="hl-grow" />
        <span className={`hl-note num ${delta >= 0 ? "is-up" : "is-down"}`} title={`${money(first?.value ?? 0)} to ${money(last?.value ?? 0)}`}>
          {money(delta)} ({change})
        </span>
      </div>
      {series.length < 2 ? (
        <p className="hl-empty">no equity history for this wallet in this window</p>
      ) : (
        <div ref={host} className="hl-equity" />
      )}
    </>
  );
}

export function WalletView({ addr }: { addr: string | null }) {
  const [data, setData] = useState<WalletDetail | null>(null);
  const [fills, setFills] = useState<WalletDetail["fills"]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [paging, setPaging] = useState(false);
  const PAGE = 50;
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleAt, setStaleAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!addr) return;
    let alive = true;
    setError(null);
    setStaleAt(null);
    void (async () => {
      try {
        const res = await fetch(`/api/wallet/${addr}`);
        const body = (await res.json()) as {
          ok: boolean;
          wallet?: WalletDetail;
          error?: string;
          following?: boolean;
          stale?: boolean;
          staleAt?: number;
        };
        if (!alive) return;
        if (!body.ok || !body.wallet) throw new Error(body.error ?? "wallet unavailable");
        setData(body.wallet);
        setFills(body.wallet.fills);
        setTotal(body.wallet.fillsTotal);
        setPage(0);
        setFollowing(Boolean(body.following));
        setStaleAt(body.stale && body.staleAt ? body.staleAt : null);
      } catch (err) {
        if (!alive) return;
        const msg = (err as Error).message;
        setError(
          msg.includes("429")
            ? "Hyperliquid is throttling this address and there is no saved copy yet. Give it a minute."
            : msg,
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [addr, nonce]);

  const goPage = async (next: number) => {
    if (!addr || paging) return;
    setPaging(true);
    try {
      const res = await fetch(`/api/wallet/${addr}/fills?offset=${next * PAGE}&limit=${PAGE}`);
      const body = (await res.json()) as { ok: boolean; fills?: WalletDetail["fills"]; total?: number };
      if (body.ok && body.fills) {
        setFills(body.fills);
        setTotal(body.total ?? total);
        setPage(next);
      }
    } finally {
      setPaging(false);
    }
  };

  if (!addr) {
    return (
      <section className="hl-panel">
        <p className="hl-empty">pick a wallet from the leaderboard to inspect it.</p>
      </section>
    );
  }

  return (
    <section className="hl-panel">
      <div className="hl-panel__head">
        <h2 className="lab">WALLET</h2>
        <code className="hl-code">{addr}</code>
        {following ? (
          <span className="hl-star" title="you follow this wallet" aria-label="following">
            ★
          </span>
        ) : null}
        <a
          className="hl-ext"
          href={`https://app.hyperliquid.xyz/explorer/address/${addr}`}
          target="_blank"
          rel="noreferrer noopener"
          title="open this address on the Hyperliquid explorer"
        >
          explorer ↗
        </a>
        <span className="hl-grow" />
        <button
          type="button"
          className={`chip ${following ? "is-on" : ""}`}
          disabled={followBusy}
          onClick={async () => {
            setFollowBusy(true);
            try {
              if (following) await fetch(`/api/following/${addr}`, { method: "DELETE" });
              else await fetch("/api/following", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ addr }),
              });
              setFollowing(!following);
            } finally {
              setFollowBusy(false);
            }
          }}
        >
          {following ? "★ favourite" : "☆ favourite"}
        </button>
      </div>

      {error ? (
        <div className="hl-error">
          {error}
          <button type="button" className="chip" onClick={() => setNonce((n) => n + 1)}>
            retry
          </button>
        </div>
      ) : null}

      {staleAt ? (
        <p className="hl-stale">
          showing the last good copy from {clock(staleAt)} · Hyperliquid is throttling this address right now
        </p>
      ) : null}

      {data ? (
        <>
          <div className="hl-stats hl-stats--four">
            <div className="hl-stat"><span className="hl-lab">equity</span><b className="num">{money(data.equity)}</b></div>
            <div className="hl-stat"><span className="hl-lab">30d p&l</span><b className={`num ${data.pnl30 >= 0 ? "is-up" : "is-down"}`}>{money(data.pnl30)}</b></div>
            <div className="hl-stat"><span className="hl-lab">green days</span><b className="num">{data.greenDays.toFixed(0)}%</b></div>
            <div className="hl-stat"><span className="hl-lab">worst day</span><b className="num is-down">{money(data.worstDay)}</b></div>
          </div>

          <div className="hl-equitywrap">
            <EquityChart points={data.curve} />
          </div>

          <div className="hl-pos">
            <div className="hl-chart__head">
              <span className="lab">positions from the last 48h</span>
              <span className="hl-grow" />
              <span className="hl-note">
                {data.positions.length} perp · {data.spot.length} spot · from fills, leverage from the venue
              </span>
            </div>

            {data.positions.length === 0 && data.spot.length === 0 ? (
              <p className="hl-empty">no positions opened in the last 48 hours</p>
            ) : (
              <div className={data.spot.length ? "hl-two" : undefined}>
                <div>
                  {data.positions.length === 0 ? (
                    <p className="hl-empty">no perp positions opened in this window</p>
                  ) : (
                    <table className="hl-table">
                      <thead>
                        <tr>
                          <th>COIN</th>
                          <th>SIDE</th>
                          <th title="leverage the venue has set on this coin, not rebuildable from fills">LEV</th>
                          <th>SIZE</th>
                          <th>AVG ENTRY</th>
                          <th>MARK</th>
                          <th>UNREAL %</th>
                          <th>FILLS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.positions.map((p) => {
                          const move = movePct(p);
                          return (
                            <tr
                              key={p.coin}
                              title={
                                p.venueSize != null && Math.abs(p.venueSize - p.size) > 1e-6
                                  ? `venue total ${p.venueSize} (older trades included), ${p.size} opened in this window`
                                  : undefined
                              }
                            >
                              <td className="hl-coin">{p.name ?? p.coin}</td>
                              <td className={p.size > 0 ? "is-up" : "is-down"}>{p.size > 0 ? "LONG" : "SHORT"}</td>
                              <td className="num">{p.leverage ? `${p.leverage}x` : "-"}</td>
                              <td className="num">{Math.abs(p.size).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                              <td className="num">{px(p.entryPx)}</td>
                              <td className="num">{px(p.markPx)}</td>
                              <td
                                className={`num ${move == null ? "" : move >= 0 ? "is-up" : "is-down"}`}
                                title={
                                  move == null
                                    ? money(p.unrealizedPnl)
                                    : `${money(p.unrealizedPnl)} · price move ${move >= 0 ? "+" : ""}${move.toFixed(2)}%` +
                                      (p.leverage ? ` · ${(move * p.leverage).toFixed(1)}% on ${p.leverage}x margin` : "")
                                }
                              >
                                {move == null ? "-" : `${move >= 0 ? "+" : ""}${move.toFixed(1)}%`}
                              </td>
                              <td className="num">{p.fills}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                <div>
                  {data.spot.length === 0 ? null : (
                    <table className="hl-table">
                      <thead>
                        <tr>
                          <th>SPOT</th>
                          <th>AMOUNT</th>
                          <th>VALUE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.spot.map((b) => (
                          <tr key={b.coin}>
                            <td className="hl-coin">{b.name ?? b.coin}</td>
                            <td className="num">{b.total.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                            <td className="num">{money(b.value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="hl-chart__head hl-trades__head">
            <h3 className="lab">recent trades (48h)</h3>
            <span className="hl-grow" />
            <span className="hl-note">newest first · {total} fills</span>
          </div>
          <div className="hl-scroll hl-scroll--trades">
            <table className="hl-table">
              <thead><tr><th>WHEN</th><th>COIN</th><th>DIR</th><th>PX</th><th>NOTIONAL</th><th>CLOSED P&L</th></tr></thead>
              <tbody>
                {fills.map((f, i) => (
                  <tr key={`${f.time}-${i}`}>
                    <td className="hl-when">{clock(f.time)}</td>
                    <td>{f.name ?? f.coin}</td>
                    <td className={f.dir.includes("Long") ? "is-up" : "is-down"}>{f.dir}</td>
                    <td className="num">{f.px < 1 ? f.px.toFixed(4) : f.px.toFixed(2)}</td>
                    <td className="num">{money(f.notional)}</td>
                    <td className={`num ${f.closedPnl > 0 ? "is-up" : f.closedPnl < 0 ? "is-down" : ""}`}>
                      {f.closedPnl ? money(f.closedPnl) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {fills.length === 0 ? <p className="hl-empty">no fills in the last 48 hours</p> : null}
          </div>
          <div className="hl-pager">
            <button type="button" className="chip" disabled={page === 0 || paging} onClick={() => void goPage(page - 1)}>
              prev
            </button>
            <span className="num hl-pager__count">
              page {page + 1} of {Math.max(1, Math.ceil(total / PAGE))} · {total} fills in 48h
            </span>
            <button
              type="button"
              className="chip"
              disabled={paging || (page + 1) * PAGE >= total}
              onClick={() => void goPage(page + 1)}
            >
              next
            </button>
          </div>
        </>
      ) : (
        <p className="hl-empty">loading wallet…</p>
      )}
    </section>
  );
}
