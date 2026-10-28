/**
 * Indicator maths — a checked port of AI-Crypto-Trader's `trader.indicators`.
 *
 * The Python package in D:\VibeCoding\AI-Crypto-Trader is the authoritative
 * implementation. This copy exists so the cockpit can compute indicators inside its
 * own process, and it is held to that authority by
 * `test/indicators/equivalence.test.ts`, which replays 500 real BTC 1m candles
 * through both and requires agreement to 1e-9.
 *
 * Re-run `python scripts/gen-indicator-fixture.py` after any change to the Python
 * maths, then fix this file until the test is green again. Do not "fix" the test.
 *
 * Warmup convention is preserved exactly: every series is the same length as its
 * input, and positions before an indicator is defined read 0 rather than the list
 * being trimmed.
 */

export const INDICATOR_VERSION = "1";

/** Exponential moving average, seeded from the first value, warmup zeroed. */
export function ema(values: number[], length: number): number[] {
  if (length < 1) throw new Error(`length must be >= 1, got ${length}`);
  const n = values.length;
  const out = new Array<number>(n).fill(0);
  if (n < length) return out;

  const alpha = 2 / (length + 1);
  out[0] = values[0]!;
  for (let i = 1; i < n; i++) out[i] = alpha * values[i]! + (1 - alpha) * out[i - 1]!;
  for (let i = 0; i < length - 1; i++) out[i] = 0;
  return out;
}

/** Wilder's true range for one bar. */
export function trueRange(high: number, low: number, prevClose: number): number {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

/** Average true range, Wilder-smoothed, seeded from the first bar, warmup zeroed. */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  length: number,
): number[] {
  if (length < 1) throw new Error(`length must be >= 1, got ${length}`);
  const n = closes.length;
  const out = new Array<number>(n).fill(0);
  if (n < length) return out;

  let running = 0;
  for (let i = 0; i < n; i++) {
    const prevClose = i > 0 ? closes[i - 1]! : closes[i]!;
    const tr = trueRange(highs[i]!, lows[i]!, prevClose);
    running = i === 0 ? tr : (running * (length - 1) + tr) / length;
    out[i] = running;
  }
  for (let i = 0; i < length - 1; i++) out[i] = 0;
  return out;
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
