import { useMemo, useState } from "react";
import type { GmxBoard } from "@shared/gmx";

const money = (n: number) => {
  const a = Math.abs(n);
  const s =
    a >= 1e9 ? `${(a / 1e9).toFixed(1)}b` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}m` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : a.toFixed(0);
  return `${n < 0 ? "-" : ""}$${s}`;
};
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;
const short = (a: string) => `${a.slice(0, 6)}.${a.slice(-4)}`;

type SortKey = "pnl" | "roi" | "avgLev" | "wins" | "trades" | "trades48";

export function GmxBoardTable({
  board,
  onPick,
  windowId,
  onWindow,
  followed,
  onToggleFollow,
}: {
  board: GmxBoard | null;
  onPick: (addr: string) => void;
  windowId: "7d" | "30d";
  onWindow: (w: "7d" | "30d") => void;
  followed: Set<string>;
  onToggleFollow: (addr: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>("pnl");
  const [desc, setDesc] = useState(true);

  const cols: Array<{ key: SortKey; label: string; hint: string }> = [
    { key: "pnl", label: `${windowId.toUpperCase()} P&L`, hint: "realised pnl over the window, GMX's own figure" },
    { key: "roi", label: "ROI", hint: "net realised pnl over the capital used in the window" },
    { key: "wins", label: "WIN/LOSS", hint: "closed positions in profit against those not" },
    { key: "avgLev", label: "AVG LEV", hint: "average leverage across those positions" },
    { key: "trades48", label: "48H", hint: "executed fills in the last 48 hours" },
    { key: "trades", label: `${windowId.toUpperCase()} TRADES`, hint: "closed positions in the window" },
  ];

  const rows = useMemo(() => {
    const list = [...(board?.rows ?? [])];
    return list.sort((a, b) => {
      const av = a[sort] ?? -1;
      const bv = b[sort] ?? -1;
      return desc ? bv - av : av - bv;
    });
  }, [board, sort, desc]);

  const click = (key: SortKey) => {
    if (key === sort) setDesc(!desc);
    else {
      setSort(key);
      setDesc(true);
    }
  };

  return (
    <section className="hl-panel">
      <div className="hl-panel__head">
        <h2 className="lab">PROFITABLE AND ACTIVE</h2>
        <div className="hl-seg">
          {(["7d", "30d"] as const).map((w) => (
            <button key={w} type="button" className={`chip ${windowId === w ? "is-on" : ""}`} onClick={() => onWindow(w)}>
              {w.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="hl-grow" />
        <span className="hl-lab">{rows.length} wallets</span>
      </div>

      {!board ? (
        <p className="hl-empty">loading the gmx board…</p>
      ) : rows.length === 0 ? (
        <p className="hl-empty">the indexer returned no rows for this window</p>
      ) : (
        <div className="hl-scroll">
          <table className="hl-table">
            <thead>
              <tr>
                <th className="hl-rank">#</th>
                <th>WALLET</th>
                {cols.map((c) => (
                  <th key={c.key} title={c.hint} className="hl-sort" onClick={() => click(c.key)}>
                    {c.label}
                    {sort === c.key ? <i>{desc ? "▾" : "▴"}</i> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const on = followed.has(r.addr.toLowerCase());
                return (
                  <tr key={r.addr} onClick={() => onPick(r.addr)} className="hl-row" title={r.addr}>
                    <td className="hl-rank num">
                      {i + 1}
                      <button
                        type="button"
                        className={`hl-star-btn ${on ? "is-on" : ""}`}
                        aria-label={on ? `unstar ${r.addr}` : `star ${r.addr}`}
                        title={on ? "remove from favourites" : "save to favourites"}
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleFollow(r.addr);
                        }}
                      >
                        {on ? "★" : "☆"}
                      </button>
                    </td>
                    <td className="hl-addr num">{short(r.addr)}</td>
                    <td className={`num ${r.pnl >= 0 ? "is-up" : "is-down"}`}>{money(r.pnl)}</td>
                    <td className={`num ${r.roi >= 0 ? "is-up" : "is-down"}`}>{pct(r.roi)}</td>
                    <td className="num">
                      {r.wins.toFixed(0)}/{r.losses.toFixed(0)}
                      {r.wins + r.losses > 0 ? (
                        <i className="hl-winrate"> {((r.wins / (r.wins + r.losses)) * 100).toFixed(0)}%</i>
                      ) : null}
                    </td>
                    <td className="num">{r.avgLev.toFixed(1)}x</td>
                    <td className="num">{r.trades48 ?? "·"}</td>
                    <td className="num">{r.trades.toFixed(0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="hl-note">
        Positive realised pnl, ranked by it. PnL is GMX&apos;s own realised figure; ROI is net realised PnL after fees and
        price impact over the capital used in the window. Click a column to sort, star a wallet to keep it. Passes no
        solvency test yet.
      </p>
    </section>
  );
}
