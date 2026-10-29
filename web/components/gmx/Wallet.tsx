import { useEffect, useState } from "react";
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

export function GmxWalletView({ addr }: { addr: string | null }) {
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
        <span className="hl-note">arbitrum</span>
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
              <b className={`num ${data.row && data.row.pnl < 0 ? "is-down" : "is-up"}`}>
                {data.row ? money(data.row.pnl) : "-"}
              </b>
            </div>
            <div className="hl-stat">
              <span className="hl-lab">30d roi</span>
              <b className={`num ${data.row && data.row.roi < 0 ? "is-down" : "is-up"}`}>
                {data.row ? `${data.row.roi >= 0 ? "+" : ""}${(data.row.roi * 100).toFixed(1)}%` : "-"}
              </b>
            </div>
            <div className="hl-stat">
              <span className="hl-lab">30d volume</span>
              <b className="num">{data.row ? money(data.row.volume) : "-"}</b>
            </div>
            <div className="hl-stat">
              <span className="hl-lab">open positions</span>
              <b className="num">{data.positions.length}</b>
            </div>
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
                      <th>ENTRY</th>
                      <th>MARK</th>
                      <th>LIQ</th>
                      <th>PNL %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.positions.map((p) => (
                      <tr key={p.key} title={`${p.pool} · collateral ${money(p.collateralUsd)} · ${money(p.pnlUsd)}`}>
                        <td className="hl-coin">
                          {p.market}
                          {data.positions.filter((x) => x.market === p.market).length > 1 && p.pool ? (
                            <span className="hl-note"> · {p.pool}</span>
                          ) : null}
                        </td>
                        <td className={p.isLong ? "is-up" : "is-down"}>{p.isLong ? "LONG" : "SHORT"}</td>
                        <td className="num">{p.leverage.toFixed(1)}x</td>
                        <td className="num">{money(p.sizeUsd)}</td>
                        <td className="num">{px(p.entryPx)}</td>
                        <td className="num">{px(p.markPx)}</td>
                        <td className="num">{p.liqPx ? px(p.liqPx) : "-"}</td>
                        <td className={`num ${p.pnlPct >= 0 ? "is-up" : "is-down"}`}>
                          {p.pnlPct >= 0 ? "+" : ""}
                          {p.pnlPct.toFixed(1)}%
                        </td>
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
                      {t.pnlUsd ? money(t.pnlUsd) : "-"}
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
