/**
 * filterParameterBounds.js
 *
 * Computes the [lo, hi] Q bounds for a peaking filter during optimization.
 *
 * The bound logic reproduces REW's frequency-dependent Q capping, driven by
 * two independent flags (REW preferences, see C0416F.m1762A and UA.java):
 *   - allowNarrowFiltersBelow200Hz (REW `usemodaleq`, default TRUE): below
 *     200 Hz cuts may be modal-narrow (up to fc/2); above 200 Hz cuts follow
 *     the cut-Q law. When false, cuts are capped at 5 everywhere.
 *   - varyQAbove200Hz (REW `varyqabovemodal`, default FALSE): switches the
 *     boost/cut caps to their logarithmic frequency-dependent laws.
 *   - Boost filters: additional cap via getBoostQUpperBound
 *   - User per-band caps (lowBandMaxQ / highBandMaxQ, 0 = off): tighten the
 *     upper bound on top of the REW laws, below 200 Hz and from
 *     highBandStartFreq (default 3 kHz) up.
 */

import {
  ADAPTIVE_Q_REFERENCE_FREQUENCY,
  getBoostQUpperBound,
  getAdaptiveQUpperBound,
} from '../autoeq/math/filterMath.js';

const MINIMUM_OPTIMIZED_Q = 1;
const FIXED_CUT_Q_LIMIT = 5;
// Default start of the "high" band for the user Q cap (qRisk band split).
export const DEFAULT_USER_HIGH_BAND_START_FREQUENCY = 3000;

function getUserBandQCap(fc, lowBandMaxQ, highBandMaxQ, highBandStartFreq) {
  if (fc < ADAPTIVE_Q_REFERENCE_FREQUENCY) {
    return lowBandMaxQ;
  }
  if (fc >= highBandStartFreq) {
    return highBandMaxQ;
  }
  return 0;
}

/**
 * Returns the [lo, hi] Q bounds for optimizing a single filter.
 *
 * @param {object} p
 * @param {number}  p.fc              - Centre frequency (Hz)
 * @param {number}  p.gain            - Current gain (dB)
 * @param {number}  p.baseMaxQ        - Maximum Q from optimizer config
 * @param {boolean} p.varyQAbove200Hz - Frequency-varying caps above 200 Hz
 * @param {boolean} [p.allowNarrowFiltersBelow200Hz=true] - Modal-narrow cuts below 200 Hz
 * @param {number}  [p.lowBandMaxQ=0]  - User Q cap below 200 Hz (0 = off)
 * @param {number}  [p.highBandMaxQ=0] - User Q cap in the high band (0 = off)
 * @param {number}  [p.highBandStartFreq=3000] - Start of the high band (Hz)
 * @returns {{ lo: number, hi: number }}
 */
export function getOptimizedQBounds({
  fc,
  gain,
  baseMaxQ,
  varyQAbove200Hz,
  allowNarrowFiltersBelow200Hz = true,
  lowBandMaxQ = 0,
  highBandMaxQ = 0,
  highBandStartFreq = DEFAULT_USER_HIGH_BAND_START_FREQUENCY,
}) {
  let lo = MINIMUM_OPTIMIZED_Q;
  let hi = baseMaxQ;

  if (!allowNarrowFiltersBelow200Hz) {
    hi = Math.min(hi, FIXED_CUT_Q_LIMIT);
  } else if (fc >= ADAPTIVE_Q_REFERENCE_FREQUENCY) {
    hi = Math.min(hi, getAdaptiveQUpperBound(fc, varyQAbove200Hz));
  } else {
    hi = Math.min(hi, fc / 2);
    lo = Math.min(2, hi - 0.1);
  }

  if (gain > 0) {
    hi = Math.min(baseMaxQ, getBoostQUpperBound(fc, varyQAbove200Hz));
  }

  const userBandCap = getUserBandQCap(fc, lowBandMaxQ, highBandMaxQ, highBandStartFreq);
  if (userBandCap > 0) {
    hi = Math.min(hi, userBandCap);
  }

  if (!Number.isFinite(lo)) lo = MINIMUM_OPTIMIZED_Q;
  if (!Number.isFinite(hi)) hi = baseMaxQ;

  if (hi < lo) {
    const safeLo = Math.max(0.1, Math.min(lo, hi));
    return { lo: safeLo, hi: safeLo };
  }

  return { lo, hi };
}
