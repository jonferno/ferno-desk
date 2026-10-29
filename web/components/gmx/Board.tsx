import type { GmxBoard, GmxRow } from "@shared/gmx";

const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(2)}m` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(0);
  return `${n < 0 ? "-" : ""}$${s}`;
};
const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const short = (a: string) => `${a.slice(0, 6)}.${a.slice(-4)}`;

export function GmxBoardTable({
  board,
  onPick,
  windowId,
  onWindow,
}: {
  board: GmxBoard | null;
  onPick: (addr: string) => void;
  windowId: "7d" | "30d";
  onWindow: (w: "7d" | "30d") => void;
}) {
  const rows: GmxRow[] = board?.rows ?? [];

  return (
    <section className="hl-panel">
      <div className="hl-panel__head">
        <h2 className="lab">GMX LEADERBOARD</h2>
        <div className="hl-seg">
          {(["7d", "30d"] as const).map((w) => (
            <button key={w} type="button" className={`chip ${windowId === w ? "is-on" : ""}`} onClick={() => onWindow(w)}>
              {w.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="hl-grow" />
        <span className="hl-note num">
          {rows.length} wallets with positive realised pnl · arbitrum
        </span>
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
                <th>#</th>
                <th>WALLET</th>
                <th>PNL</th>
                <th>ROI</th>
                <th>VOLUME</th>
                <th>AVG SIZE</th>
                <th>AVG LEV</th>
                <th>WIN/LOSS</th>
                <th>TRADES</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.addr} onClick={() => onPick(r.addr)} className="hl-row" title={r.addr}>
                  <td className="hl-rank num">{i + 1}</td>
                  <td className="hl-addr num">{short(r.addr)}</td>
                  <td className={`num ${r.pnl >= 0 ? "is-up" : "is-down"}`}>{money(r.pnl)}</td>
                  <td className={`num ${r.roi >= 0 ? "is-up" : "is-down"}`}>{pct(r.roi)}</td>
                  <td className="num">{money(r.volume)}</td>
                  <td className="num">{money(r.avgSize)}</td>
                  <td className="num">{r.avgLev.toFixed(1)}x</td>
                  <td className="num">
                    {r.wins.toFixed(0)}/{r.losses.toFixed(0)}
                  </td>
                  <td className="num">{r.trades.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="hl-note" style={{ marginTop: 8 }}>
        PnL is GMX&apos;s own realised figure; ROI is net realised PnL after fees and price impact over the capital used in
        the window. Solvency screen and following list for GMX are not built yet.
      </p>
    </section>
  );
}
