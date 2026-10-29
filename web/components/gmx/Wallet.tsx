import { useEffect, useRef, useState } from "react";
import type { GmxWallet } from "@shared/gmx";

const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}m` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(0);
  return `${n < 0 ? "-" : ""}$${s}`;
};
const px = (n: number) =>
  n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(3) : n.toFixed(5);
const clock = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

interface LCChart {
  addAreaSeries: (o: Record<string, unknown>) => { setData: (d: unknown[]) => void };
  applyOptions: (o: Record<string, unknown>) => void;
  timeScale: () => { fitContent: () => void };
  remove: () => void;
}
type LCModule = { createChart: (el: HTMLElement, o: Record<string, unknown>) => LCChart };

/**
 * Cumulative realised PnL, not account equity: GMX does not publish account
 * value over time, so this is the honest history it does have.
 */
function PnlChart({ points }: { points: Array<{ t: number; v: number }> }) {
  const host = useRef<HTMLDivElement>(null);

  const series = points
    .filter((p) => Number.isFinite(p.v) && p.t > 0)
    .sort((a, b) => a.t - b.t)
    .map((p) => ({ time: Math.floor(p.t / 1000), value: p.v }));

  const last = series[series.length - 1]?.value ?? 0;
  const up = last >= 0;

  useEffect(() => {
    const LC = (window as unknown as { LightweightCharts?: LCModule }).LightweightCharts;
    const el = host.current;
    if (!LC || !el || series.length < 2) return;
    const c = LC.createChart(el, {
      height: 280,
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

  if (series.length < 2) return <p className="hl-empty">no daily pnl history for this wallet yet</p>;

  return (
    <>
      <div className="hl-chart__head">
        <span className="lab">realised pnl · 30d</span>
        <span className="hl-grow" />
        <span className={`hl-note num ${last >= 0 ? "is-up" : "is-down"}`}>
          {money(last)} cumulative
        </span>
      </div>
      <div ref={host} className="hl-equity" />
    </>
  );
}

export function GmxWalletView({
  addr,
  following,
  onToggleFollow,
}: {
  addr: string | null;
  following: boolean;
  onToggleFollow: () => void;
}) {
  const [data, setData] = useState<GmxWallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!addr) return;
    let alive = true;
    setError(null);
    setStale(false);
    setData(null);
    void (async () => {
      try {
        const res = await fetch(`/api/gmx/wallet/${addr}`);
        const body = (await res.json()) as { ok: boolean; wallet?: GmxWallet; error?: string; stale?: boolean };
        if (!alive) return;
        if (!body.ok || !body.wallet) throw new Error(body.error ?? "wallet unavailable");
        setData(body.wallet);
        setStale(Boolean(body.stale));
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [addr, nonce]);

  if (!addr) {
    return (
      <section className="hl-panel">
        <p className="hl-empty">pick a wallet from the gmx board to inspect it.</p>
      </section>
    );
  }

  const row = data?.row ?? null;
  const winRate = row && row.wins + row.losses > 0 ? row.wins / (row.wins + row.losses) : null;

  return (
    <section className="hl-panel">
      <div className="hl-panel__head">
        <h2 className="lab">GMX WALLET</h2>
        <code className="hl-code">{addr}</code>
        <a
          className="hl-ext"
          href={`https://arbiscan.io/address/${addr}`}
          target="_blank"
          rel="noreferrer noopener"
          title="open this address on arbiscan"
        >
          arbiscan ↗
        </a>
        <span className="hl-grow" />
        <button type="button" className={`chip ${following ? "is-on" : ""}`} onClick={onToggleFollow}>
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

      {stale ? <p className="hl-stale">showing the last good copy · gmx api is having a moment</p> : null}

      {data ? (
        <>
          <div className="hl-stats hl-stats--four">
            <div className="hl-stat">
              <span className="hl-lab">30d realised pnl</span>
              <b className={`num ${row && row.pnl < 0 ? "is-down" : "is-up"}`}>{row ? money(row.pnl) : "-"}</b>
            </div>
            <div className="hl-stat">
              <span className="hl-lab">30d roi</span>
              <b className={`num ${row && row.roi < 0 ? "is-down" : "is-up"}`}>{row ? `${(row.roi * 100).toFixed(1)}%` : "-"}</b>
            </div>
            <div className="hl-stat">
              <span className="hl-lab">open pnl</span>
              <b className={`num ${data.unrealized < 0 ? "is-down" : "is-up"}`}>{money(data.unrealized)}</b>
            </div>
            <div className="hl-stat">
              <span className="hl-lab">collateral locked</span>
              <b className="num">{money(data.collateral)}</b>
            </div>
          </div>

          <p className="hl-note num" style={{ marginBottom: 12 }}>
            {row
              ? `${money(row.volume)} volume · ${row.wins.toFixed(0)}/${row.losses.toFixed(0)} closed · ${winRate != null ? `${(winRate * 100).toFixed(0)}% win rate` : "no closed trades"} · ${row.avgLev.toFixed(1)}x avg lev · ${data.positions.length} open`
              : `no 30d board row for this wallet · ${data.positions.length} open positions`}
          </p>

          <div className="hl-equitywrap">
            <PnlChart points={data.curve} />
          </div>

          <div className="hl-pos">
            <div className="hl-chart__head">
              <span className="lab">open positions</span>
              <span className="hl-grow" />
              <span className="hl-note">entry, mark and liquidation straight from gmx</span>
            </div>
            {data.positions.length === 0 ? (
              <p className="hl-empty">no open positions</p>
            ) : (
              <div className="hl-scroll">
                <table className="hl-table">
                  <thead>
                    <tr>
                      <th>MARKET</th>
                      <th>SIDE</th>
                      <th>LEV</th>
                      <th>SIZE</th>
                      <th>COLLATERAL</th>
                      <th>ENTRY</th>
                      <th>MARK</th>
                      <th>LIQ</th>
                      <th>PNL %</th>
                      <th>PNL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.positions.map((p) => (
                      <tr key={p.key} title={`${p.pool} · ${money(p.sizeUsd)} notional`}>
                        <td className="hl-coin">
                          {p.market}
                          {data.positions.filter((x) => x.market === p.market).length > 1 && p.pool ? (
                            <span className="hl-note"> · {p.pool}</span>
                          ) : null}
                        </td>
                        <td className={p.isLong ? "is-up" : "is-down"}>{p.isLong ? "LONG" : "SHORT"}</td>
                        <td className="num">{p.leverage.toFixed(1)}x</td>
                        <td className="num">{money(p.sizeUsd)}</td>
                        <td className="num">{money(p.collateralUsd)}</td>
                        <td className="num">{px(p.entryPx)}</td>
                        <td className="num">{px(p.markPx)}</td>
                        <td className="num">{p.liqPx ? px(p.liqPx) : "-"}</td>
                        <td className={`num ${p.pnlPct >= 0 ? "is-up" : "is-down"}`}>
                          {p.pnlPct >= 0 ? "+" : ""}
                          {p.pnlPct.toFixed(1)}%
                        </td>
                        <td className={`num ${p.pnlUsd >= 0 ? "is-up" : "is-down"}`}>{money(p.pnlUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="hl-chart__head hl-trades__head">
            <h3 className="lab">recent trades (48h)</h3>
            <span className="hl-grow" />
            <span className="hl-note">newest first · {data.tradesTotal} fills</span>
          </div>
          <div className="hl-scroll hl-scroll--trades">
            <table className="hl-table">
              <thead>
                <tr>
                  <th>WHEN</th>
                  <th>MARKET</th>
                  <th>WHAT</th>
                  <th>SIDE</th>
                  <th>SIZE</th>
                  <th>PNL</th>
                </tr>
              </thead>
              <tbody>
                {data.trades.map((t, i) => (
                  <tr key={`${t.time}-${i}`}>
                    <td className="hl-when">{clock(t.time)}</td>
                    <td className="hl-coin">{t.market}</td>
                    <td>{t.kind}</td>
                    <td className={t.isLong ? "is-up" : "is-down"}>{t.isLong ? "LONG" : "SHORT"}</td>
                    <td className="num">{t.sizeUsd > 0 ? money(t.sizeUsd) : "—"}</td>
                    <td className={`num ${t.pnlUsd > 0 ? "is-up" : t.pnlUsd < 0 ? "is-down" : ""}`}>
                      {Math.abs(t.pnlUsd) >= 1 ? money(t.pnlUsd) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.trades.length === 0 ? <p className="hl-empty">no executed trades in the last 48 hours</p> : null}
          </div>
        </>
      ) : (
        !error && <p className="hl-empty">loading gmx wallet…</p>
      )}
    </section>
  );
}
