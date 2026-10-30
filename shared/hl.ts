/** Wire types for the Hyperliquid desk. Read-only, no trading. */

export interface LeaderRow {
  addr: string;
  equity: number;
  pnl30: number;
  roi30: number;
  greenDays: number;
  worstDay: number;
  concentration: number;
  /** Same figures over the last 7 days, for the window switch. Null while unknown. */
  pnl7?: number | null;
  roi7?: number | null;
  green7?: number | null;
  worst7?: number | null;
  conc7?: number | null;
  followable: number | null;
  trades24h: number | null;
  coins24h: number | null;
  /** Closing fills in the last 48h that ended in profit, and those that did not. */
  wins48?: number | null;
  losses48?: number | null;
  /** Fill counts from the venue's last 2000 fills; null when unknown. */
  trades7d?: number | null;
  trades30d?: number | null;
  /** True when the venue's 2000-fill page was full, so the counts are floors. */
  tradesCapped?: boolean;
  verdict: "consistent" | "lucky" | "thin";
  /** Which test the wallet failed, when it is a near miss. */
  reason?: string;
}

export interface CurvePoint {
  t: number;
  v: number;
}

export interface WalletFill {
  time: number;
  /** Raw venue symbol; spot fills use ids like @162. */
  coin: string;
  /** Display name, with spot ids resolved to a ticker pair. */
  name: string;
  dir: string;
  px: number;
  sz: number;
  notional: number;
  closedPnl: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartMarker {
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle";
  text: string;
}

export interface WalletDetail {
  addr: string;
  equity: number;
  pnl30: number;
  roi30: number;
  greenDays: number;
  worstDay: number;
  curve: CurvePoint[];
  fills: WalletFill[];
  /** Live open perp positions, straight from the venue. */
  positions: PerpPosition[];
  /** Live spot balances worth showing. */
  spot: SpotBalance[];
  /** Total fills in the 48h window, so the table can page. */
  fillsTotal: number;
}

export interface PerpPosition {
  coin: string;
  name: string;
  /** Signed size built from the last 48h of fills: positive long, negative short. */
  size: number;
  /** Average entry across those fills only. */
  entryPx: number;
  markPx: number;
  unrealizedPnl: number;
  fills: number;
  since: number;
  /** The venue's own total position, which may be older than the window. */
  venueSize: number | null;
  /**
   * Leverage the venue has set on this coin, e.g. 10 for 10x. Fills do not
   * carry it, so it is null when the wallet no longer holds the coin.
   */
  leverage: number | null;
}

export interface SpotBalance {
  coin: string;
  name: string;
  /** Net quantity bought minus sold in the window. */
  total: number;
  value: number;
  fills: number;
}

export interface MarketRow {
  coin: string;
  markPx: number;
  funding: number;
  oiUsd: number;
}

export interface DeskSnapshot {
  at: number;
  leaderboard: LeaderRow[];
  nearMiss: LeaderRow[];
  markets: MarketRow[];
}

export interface CandleResponse {
  coin: string;
  interval: string;
  candles: Candle[];
}

export interface FollowedLastTrade {
  /** When the newest fill landed. */
  at: number;
  coin: string;
  side: "LONG" | "SHORT";
  /** What that fill did: opened, closed, or a spot buy/sell. */
  action: "OPEN" | "CLOSE" | "BUY" | "SELL";
  /** Unrealised move on the position that fill belongs to, as a fraction. */
  pct: number | null;
  entryPx: number | null;
  markPx: number | null;
}

export interface FollowedStats {
  equity: number;
  pnl30: number;
  roi30: number;
  greenDays: number;
  worstDay: number;
  concentration: number;
  trades48h: number;
  last: FollowedLastTrade | null;
}

export interface FollowedWallet {
  addr: string;
  addedAt: number;
  alerts: boolean;
  lastFillAt: number;
  trades24h?: number | null;
  coins24h?: number | null;
  /** Leaderboard-style quality numbers, filled in by the server. */
  stats?: FollowedStats | null;
}

export interface FollowingView {
  webhook: string | null;
  wallets: FollowedWallet[];
  polledAt: number;
  alertsSent: number;
  windowMinutes: number;
}
