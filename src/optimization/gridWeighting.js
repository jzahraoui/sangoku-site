/**
 * gridWeighting.js
 *
 * Frequency-grid weight for FilterParameterOptimizer's MSE computation.
 *
 * Weight formula:
 *   step   = max(|Δ_next|, |Δ_prev|, ε)          — local grid spacing
 *   weight = max(0.5, step) / step                — down-weights dense regions
 *   if fc > 8 kHz: weight *= 1 + 0.5 * min((fc−8000)/12000, 1)   — boost HF
 */

/**
 * Computes the optimization grid weight at a given index in the frequency array.
 *
 * @param {ArrayLike<number>} freqs - Frequency grid (Hz), monotonically increasing
 * @param {number} index            - Index into freqs
 * @returns {number}
 */
export function computeOptimizationGridWeight(freqs, index) {
  const currentFreq = freqs[index];
  const nextFreq = freqs[Math.min(index + 1, freqs.length - 1)];
  const prevFreq = freqs[Math.max(index - 1, 0)];
  const deltaToNext = Math.abs(nextFreq - currentFreq);
  const deltaToPrev = Math.abs(currentFreq - prevFreq);
  const step = Math.max(deltaToNext, deltaToPrev, Number.EPSILON);

  let weight = Math.max(0.5, step) / step;

  if (currentFreq > 8000) {
    weight *= 1 + 0.5 * Math.min((currentFreq - 8000) / 12000, 1);
  }

  return weight;
}
