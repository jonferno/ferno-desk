import { useMemo, useState } from "react";
import type { LeaderRow } from "@shared/hl";

const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}b` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}m` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : a.toFixed(0);
  return `${n < 0 ? "-" : ""}$${s}`;
};
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;

type Col = keyof Pick<
  LeaderRow,
  "pnl30" | "roi30" | "wins48" | "greenDays" | "worstDay" | "concentration" | "trades24h" | "trades7d" | "trades30d"
>;

const COLS: Array<{ key: Col; label: string; hint: string }> = [
  { key: "pnl30", label: "30D P&L", hint: "headline profit, not a quality signal" },
  { key: "roi30", label: "ROI", hint: "30 day return on capital, transfers neutral" },
  { key: "wins48", label: "WIN/LOSS", hint: "closing orders in the last 48h, in profit against not; fills are grouped by order" },
  { key: "greenDays", label: "GREEN", hint: "share of profitable days over full history" },
  { key: "worstDay", label: "WORST", hint: "worst single day" },
  { key: "concentration", label: "BEST/TOT", hint: "share of profit from the single best day" },
  { key: "trades24h", label: "48H", hint: "fills in the last 48 hours" },
  { key: "trades7d", label: "7D", hint: "fills in the last 7 days, from the venue's last 2000" },
  { key: "trades30d", label: "30D", hint: "fills in the last 30 days, from the venue's last 2000" },
];

function Table({
  rows,
  onPick,
  sort,
  desc,
  setSort,
  showReason,
  followed,
  windowId,
}: {
  rows: LeaderRow[];
  onPick: (r: LeaderRow) => void;
  sort: Col;
  desc: boolean;
  setSort: (c: Col) => void;
  showReason?: boolean;
  followed?: Set<string>;
  windowId: "7d" | "30d";
}) {
  // The 48h columns never switch; the window columns read the 7d figures.
  const val = (r: LeaderRow, key: Col): number | null | undefined => {
    if (windowId === "7d") {
      switch (key) {
        case "pnl30":
          return r.pnl7;
        case "roi30":
          return r.roi7;
        case "greenDays":
          return r.green7;
        case "worstDay":
          return r.worst7;
        case "concentration":
          return r.conc7;
        default:
          break;
      }
    }
    return r[key] as number | null | undefined;
  };

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = val(a, sort);
      const bv = val(b, sort);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return desc ? Number(bv) - Number(av) : Number(av) - Number(bv);
    });
  }, [rows, sort, desc, windowId]);

  return (
    <div className="hl-scroll">
      <table className="hl-table">
        <thead>
          <tr>
            <th className="hl-rank">#</th>
            <th>WALLET</th>
            {COLS.map((c) => (
              <th key={c.key} title={c.hint} className="hl-sort" onClick={() => setSort(c.key)}>
                {c.key === "pnl30" ? `${windowId === "7d" ? "7D" : "30D"} P&L` : c.label}
                {sort === c.key ? <i>{desc ? "▾" : "▴"}</i> : null}
              </th>
            ))}
            {showReason ? <th>FAILED</th> : null}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const pnl = val(r, "pnl30");
            const roi = val(r, "roi30");
            const green = val(r, "greenDays");
            const worst = val(r, "worstDay");
            const conc = val(r, "concentration");
            return (
              <tr key={r.addr} onClick={() => onPick(r)} className="hl-row">
                <td className="hl-rank num">
                  {i + 1}
                  {followed?.has(r.addr.toLowerCase()) ? (
                    <span className="hl-star" title="you favourite this wallet" aria-label="favourite">
                      ★
                    </span>
                  ) : null}
                </td>
                <td className="hl-addr num">{r.addr.slice(0, 6)}…{r.addr.slice(-4)}</td>
                <td className={`num ${pnl != null && pnl >= 0 ? "is-up" : "is-down"}`}>{pnl == null ? "·" : money(pnl)}</td>
                <td className={`num ${roi != null && roi >= 0 ? "is-up" : "is-down"}`}>{roi == null ? "·" : pct(roi)}</td>
                <td className="num">
                  {r.wins48 != null ? (
                    <>
                      {r.wins48}/{r.losses48 ?? 0}
                      {r.wins48 + (r.losses48 ?? 0) > 0 ? (
                        <i className="hl-winrate">
                          {" "}
                          {((r.wins48 / (r.wins48 + (r.losses48 ?? 0))) * 100).toFixed(0)}%
                        </i>
                      ) : null}
                    </>
                  ) : (
                    "·"
                  )}
                </td>
                <td className="num">{green == null ? "·" : `${green.toFixed(0)}%`}</td>
                <td className="num is-down">{worst == null ? "·" : money(worst)}</td>
                <td className={`num ${conc != null && conc >= 0.55 ? "is-down" : ""}`}>{conc == null ? "·" : pct(conc, 0)}</td>
                <td className="num">{r.trades24h ?? "·"}</td>
              <td className="num">{r.trades7d != null ? `${r.trades7d}${r.tradesCapped ? "+" : ""}` : "·"}</td>
              <td className="num">{r.trades30d != null ? `${r.trades30d}${r.tradesCapped ? "+" : ""}` : "·"}</td>
              {showReason ? <td className="hl-reason">{r.reason || "-"}</td> : null}
              </tr>
            );
          })}
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
  const [windowId, setWindowId] = useState<"7d" | "30d">("30d");

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
          <div className="hl-seg">
            {(["7d", "30d"] as const).map((w) => (
              <button
                key={w}
                type="button"
                className={`chip ${windowId === w ? "is-on" : ""}`}
                onClick={() => setWindowId(w)}
              >
                {w.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="hl-grow" />
          <span className="hl-lab">{rows.length} wallets</span>
        </div>
        {rows.length === 0 ? (
          <p className="hl-empty">building the board. the first pass takes about a minute.</p>
        ) : (
          <Table
            rows={rows}
            onPick={onPick}
            sort={sort}
            desc={desc}
            setSort={click}
            followed={followed}
            windowId={windowId}
          />
        )}
        <p className="hl-note">
          Passes all four: active in the last 48h, green days at or above 48%, one day not more than 55% of profit, worst
          day better than -30% of equity. The 7D/30D switch changes the PnL, ROI, green, worst and best-day columns; the 48h
          and win/loss figures always cover the last 48 hours.
        </p>
      </section>

      {near.length > 0 ? (
        <section className="hl-panel hl-nearpanel">
          <div className="hl-panel__head">
            <h2 className="lab">NEAR MISSES</h2>
            <span className="hl-grow" />
            <span className="hl-lab">failed exactly one test</span>
          </div>
          <Table
            rows={near}
            onPick={onPick}
            sort={sort}
            desc={desc}
            setSort={click}
            showReason
            followed={followed}
            windowId={windowId}
          />
          <p className="hl-note">
            One weak spot each, listed so you can judge it yourself instead of having it hidden. Click any row for the
            full wallet.
          </p>
        </section>
      ) : null}
    </>
  );
}
