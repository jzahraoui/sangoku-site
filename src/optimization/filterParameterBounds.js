/**
 * filterParameterBounds.js
 *
 * Computes the [lo, hi] Q bounds for a peaking filter during optimization.
 *
 * The bound logic reproduces REW's frequency-dependent Q capping:
 *   - Below 200 Hz: tighter range to avoid very narrow low-frequency cuts
 *   - Above 200 Hz with varyQAbove200Hz: adaptive cap from filterMath
 *   - Boost filters: additional cap via getBoostQUpperBound
 */

import {
  ADAPTIVE_Q_REFERENCE_FREQUENCY,
  getBoostQUpperBound,
  getAdaptiveQUpperBound,
} from '../autoeq/math/filterMath.js';

const MINIMUM_OPTIMIZED_Q = 1;

/**
 * Returns the [lo, hi] Q bounds for optimizing a single filter.
 *
 * @param {object} p
 * @param {number}  p.fc              - Centre frequency (Hz)
 * @param {number}  p.gain            - Current gain (dB)
 * @param {number}  p.baseMaxQ        - Maximum Q from optimizer config
 * @param {boolean} p.varyQAbove200Hz - Enable adaptive Q cap above 200 Hz
 * @returns {{ lo: number, hi: number }}
 */
export function getOptimizedQBounds({ fc, gain, baseMaxQ, varyQAbove200Hz }) {
  let lo = MINIMUM_OPTIMIZED_Q;
  let hi = baseMaxQ;

  if (!varyQAbove200Hz) {
    hi = Math.min(hi, 8);
  } else if (fc >= ADAPTIVE_Q_REFERENCE_FREQUENCY) {
    hi = Math.min(hi, getAdaptiveQUpperBound(fc, varyQAbove200Hz));
  } else {
    hi = Math.min(hi, fc / 2);
    lo = Math.min(2, hi - 0.1);
  }

  if (gain > 0) {
    hi = Math.min(baseMaxQ, getBoostQUpperBound(fc, varyQAbove200Hz));
  }

  if (!Number.isFinite(lo)) lo = MINIMUM_OPTIMIZED_Q;
  if (!Number.isFinite(hi)) hi = baseMaxQ;

  if (hi < lo) {
    const safeLo = Math.max(0.1, Math.min(lo, hi));
    return { lo: safeLo, hi: safeLo };
  }

  return { lo, hi };
}
