/**
 * Two-indicator agreement rule — a checked port of AI-Crypto-Trader's
 * `trader/indicators/agreement.py`.
 *
 * The rule that matters: a direction is "agreed" only on a candle where BOTH
 * indicators read it. The window is a staleness allowance (one indicator may lead
 * the other by a candle or two), never a licence to splice one indicator's candle
 * with the other's. trend 0 means "no direction" and never counts.
 */

export type AgreementState = 1 | 0 | -1;
export const LONG: AgreementState = 1;
export const FLAT: AgreementState = 0;
export const SHORT: AgreementState = -1;

export function evaluateAgreement(
  zlTrend: number[],
  macdTrend: number[],
  index: number,
  window = 3,
): AgreementState {
  if (window < 1) throw new Error(`window must be >= 1, got ${window}`);
  if (!zlTrend.length || !macdTrend.length) return FLAT;

  const [end, start] = windowBounds(zlTrend, macdTrend, index, window);
  const longAt = latestAgreement(zlTrend, macdTrend, start, end, 1);
  const shortAt = latestAgreement(zlTrend, macdTrend, start, end, -1);

  if (longAt === null && shortAt === null) return FLAT;
  if (shortAt === null) return LONG;
  if (longAt === null) return SHORT;
  if (longAt === shortAt) throw new Error(`unreachable: both directions agreed on candle ${longAt}`);
  return longAt > shortAt ? LONG : SHORT;
}

/** Same state as evaluateAgreement, phrased for the journal. */
export function describeAgreement(
  zlTrend: number[],
  macdTrend: number[],
  index: number,
  window = 3,
): string {
  const state = evaluateAgreement(zlTrend, macdTrend, index, window);
  const name = state === LONG ? "LONG" : state === SHORT ? "SHORT" : "FLAT";
  if (!zlTrend.length || !macdTrend.length) return `both=none -> ${name}`;

  const [end, start] = windowBounds(zlTrend, macdTrend, index, window);
  const at =
    state === LONG
      ? latestAgreement(zlTrend, macdTrend, start, end, 1)
      : state === SHORT
        ? latestAgreement(zlTrend, macdTrend, start, end, -1)
        : null;
  if (at === null) return `both=none -> ${name}`;
  const side = state === LONG ? "bull" : "bear";
  return `both=${side}(age=${end - at}) -> ${name}`;
}

function windowBounds(
  zlTrend: number[],
  macdTrend: number[],
  index: number,
  window: number,
): [end: number, start: number] {
  const last = Math.min(zlTrend.length, macdTrend.length) - 1;
  const end = Math.min(index, last);
  const start = Math.max(0, end - window + 1);
  return [end, start];
}

function latestAgreement(
  zlTrend: number[],
  macdTrend: number[],
  start: number,
  end: number,
  direction: 1 | -1,
): number | null {
  for (let i = end; i >= start; i--) {
    if (zlTrend[i] === direction && macdTrend[i] === direction) return i;
  }
  return null;
}
