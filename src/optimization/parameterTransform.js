/**
 * parameterTransform.js
 *
 * Cosine-domain parameter transform used by FilterParameterOptimizer.
 *
 * Forward (x → t):  t = acos((2x − lo − hi) / (hi − lo))   range [lo,hi] → [0,π]
 * Inverse (t → x):  x = (lo+hi)/2 + (hi−lo)*cos(t)/2        range [0,π]  → [lo,hi]
 *
 * Maps a bounded scalar parameter into an unconstrained angular domain so that
 * a gradient optimizer can step freely without hitting bound constraints.
 */

const PI = Math.PI;

/**
 * Maps x ∈ [lo, hi] to t ∈ [0, π].
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function cosForward(x, lo, hi) {
  if (lo >= hi) return PI / 2;
  const cx = Math.max(lo, Math.min(hi, x));
  return Math.acos(Math.max(-1, Math.min(1, (2 * cx - lo - hi) / (hi - lo))));
}

/**
 * Maps t ∈ [0, π] back to x ∈ [lo, hi].
 * @param {number} t
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function cosInverse(t, lo, hi) {
  return (lo + hi) / 2 + ((hi - lo) * Math.cos(t)) / 2;
}
