import { ema } from "./math";

/**
 * MACD with a configurable trend read — a checked port of AI-Crypto-Trader's
 * `trader/indicators/macd_mtf.py`.
 *
 * `crossover` and `histogram` are the same predicate (hist === macd - signal); both
 * names are kept because the config accepts either.
 */

export interface MacdParams {
  fast: number;
  slow: number;
  signal: number;
  htfSmoothing: number;
}

export const DEFAULT_MACD: MacdParams = { fast: 12, slow: 26, signal: 9, htfSmoothing: 60 };

export type MacdMode = "crossover" | "histogram";
const MODES: MacdMode[] = ["crossover", "histogram"];

export interface MacdResult {
  macd: number[];
  signal: number[];
  hist: number[];
  trend: number[];
  crossUp: boolean[];
  crossDown: boolean[];
}

export function computeMacd(
  closes: number[],
  params: MacdParams = DEFAULT_MACD,
  mode: MacdMode = "crossover",
): MacdResult {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(",")}, got ${mode}`);

  const n = closes.length;
  const macd = new Array<number>(n).fill(0);
  const trend = new Array<number>(n).fill(0);
  const crossUp = new Array<boolean>(n).fill(false);
  const crossDown = new Array<boolean>(n).fill(false);

  if (n === 0) {
    return { macd, signal: [], hist: [], trend, crossUp, crossDown };
  }

  const fastEma = ema(closes, params.fast);
  const slowEma = ema(closes, params.slow);
  const liveMacd = params.slow - 1;
  for (let i = liveMacd; i < n; i++) macd[i] = fastEma[i]! - slowEma[i]!;

  const signal = ema(macd, params.signal);
  const hist = macd.map((m, i) => m - signal[i]!);

  const live = Math.max(params.fast, params.slow) + params.signal - 1;
  for (let i = live; i < n; i++) {
    if (mode === "crossover") {
      trend[i] = macd[i]! > signal[i]! ? 1 : macd[i]! < signal[i]! ? -1 : 0;
    } else {
      trend[i] = hist[i]! > 0 ? 1 : hist[i]! < 0 ? -1 : 0;
    }
  }

  for (let i = live + 1; i < n; i++) {
    if (trend[i] === 1 && trend[i - 1] !== 1) crossUp[i] = true;
    else if (trend[i] === -1 && trend[i - 1] !== -1) crossDown[i] = true;
  }

  return { macd, signal, hist, trend, crossUp, crossDown };
}
