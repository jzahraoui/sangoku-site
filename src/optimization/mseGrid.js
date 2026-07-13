/**
 * mseGrid.js
 *
 * Construction de la grille MSE pondérée pour FastMSE.
 * Logique extraite de FastMSE.initFromGrid().
 */

/**
 * Construit la grille MSE à partir d'une grille fréquentielle brute.
 *
 * @param {object} p
 * @param {Array<{start: number, end: number}>} p.spans
 * @param {ArrayLike<number>} p.freqs
 * @param {ArrayLike<number>} p.measuredMagnitude
 * @param {ArrayLike<number>} p.targetMagnitude
 * @param {number} p.sampleRate
 * @returns {{ freqs: Float32Array, weights: Float32Array, deltas: Float64Array, sth: Float64Array, sth2: Float64Array, count: number }}
 */
export function buildMseGrid({
  spans,
  freqs,
  measuredMagnitude,
  targetMagnitude,
  sampleRate,
}) {
  const freqsList = [];
  const weightsList = [];
  const deltasList = [];

  for (let i = 0; i < freqs.length; i++) {
    const freq = freqs[i];
    if (!_isFrequencyWithinSpans(freq, spans)) continue;

    freqsList.push(freq);
    weightsList.push(_computeMseGridWeight(freqs, i));
    deltasList.push(measuredMagnitude[i] - targetMagnitude[i]);
  }

  const count = freqsList.length;
  const freqsArr = new Float32Array(freqsList);
  const weights = new Float32Array(weightsList);
  // Résidu minimisé (mesuré − cible) : gardé en float64, aucun arrondi f32
  // intermédiaire avant le noyau MSE (filterMseKernel).
  const deltas = new Float64Array(deltasList);
  const sth = new Float64Array(count);
  const sth2 = new Float64Array(count);

  const freqNorm = (2 * Math.PI) / sampleRate;
  for (let i = 0; i < count; i++) {
    const omega = freqsArr[i] * freqNorm;
    const sinOmega = Math.sin(omega);
    sth[i] = 2 * sinOmega * sinOmega;
    const sinHalf = Math.sin(omega / 2);
    sth2[i] = 2 * sinHalf * sinHalf;
  }

  return { freqs: freqsArr, weights, deltas, sth, sth2, count };
}

function _isFrequencyWithinSpans(freq, spans) {
  if (!spans?.length) return false;
  return spans.some(span => freq >= span.start && freq <= span.end);
}

function _computeMseGridWeight(freqs, index) {
  const currentFreq = freqs[index];
  const nextFreq = freqs[Math.min(index + 1, freqs.length - 1)];
  const prevFreq = freqs[Math.max(index - 1, 0)];
  const deltaToNext = Math.abs(nextFreq - currentFreq);
  const deltaToPrev = Math.abs(currentFreq - prevFreq);
  const step = Math.max(deltaToNext, deltaToPrev, Number.EPSILON);
  return Math.max(0.5, step) / step;
}
