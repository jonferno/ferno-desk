import { useEffect, useMemo, useRef, useState } from "react";
import type { WalletDetail } from "@shared/hl";

const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}m` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(2);
  return `${n < 0 ? "-" : ""}$${s}`;
};
const px = (n: number) =>
  n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(3) : n.toFixed(5);

const clock = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

interface LCChart {
  addCandlestickSeries: (o: Record<string, unknown>) => { setData: (d: unknown[]) => void; setMarkers: (m: unknown[]) => void };
  applyOptions: (o: Record<string, unknown>) => void;
  timeScale: () => { fitContent: () => void };
  remove: () => void;
}
type LCModule = { createChart: (el: HTMLElement, o: Record<string, unknown>) => LCChart };

function CandleChart({ chart }: { chart: WalletDetail["chart"] }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const LC = (window as unknown as { LightweightCharts?: LCModule }).LightweightCharts;
    const el = host.current;
    if (!LC || !el || !chart.candles.length) return;
    const c = LC.createChart(el, {
      height: 320,
      layout: { background: { color: "transparent" }, textColor: "rgba(255,255,255,0.45)", fontSize: 11 },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    const s = c.addCandlestickSeries({
      upColor: "#4aa8ff",
      downColor: "#ff8c42",
      wickUpColor: "#4aa8ff",
      wickDownColor: "#ff8c42",
      borderVisible: false,
    });
    s.setData(chart.candles);
    if (chart.markers.length) {
      const times = new Set(chart.candles.map((k) => k.time));
      s.setMarkers(chart.markers.filter((m) => times.has(m.time)));
    }
    c.timeScale().fitContent();
    const ro = new ResizeObserver(() => c.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      c.remove();
    };
  }, [chart]);

  if (!chart.candles.length) return <p className="hl-empty">no candle history for this market</p>;
  return (
    <>
      <div className="hl-chart__head">
        <span className="lab">{chart.coin} · 1m · 24h</span>
        <span className="hl-grow" />
        <span className="hl-note">{chart.markers.length} fills marked</span>
      </div>
      <div ref={host} className="hl-candles" />
    </>
  );
}

function Curve({ points }: { points: Array<{ t: number; v: number }> }) {
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const vs = points.map((p) => p.v);
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const span = max - min || 1;
    const w = 1000;
    const h = 150;
    const step = w / (points.length - 1);
    const d = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - ((p.v - min) / span) * h).toFixed(1)}`)
      .join(" ");
    return { d, up: vs[vs.length - 1]! >= vs[0]! };
  }, [points]);
  if (!path) return <p className="hl-empty">no equity history returned for this wallet</p>;
  return (
    <svg className="hl-curve" viewBox="0 0 1000 150" preserveAspectRatio="none" role="img" aria-label="equity curve">
      <path d={path.d} className={path.up ? "is-up" : "is-down"} />
    </svg>
  );
}

export function WalletView({ addr }: { addr: string | null }) {
  const [data, setData] = useState<WalletDetail | null>(null);
  const [fills, setFills] = useState<WalletDetail["fills"]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [paging, setPaging] = useState(false);
  const PAGE = 25;
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!addr) return;
    let alive = true;
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/wallet/${addr}`);
        const body = (await res.json()) as { ok: boolean; wallet?: WalletDetail; error?: string; following?: boolean };
        if (!alive) return;
        if (!body.ok || !body.wallet) throw new Error(body.error ?? "wallet unavailable");
        setData(body.wallet);
        setFills(body.wallet.fills);
        setTotal(body.wallet.fillsTotal);
        setPage(0);
        setFollowing(Boolean(body.following));
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [addr]);

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
          {following ? "following" : "follow"}
        </button>
      </div>

      {error ? <div className="hl-error">{error}</div> : null}

      {data ? (
        <>
          <div className="hl-stats hl-stats--four">
            <div className="hl-stat"><span className="hl-lab">equity</span><b className="num">{money(data.equity)}</b></div>
            <div className="hl-stat"><span className="hl-lab">30d p&l</span><b className={`num ${data.pnl30 >= 0 ? "is-up" : "is-down"}`}>{money(data.pnl30)}</b></div>
            <div className="hl-stat"><span className="hl-lab">green days</span><b className="num">{data.greenDays.toFixed(0)}%</b></div>
            <div className="hl-stat"><span className="hl-lab">worst day</span><b className="num is-down">{money(data.worstDay)}</b></div>
          </div>

          <div className="hl-pos">
            <div className="hl-chart__head">
              <span className="lab">positions from the last 48h</span>
              <span className="hl-grow" />
              <span className="hl-note">
                {data.positions.length} perp · {data.spot.length} spot · built from fills only
              </span>
            </div>

            {data.positions.length === 0 && data.spot.length === 0 ? (
              <p className="hl-empty">no positions opened in the last 48 hours</p>
            ) : (
              <div className="hl-two">
                <div>
                  {data.positions.length === 0 ? (
                    <p className="hl-empty">no perp positions opened in this window</p>
                  ) : (
                    <table className="hl-table">
                      <thead>
                        <tr>
                          <th>COIN</th>
                          <th>SIDE</th>
                          <th>SIZE</th>
                          <th>AVG ENTRY</th>
                          <th>MARK</th>
                          <th>UNREAL</th>
                          <th>FILLS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.positions.map((p) => (
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
                            <td className="num">{Math.abs(p.size).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                            <td className="num">{px(p.entryPx)}</td>
                            <td className="num">{px(p.markPx)}</td>
                            <td className={`num ${p.unrealizedPnl >= 0 ? "is-up" : "is-down"}`}>{money(p.unrealizedPnl)}</td>
                            <td className="num">{p.fills}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div>
                  {data.spot.length === 0 ? (
                    <p className="hl-empty">no spot balances</p>
                  ) : (
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

          <div className="hl-chart">
            <CandleChart chart={data.chart} />
          </div>

          <div className="hl-chart">
            <div className="hl-chart__head">
              <span className="lab">equity timeline</span>
              <span className="hl-grow" />
              <span className="hl-note">full history</span>
            </div>
            <Curve points={data.curve} />
          </div>

          <h3 className="lab">recent trades (48h)</h3>
          <div className="hl-scroll hl-scroll--short">
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
