/** Shared types for the GMX venue. All money arrives as 30-decimal strings. */

export interface GmxRow {
  addr: string;
  /** Realised PnL in USD over the window. */
  pnl: number;
  /** Return on capital used, as a fraction (0.42 = 42%). */
  roi: number;
  volume: number;
  /** Average position size in USD. */
  avgSize: number;
  /** Average leverage across closed positions. */
  avgLev: number;
  wins: number;
  losses: number;
  trades: number;
  /** Capital the return is measured against. */
  capital: number;
}

export interface GmxBoard {
  at: number;
  window: string;
  from: number;
  to: number;
  rows: GmxRow[];
}

export interface GmxPosition {
  key: string;
  market: string;
  pool: string;
  isLong: boolean;
  sizeUsd: number;
  collateralUsd: number;
  entryPx: number;
  markPx: number;
  liqPx: number | null;
  leverage: number;
  pnlUsd: number;
  /** Percent of collateral, already leverage-aware (GMX reports it). */
  pnlPct: number;
}

export interface GmxTrade {
  time: number;
  market: string;
  /** open / close / swap */
  kind: string;
  isLong: boolean;
  sizeUsd: number;
  pnlUsd: number;
}

export interface GmxLastTrade {
  side: "LONG" | "SHORT";
  market: string;
  /** PnL of that fill over its own notional, as a fraction. Null when the fill had no size. */
  pnlPct: number | null;
  kind: string;
  at: number;
}

export interface GmxFollowCard {
  addr: string;
  row: GmxRow | null;
  last: GmxLastTrade | null;
}

export interface GmxWallet {  addr: string;
  positions: GmxPosition[];
  trades: GmxTrade[];
  tradesTotal: number;
  /** Window stats when the address is on the board, otherwise null. */
  row: GmxRow | null;
  /** Cumulative realised PnL over 30 days, one point per day. */
  curve: Array<{ t: number; v: number }>;
  /** Sum of open position PnL in USD. */
  unrealized: number;
  /** Sum of collateral locked in open positions, in USD. */
  collateral: number;
}
