import { useMemo, useState } from "react";
import type { LeaderRow } from "@shared/hl";

const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}b` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}m` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : a.toFixed(0);
  return `${n < 0 ? "-" : ""}$${s}`;
};
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;

type Col = keyof Pick<LeaderRow, "equity" | "pnl30" | "roi30" | "greenDays" | "worstDay" | "concentration" | "trades24h">;

const COLS: Array<{ key: Col; label: string; hint: string }> = [
  { key: "equity", label: "EQUITY", hint: "account value" },
  { key: "pnl30", label: "30D P&L", hint: "headline profit, not a quality signal" },
  { key: "roi30", label: "ROI", hint: "30 day return on equity" },
  { key: "greenDays", label: "GREEN", hint: "share of profitable days over full history" },
  { key: "worstDay", label: "WORST", hint: "worst single day" },
  { key: "concentration", label: "BEST/TOT", hint: "share of profit from the single best day" },
  { key: "trades24h", label: "48H", hint: "fills in the last 48 hours" },
];

function Table({
  rows,
  onPick,
  sort,
  desc,
  setSort,
  showReason,
  followed,
}: {
  rows: LeaderRow[];
  onPick: (r: LeaderRow) => void;
  sort: Col;
  desc: boolean;
  setSort: (c: Col) => void;
  showReason?: boolean;
  followed?: Set<string>;
}) {
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return desc ? Number(bv) - Number(av) : Number(av) - Number(bv);
    });
  }, [rows, sort, desc]);

  return (
    <div className="hl-scroll">
      <table className="hl-table">
        <thead>
          <tr>
            <th className="hl-rank">#</th>
            <th>WALLET</th>
            {COLS.map((c) => (
              <th key={c.key} title={c.hint} className="hl-sort" onClick={() => setSort(c.key)}>
                {c.label}
                {sort === c.key ? <i>{desc ? "▾" : "▴"}</i> : null}
              </th>
            ))}
            {showReason ? <th>FAILED</th> : null}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.addr} onClick={() => onPick(r)} className="hl-row">
              <td className="hl-rank num">
                {i + 1}
                {followed?.has(r.addr.toLowerCase()) ? (
                  <span className="hl-star" title="you follow this wallet" aria-label="following">
                    ★
                  </span>
                ) : null}
              </td>
              <td className="hl-addr num">{r.addr.slice(0, 6)}…{r.addr.slice(-4)}</td>
              <td className="num">{money(r.equity)}</td>
              <td className={`num ${r.pnl30 >= 0 ? "is-up" : "is-down"}`}>{money(r.pnl30)}</td>
              <td className={`num ${r.roi30 >= 0 ? "is-up" : "is-down"}`}>{pct(r.roi30)}</td>
              <td className="num">{r.greenDays.toFixed(0)}%</td>
              <td className="num is-down">{money(r.worstDay)}</td>
              <td className={`num ${r.concentration >= 0.55 ? "is-down" : ""}`}>{pct(r.concentration, 0)}</td>
              <td className="num">{r.trades24h ?? "·"}</td>
              {showReason ? <td className="hl-reason">{r.reason || "-"}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Leaderboard({
  rows,
  near,
  onPick,
  followed,
}: {
  rows: LeaderRow[];
  near: LeaderRow[];
  onPick: (r: LeaderRow) => void;
  followed?: Set<string>;
}) {
  const [sort, setSort] = useState<Col>("pnl30");
  const [desc, setDesc] = useState(true);

  const click = (c: Col) => {
    if (c === sort) setDesc(!desc);
    else {
      setSort(c);
      setDesc(true);
    }
  };

  return (
    <>
      <section className="hl-panel">
        <div className="hl-panel__head">
          <h2 className="lab">CONSISTENT AND ACTIVE</h2>
          <span className="hl-grow" />
          <span className="hl-lab">{rows.length} wallets</span>
        </div>
        {rows.length === 0 ? (
          <p className="hl-empty">building the board. the first pass takes about a minute.</p>
        ) : (
          <Table rows={rows} onPick={onPick} sort={sort} desc={desc} setSort={click} followed={followed} />
        )}
        <p className="hl-note">
          Passes all four: active in the last 48h, green days at or above 48%, one day not more than 55% of profit, worst
          day better than -30% of equity. Ranked on their full history, not the last month.
        </p>
      </section>

      {near.length > 0 ? (
        <section className="hl-panel hl-nearpanel">
          <div className="hl-panel__head">
            <h2 className="lab">NEAR MISSES</h2>
            <span className="hl-grow" />
            <span className="hl-lab">failed exactly one test</span>
          </div>
          <Table rows={near} onPick={onPick} sort={sort} desc={desc} setSort={click} showReason followed={followed} />
          <p className="hl-note">
            One weak spot each, listed so you can judge it yourself instead of having it hidden. Click any row for the
            full wallet.
          </p>
        </section>
      ) : null}
    </>
  );
}
