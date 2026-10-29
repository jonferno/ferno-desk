import { useCallback, useEffect, useState } from "react";
import type { DeskSnapshot, LeaderRow } from "@shared/hl";
import type { GmxBoard } from "@shared/gmx";
import { Leaderboard } from "./components/hl/Leaderboard";
import { WalletView } from "./components/hl/WalletView";
import { ChartTab } from "./components/hl/ChartTab";
import { Following } from "./components/hl/Following";
import { GmxBoardTable } from "./components/gmx/Board";
import { GmxWalletView } from "./components/gmx/Wallet";

type Tab = "board" | "wallet" | "chart" | "following";
type GmxTab = "board" | "wallet";
type Venue = "hl" | "gmx";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "board", label: "LEADERBOARD" },
  { id: "wallet", label: "WALLET" },
  { id: "chart", label: "CHART" },
  { id: "following", label: "FOLLOWING" },
];

const GMX_TABS: Array<{ id: GmxTab; label: string }> = [
  { id: "board", label: "LEADERBOARD" },
  { id: "wallet", label: "WALLET" },
];

const VENUE_KEY = "hl-desk-venue";

export default function App() {
  const [venue, setVenue] = useState<Venue>(() => {
    try {
      return window.localStorage.getItem(VENUE_KEY) === "gmx" ? "gmx" : "hl";
    } catch {
      return "hl";
    }
  });
  const [tab, setTab] = useState<Tab>("board");
  const [gmxTab, setGmxTab] = useState<GmxTab>("board");
  const [desk, setDesk] = useState<DeskSnapshot | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedGmx, setPickedGmx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gmxBoard, setGmxBoard] = useState<GmxBoard | null>(null);
  const [gmxError, setGmxError] = useState<string | null>(null);
  const [gmxWindow, setGmxWindow] = useState<"7d" | "30d">("30d");
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  // On the public host a shim answers /api from a snapshot; it sets this flag.
  const [isStatic, setIsStatic] = useState<boolean>(
    () => Boolean((window as unknown as { __HL_STATIC__?: boolean }).__HL_STATIC__),
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(VENUE_KEY, venue);
    } catch {
      /* private mode */
    }
  }, [venue]);

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

  useEffect(() => {
    if (venue !== "gmx") return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/gmx/board?window=${gmxWindow}`);
        const body = (await res.json()) as { ok: boolean; board?: GmxBoard; error?: string };
        if (!alive) return;
        if (!body.ok || !body.board) throw new Error(body.error ?? "gmx board unavailable");
        setGmxBoard(body.board);
        setGmxError(null);
      } catch (err) {
        if (alive) setGmxError((err as Error).message);
      }
    };
    void load();
    const t = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [venue, gmxWindow]);

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
  const isGmx = venue === "gmx";
  const tabs = isGmx ? GMX_TABS : TABS;
  const activeTab = isGmx ? gmxTab : tab;
  const activeError = isGmx ? gmxError : error;

  return (
    <div className="app-shell">
      <header className="hl-head">
        <div className="hl-brand">
          <span className="hl-brand__mark" aria-hidden="true" />
          <div>
            <h1 className="hl-brand__title">
              {isGmx ? "GMX" : "HL"} <span>DESK</span>
            </h1>
            <p className="hl-brand__sub">
              {isGmx ? "gmx v2 research · arbitrum · read only" : "hyperliquid research · read only · no wallet"}
            </p>
          </div>
        </div>

        <div className="venue-switch" role="group" aria-label="venue" hidden={isStatic}>
          <button
            type="button"
            className={`venue-btn ${!isGmx ? "is-on" : ""}`}
            aria-pressed={!isGmx}
            onClick={() => setVenue("hl")}
          >
            HYPERLIQUID
          </button>
          <button
            type="button"
            className={`venue-btn ${isGmx ? "is-on" : ""}`}
            aria-pressed={isGmx}
            onClick={() => setVenue("gmx")}
            title={isStatic ? "the gmx venue needs the live desk, the snapshot only carries hyperliquid" : "gmx v2 on arbitrum"}
          >
            GMX
          </button>
        </div>

        <nav className="hl-tabs" role="tablist" aria-label="views">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`chart-tab ${activeTab === t.id ? "is-active" : ""}`}
              onClick={() => (isGmx ? setGmxTab(t.id as GmxTab) : setTab(t.id as Tab))}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="hl-status">
          <span
            className={`feed-pill ${isStatic ? "is-snapshot" : activeError ? "is-down" : "is-live"}`}
            title={
              isStatic
                ? "this page is a saved copy of the private desk; numbers freeze at the snapshot time"
                : "reading the live desk engine"
            }
          >
            <i className="feed-pill__dot" aria-hidden="true" />
            <span className="feed-pill__label">{isStatic ? "SNAPSHOT" : activeError ? "OFFLINE" : "LIVE"}</span>
          </span>
          <span className="hl-status__sub num">
            {isGmx
              ? gmxBoard
                ? `${gmxBoard.rows.length} wallets · ${gmxBoard.window}`
                : "loading gmx"
              : desk
                ? `${desk.leaderboard.length} consistent · ${desk.nearMiss.length} near`
                : "loading"}
            {!isGmx && updated !== null ? ` · ${updated}m ago` : ""}
          </span>
        </div>
      </header>

      <main className={`hl-main ${!isGmx && tab === "chart" ? "hl-main--fixed" : ""}`}>
        {activeError ? <div className="hl-error">{activeError}</div> : null}

        {isGmx ? (
          gmxTab === "board" ? (
            <GmxBoardTable
              board={gmxBoard}
              windowId={gmxWindow}
              onWindow={setGmxWindow}
              onPick={(addr) => {
                setPickedGmx(addr);
                setGmxTab("wallet");
              }}
            />
          ) : (
            <GmxWalletView addr={pickedGmx} />
          )
        ) : tab === "board" ? (
          <Leaderboard rows={desk?.leaderboard ?? []} near={desk?.nearMiss ?? []} onPick={pick} followed={followed} />
        ) : tab === "wallet" ? (
          <WalletView addr={picked} />
        ) : tab === "chart" ? (
          <ChartTab markets={desk?.markets ?? []} readOnly={isStatic} />
        ) : (
          <Following onPick={pickAddr} />
        )}
      </main>
    </div>
  );
}
