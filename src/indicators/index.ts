import { atr, ema, type Candle } from "./math";
import { computeMacd, DEFAULT_MACD, type MacdParams, type MacdResult, type MacdMode } from "./macd";
import { computeZeroLag, DEFAULT_ZEROLAG, type ZeroLagParams, type ZeroLagResult } from "./zerolag";
import { evaluateAgreement, describeAgreement, type AgreementState } from "./agreement";

export * from "./math";
export * from "./macd";
export * from "./zerolag";
export * from "./agreement";

export interface IndicatorSnapshot {
  /** Bars available. */
  bars: number;
  ts: number;
  close: number;
  macdTrend: number;
  macdHist: number;
  crossUp: boolean;
  crossDown: boolean;
  zlTrend: number;
  zlEntryLong: boolean;
  zlEntryShort: boolean;
  bandUpper: number;
  bandLower: number;
  basis: number;
  agreement: AgreementState;
  agreementText: string;
  /** True once both indicators are past warmup and the reading is meaningful. */
  live: boolean;
}

export interface IndicatorSeries {
  ema12: number[];
  ema26: number[];
  atr70: number[];
  macd: MacdResult;
  zerolag: ZeroLagResult;
}

export function computeSeries(
  candles: Candle[],
  opts: { zerolag?: ZeroLagParams; macd?: MacdParams; macdMode?: MacdMode } = {},
): IndicatorSeries {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  return {
    ema12: ema(closes, 12),
    ema26: ema(closes, 26),
    atr70: atr(highs, lows, closes, 70),
    macd: computeMacd(closes, opts.macd ?? DEFAULT_MACD, opts.macdMode ?? "crossover"),
    zerolag: computeZeroLag(closes, highs, lows, opts.zerolag ?? DEFAULT_ZEROLAG),
  };
}

/** The reading at the newest candle, shaped for the cockpit and the tape. */
export function snapshotAt(
  series: IndicatorSeries,
  candles: Candle[],
  index: number,
  window = 3,
): IndicatorSnapshot {
  const i = Math.max(0, Math.min(index, candles.length - 1));
  const c = candles[i];
  const macdTrend = series.macd.trend[i] ?? 0;
  const zlTrend = series.zerolag.trend[i] ?? 0;
  return {
    bars: candles.length,
    ts: c?.ts ?? 0,
    close: c?.close ?? 0,
    macdTrend,
    macdHist: series.macd.hist[i] ?? 0,
    crossUp: series.macd.crossUp[i] ?? false,
    crossDown: series.macd.crossDown[i] ?? false,
    zlTrend,
    zlEntryLong: series.zerolag.entryLong[i] ?? false,
    zlEntryShort: series.zerolag.entryShort[i] ?? false,
    bandUpper: series.zerolag.bandUpper[i] ?? 0,
    bandLower: series.zerolag.bandLower[i] ?? 0,
    basis: series.zerolag.basis[i] ?? 0,
    agreement: evaluateAgreement(series.zerolag.trend, series.macd.trend, i, window),
    agreementText: describeAgreement(series.zerolag.trend, series.macd.trend, i, window),
    live: macdTrend !== 0 || zlTrend !== 0,
  };
}
