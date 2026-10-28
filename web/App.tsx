import { useCallback, useEffect, useState } from "react";
import type { DeskSnapshot, LeaderRow } from "@shared/hl";
import { Leaderboard } from "./components/hl/Leaderboard";
import { WalletView } from "./components/hl/WalletView";
import { ChartTab } from "./components/hl/ChartTab";
import { Following } from "./components/hl/Following";

type Tab = "board" | "wallet" | "chart" | "following";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "board", label: "LEADERBOARD" },
  { id: "wallet", label: "WALLET" },
  { id: "chart", label: "CHART" },
  { id: "following", label: "FOLLOWING" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("board");
  const [desk, setDesk] = useState<DeskSnapshot | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  // On the public host a shim answers /api from a snapshot; it sets this flag.
  const [isStatic, setIsStatic] = useState<boolean>(
    () => Boolean((window as unknown as { __HL_STATIC__?: boolean }).__HL_STATIC__),
  );

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/desk");
        const body = (await res.json()) as { ok: boolean; desk: DeskSnapshot };
        if (!alive) return;
        if (!body.ok) throw new Error("desk unavailable");
        setDesk(body.desk);
        setError(null);
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    };
    const loadFollow = async () => {
      try {
        const res = await fetch("/api/following");
        const body = (await res.json()) as { ok: boolean; wallets?: Array<{ addr: string }> };
        if (alive && body.ok) setFollowed(new Set((body.wallets ?? []).map((w) => w.addr.toLowerCase())));
      } catch {
        /* keep the last set */
      }
    };
    void load();
    void loadFollow();
    const t = window.setInterval(load, 60_000);
    const tf = window.setInterval(loadFollow, 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.clearInterval(tf);
    };
  }, []);

  const pick = useCallback((row: LeaderRow) => {
    setPicked(row.addr);
    setTab("wallet");
  }, []);

  useEffect(() => {
    // The static shim fires "hl-static" the first time it serves a snapshot file,
    // which is after the first render, so listen instead of reading once.
    const onStatic = () => setIsStatic(true);
    window.addEventListener("hl-static", onStatic);
    if ((window as unknown as { __HL_STATIC__?: boolean }).__HL_STATIC__) setIsStatic(true);
    return () => window.removeEventListener("hl-static", onStatic);
  }, []);

  const pickAddr = useCallback((addr: string) => {
    setPicked(addr);
    setTab("wallet");
  }, []);

  const updated = desk?.at ? Math.max(0, Math.round((Date.now() - desk.at) / 60_000)) : null;

  return (
    <div className="app-shell">
      <header className="hl-head">
        <div className="hl-brand">
          <span className="hl-brand__mark" aria-hidden="true" />
          <div>
            <h1 className="hl-brand__title">
              HL <span>DESK</span>
            </h1>
            <p className="hl-brand__sub">hyperliquid research · read only · no wallet</p>
          </div>
        </div>

        <nav className="hl-tabs" role="tablist" aria-label="views">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`chart-tab ${tab === t.id ? "is-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="hl-status">
          <span
            className={`feed-pill ${isStatic ? "is-snapshot" : error ? "is-down" : "is-live"}`}
            title={
              isStatic
                ? "this page is a saved copy of the private desk; numbers freeze at the snapshot time"
                : "reading the live desk engine"
            }
          >
            <i className="feed-pill__dot" aria-hidden="true" />
            <span className="feed-pill__label">{isStatic ? "SNAPSHOT" : error ? "OFFLINE" : "LIVE"}</span>
          </span>
          <span className="hl-status__sub num">
            {desk ? `${desk.leaderboard.length} consistent · ${desk.nearMiss.length} near` : "loading"}
            {updated !== null ? ` · ${updated}m ago` : ""}
          </span>
        </div>
      </header>

      <main className={`hl-main ${tab === "chart" ? "hl-main--fixed" : ""}`}>
        {error ? <div className="hl-error">{error}</div> : null}

        {tab === "board" ? (
          <Leaderboard rows={desk?.leaderboard ?? []} near={desk?.nearMiss ?? []} onPick={pick} followed={followed} />
        ) : tab === "wallet" ? (
          <WalletView addr={picked} />
        ) : tab === "chart" ? (
          <ChartTab markets={desk?.markets ?? []} />
        ) : (
          <Following onPick={pickAddr} />
        )}
      </main>
    </div>
  );
}
