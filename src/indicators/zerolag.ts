import { atr, ema } from "./math";

/**
 * Zero Lag Signals trend: the same approximation AI-Crypto-Trader uses, ported
 * line for line. See that project's `trader/indicators/zerolag.py` for the
 * reasoning behind each step; the comments here only record what the code does.
 */

export interface ZeroLagParams {
  length: number;
  smoothing: number;
  lookback: number;
}

export const DEFAULT_ZEROLAG: ZeroLagParams = { length: 70, smoothing: 1, lookback: 2 };

export interface ZeroLagResult {
  trend: number[];
  entryLong: boolean[];
  entryShort: boolean[];
  bandUpper: number[];
  bandLower: number[];
  /** The de-lagged basis line itself, exposed so the chart can draw it. */
  basis: number[];
}

export function computeZeroLag(
  closes: number[],
  highs: number[],
  lows: number[],
  params: ZeroLagParams = DEFAULT_ZEROLAG,
): ZeroLagResult {
  const n = closes.length;
  const trend = new Array<number>(n).fill(0);
  const entryLong = new Array<boolean>(n).fill(false);
  const entryShort = new Array<boolean>(n).fill(false);
  const bandUpper = new Array<number>(n).fill(0);
  const bandLower = new Array<number>(n).fill(0);
  const basis = new Array<number>(n).fill(0);

  if (n === 0) return { trend, entryLong, entryShort, bandUpper, bandLower, basis };

  const length = params.length;
  const zlema = zeroLagEma(closes, length);
  const bandHalfWidth = atr(highs, lows, closes, length);

  let prevTrend = 0;
  for (let i = length; i < n; i++) {
    const upper = zlema[i]! + params.lookback * bandHalfWidth[i]!;
    const lower = zlema[i]! - params.lookback * bandHalfWidth[i]!;
    bandUpper[i] = upper;
    bandLower[i] = lower;
    basis[i] = zlema[i]!;

    let current: number;
    if (prevTrend === 1) {
      current = closes[i]! < lower ? -1 : 1;
    } else if (prevTrend === -1) {
      current = closes[i]! > upper ? 1 : -1;
    } else {
      const c = closes[i]!;
      const z = zlema[i]!;
      current = c > z ? 1 : c < z ? -1 : 0;
    }
    trend[i] = current;

    if (current === 1 && prevTrend === -1) entryLong[i] = true;
    else if (current === -1 && prevTrend === 1) entryShort[i] = true;

    prevTrend = current;
  }

  return { trend, entryLong, entryShort, bandUpper, bandLower, basis };
}

/** De-lagged EMA: each value is pushed forward by its own lag before smoothing. */
function zeroLagEma(closes: number[], length: number): number[] {
  const lag = Math.floor((length - 1) / 2);
  const adjusted = closes.map((c, i) =>
    i >= lag ? c + (c - closes[i - lag]!) : c + 0,
  );
  return ema(adjusted, length);
}
