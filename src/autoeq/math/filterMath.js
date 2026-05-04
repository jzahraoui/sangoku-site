/**
 * filterMath.js
 *
 * Pure math helpers shared across auto-EQ modules.
 * No external dependencies; safe to import anywhere in the pipeline.
 */

/**
 * Upper bound on Q for a boost filter at the given frequency.
 * Above 200 Hz the cap tightens progressively toward 3 at 10 kHz.
 *
 * @param {number}  fc              - Centre frequency (Hz)
 * @param {boolean} varyQAbove200Hz - Enable tighter cap above 200 Hz
 * @returns {number}
 */
export function getBoostQUpperBound(fc, varyQAbove200Hz) {
  const min = Math.min(fc / 6.22, 7.5);
  if (!varyQAbove200Hz) {
    return min;
  }
  if (fc > 10000) {
    return 3;
  }
  if (fc >= 200) {
    return 3 + 4.5 * (1 - Math.log(fc / 200) / Math.log(10000 / 200));
  }
  return min;
}

/**
 * Binary search lower bound: first index i where arr[i] >= value.
 *
 * @param {ArrayLike<number>} arr   - Sorted ascending array
 * @param {number}            value
 * @returns {number}
 */
export function binarySearchLowerBound(arr, value) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Q cap for cut filters, varying by frequency region.
 *
 * @param {number} fc      - Centre frequency (Hz)
 * @param {number} lowCap  - Cap for fc < 200 Hz
 * @param {number} midCap  - Cap for 200 ≤ fc < 3000 Hz
 * @param {number} highCap - Cap for fc ≥ 3000 Hz
 * @returns {number}
 */
export function getCutQCap(fc, lowCap, midCap, highCap) {
  if (fc < 200) {
    return lowCap;
  }
  if (fc < 3000) {
    return midCap;
  }
  return highCap;
}

/**
 * Stride for decimated grid evaluation.
 * Returns 1 when inputs are invalid so callers degrade gracefully.
 *
 * @param {number} sourcePpo    - Points-per-octave of the source grid
 * @param {number} requestedPpo - Desired points-per-octave for evaluation
 * @returns {number} Integer stride ≥ 1
 */
export function getGridStride(sourcePpo, requestedPpo) {
  if (
    !Number.isFinite(sourcePpo) ||
    !Number.isFinite(requestedPpo) ||
    requestedPpo <= 0
  ) {
    return 1;
  }
  return Math.max(1, Math.round(sourcePpo / requestedPpo));
}

export const ADAPTIVE_Q_REFERENCE_FREQUENCY = 200;

/**
 * Upper bound on Q for a cut filter, with frequency-adaptive tightening.
 * Used by FilterParameterOptimizer when varyQAbove200Hz is enabled.
 *
 * @param {number}  fc              - Centre frequency (Hz)
 * @param {boolean} varyQAbove200Hz - Enable adaptive Q cap above 200 Hz
 * @returns {number}
 */
export function getAdaptiveQUpperBound(fc, varyQAbove200Hz) {
  if (!varyQAbove200Hz) {
    return 5; // FIXED_CUT_Q_LIMIT
  }
  if (fc > 10000) {
    return 3;
  }
  if (fc < ADAPTIVE_Q_REFERENCE_FREQUENCY) {
    return 10;
  }
  return (
    3 +
    7 *
      (1 -
        Math.log(fc / ADAPTIVE_Q_REFERENCE_FREQUENCY) /
          Math.log(10000 / ADAPTIVE_Q_REFERENCE_FREQUENCY))
  );
}
