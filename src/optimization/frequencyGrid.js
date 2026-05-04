import { computeOptimizationGridWeight } from './gridWeighting.js';

const TWO_PI = 2 * Math.PI;

/**
 * Builds the optimization frequency grid from raw measurement data.
 *
 * Filters frequencies to the active spans (or [startFreq, endFreq] if no spans),
 * computes per-point weights and residuals, then pre-computes the sTh/sTh2
 * biquad trig coefficients. Also produces a stride-2 decimated copy used by
 * optimizeGainAndQ() to halve inner-loop cost.
 *
 * @param {Object} params
 * @param {ArrayLike<number>} params.freqs
 * @param {ArrayLike<number>} params.measuredMagnitude
 * @param {ArrayLike<number>} params.targetMagnitude
 * @param {Array<{start:number,end:number}>|null} params.spans
 * @param {number} params.startFreq
 * @param {number} params.endFreq
 * @param {number} params.sampleRate
 * @returns {{ freqs, weights, deltas, sth, sth2, numPoints,
 *             decNumPoints, decDeltas, decWeights, decSth, decSth2 }}
 */
export function buildOptimizationFrequencyGrid({
  freqs,
  measuredMagnitude,
  targetMagnitude,
  spans,
  startFreq,
  endFreq,
  sampleRate,
}) {
  const freqsList = [];
  const weightsList = [];
  const deltasList = [];

  for (let i = 0; i < freqs.length; i++) {
    const freq = freqs[i];
    if (!_isFrequencyWithinSpans(freq, spans, startFreq, endFreq)) {
      continue;
    }
    freqsList.push(freq);
    weightsList.push(computeOptimizationGridWeight(freqs, i));
    deltasList.push(measuredMagnitude[i] - targetMagnitude[i]);
  }

  const numPoints = freqsList.length;
  const outFreqs = new Float32Array(freqsList);
  const weights = new Float32Array(weightsList);
  const deltas = new Float32Array(deltasList);

  const sth = new Float64Array(numPoints);
  const sth2 = new Float64Array(numPoints);
  const freqNorm = TWO_PI / sampleRate;
  for (let i = 0; i < numPoints; i++) {
    const omega = outFreqs[i] * freqNorm;
    const sinOmega = Math.sin(omega);
    sth[i] = 2 * sinOmega * sinOmega;
    const sinHalf = Math.sin(omega / 2);
    sth2[i] = 2 * sinHalf * sinHalf;
  }

  const stride = 2;
  const decNumPoints = Math.ceil(numPoints / stride);
  const decDeltas = new Float32Array(decNumPoints);
  const decWeights = new Float32Array(decNumPoints);
  const decSth = new Float64Array(decNumPoints);
  const decSth2 = new Float64Array(decNumPoints);
  for (let i = 0, j = 0; j < numPoints; i++, j += stride) {
    decDeltas[i] = deltas[j];
    decWeights[i] = weights[j];
    decSth[i] = sth[j];
    decSth2[i] = sth2[j];
  }

  return {
    freqs: outFreqs,
    weights,
    deltas,
    sth,
    sth2,
    numPoints,
    decNumPoints,
    decDeltas,
    decWeights,
    decSth,
    decSth2,
  };
}

function _isFrequencyWithinSpans(freq, spans, startFreq, endFreq) {
  if (!spans?.length) {
    return freq >= startFreq && freq <= endFreq;
  }
  return spans.some(span => freq >= span.start && freq <= span.end);
}
