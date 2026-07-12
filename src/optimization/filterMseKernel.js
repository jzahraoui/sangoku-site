/**
 * filterMseKernel.js
 *
 * Zero-allocation MSE computation kernels for FilterParameterOptimizer.
 *
 * All functions operate on pre-allocated Float64Array buffers passed via
 * the `arrays` object, avoiding per-call heap allocations in the hot path.
 *
 * MSE formula:
 *   f3 = (delta + filtersdB) * w          ← weighted residual
 *   if targetOver > 1: f3 += (targetOver−1)*w*overshootPenaltyWeight  ← soft overshoot penalty
 *   if filtersdB > boostPenaltyThresholdDb: f3 += 10*(filtersdB−boostPenaltyThresholdDb)  ← hard boost cap
 *   return Σ(f3²) / count
 */

const TWO_PI = 2 * Math.PI;
const LN10_OVER_40 = Math.LN10 / 40;
const LOG10_FACTOR = 10 / Math.LN10; // 10*log10(x) = (10/ln10)*ln(x)

/**
 * Pre-computes biquad magnitude-squared coefficients for each active filter
 * into the caller-supplied pre-allocated arrays.
 *
 * @param {object} p
 * @param {Array<{fc:number, Q:number, gain:number}>} p.filters
 * @param {number} p.sampleRate
 * @param {{ aC3: Float64Array, aSum: Float64Array, bC3: Float64Array, bSum: Float64Array, c2: Float64Array }} p.arrays
 * @returns {number} numActive — number of entries written into arrays
 */
export function prepareProfileCoefficients({ filters, sampleRate, arrays }) {
  const twoPiOverSr = TWO_PI / sampleRate;
  const maxFc = sampleRate * 0.4999;
  const { aC3, aSum, bC3, bSum, c2 } = arrays;
  let numActive = 0;

  for (const filter of filters) {
    if (numActive >= c2.length) break;
    if (Math.abs(filter.gain) < 0.001 || filter.Q <= 0) continue;
    const safeFc = Math.max(1e-6, Math.min(filter.fc, maxFc));
    const omega = safeFc * twoPiOverSr;
    const cs = Math.cos(omega);
    const sn = Math.sin(omega);
    const A = Math.exp(LN10_OVER_40 * filter.gain);
    const alpha = sn / (2 * filter.Q);
    const sinHalf = Math.sin(omega / 2);
    const as = 16 * sinHalf * sinHalf * sinHalf * sinHalf;
    const alpha2 = alpha * alpha;
    c2[numActive] = -8 * cs;
    aC3[numActive] = 2 * (1 - alpha2 / (A * A));
    aSum[numActive] = as;
    bC3[numActive] = 2 * (1 - alpha2 * A * A);
    bSum[numActive] = as;
    numActive++;
  }

  return numActive;
}

/**
 * MSE with no active filters — pure baseline residual cost.
 *
 * @param {object} p
 * @param {number}       p.n
 * @param {Float32Array} p.deltas
 * @param {Float32Array} p.weights
 * @returns {number}
 */
export function computeBaseMSE({ n, deltas, weights }) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const weightedDelta = deltas[i] * weights[i];
    sum += weightedDelta * weightedDelta;
  }
  return sum / n;
}

/**
 * MSE with active filters applied, using pre-computed biquad coefficients.
 *
 * @param {object} p
 * @param {number}       p.n
 * @param {number}       p.numActive
 * @param {Float32Array} p.deltas
 * @param {Float32Array} p.weights
 * @param {Float64Array} p.sth
 * @param {Float64Array} p.sth2
 * @param {{ aC3, aSum, bC3, bSum, c2: Float64Array }} p.arrays
 * @param {number}  p.boostPenaltyThresholdDb
 * @param {boolean} p.penalizeTargetOvershoot
 * @param {number}  [p.overshootPenaltyWeight=0.3]
 * @returns {number}
 */
export function computeFilteredMSE({
  n,
  numActive,
  deltas,
  weights,
  sth,
  sth2,
  arrays,
  boostPenaltyThresholdDb,
  penalizeTargetOvershoot,
  overshootPenaltyWeight = 0.3,
}) {
  const { aC3, aSum, bC3, bSum, c2 } = arrays;
  let sum = 0;

  for (let i = 0; i < n; i++) {
    const sth_i = sth[i];
    const sth2_i = sth2[i];
    let mag2 = 1;
    for (let p = 0; p < numActive; p++) {
      const c2s = c2[p] * sth2_i;
      mag2 *= (bSum[p] - (c2s + bC3[p] * sth_i)) / (aSum[p] - (c2s + aC3[p] * sth_i));
    }
    const fdb = mag2 === 1 ? 0 : LOG10_FACTOR * Math.log(Math.max(mag2, 1e-300));
    let f3 = (deltas[i] + fdb) * weights[i];
    if (penalizeTargetOvershoot) {
      const targetOver = deltas[i] + fdb;
      if (targetOver > 1) f3 += (targetOver - 1) * weights[i] * overshootPenaltyWeight;
    }
    const boostOvershoot = fdb - boostPenaltyThresholdDb;
    if (boostOvershoot > 0) f3 += 10 * boostOvershoot;
    sum += f3 * f3;
  }

  return sum / n;
}

/**
 * Like prepareProfileCoefficients but also appends one extra candidate filter.
 *
 * @param {object} p
 * @param {Array<{fc:number, Q:number, gain:number}>} p.filters
 * @param {{fc:number, Q:number, gain:number}} p.candidate
 * @param {number} p.sampleRate
 * @param {{ aC3: Float64Array, aSum: Float64Array, bC3: Float64Array, bSum: Float64Array, c2: Float64Array }} p.arrays
 * @returns {number} numActive — total entries written (filters + candidate)
 */
export function prepareProfileCoefficientsWithCandidate({
  filters,
  candidate,
  sampleRate,
  arrays,
}) {
  if (!candidate) {
    return prepareProfileCoefficients({ filters, sampleRate, arrays });
  }
  return prepareProfileCoefficientsWithCandidateParams({
    filters,
    candidateFc: candidate.fc,
    candidateQ: candidate.Q,
    candidateGain: candidate.gain,
    sampleRate,
    arrays,
  });
}

/**
 * Like prepareProfileCoefficientsWithCandidate but accepts candidate parameters
 * directly to avoid creating an intermediate { fc, Q, gain } object per call.
 *
 * @param {object} p
 * @param {Array<{fc:number, Q:number, gain:number}>} p.filters
 * @param {number} p.candidateFc
 * @param {number} p.candidateQ
 * @param {number} p.candidateGain
 * @param {number} p.sampleRate
 * @param {{ aC3: Float64Array, aSum: Float64Array, bC3: Float64Array, bSum: Float64Array, c2: Float64Array }} p.arrays
 * @returns {number} numActive — total entries written (filters + candidate)
 */
export function prepareProfileCoefficientsWithCandidateParams({
  filters,
  candidateFc,
  candidateQ,
  candidateGain,
  sampleRate,
  arrays,
}) {
  const numFromFilters = prepareProfileCoefficients({ filters, sampleRate, arrays });

  if (Math.abs(candidateGain) < 0.001 || candidateQ <= 0) {
    return numFromFilters;
  }

  if (numFromFilters >= arrays.c2.length) {
    return numFromFilters;
  }

  const twoPiOverSr = TWO_PI / sampleRate;
  const maxFc = sampleRate * 0.4999;
  const { aC3, aSum, bC3, bSum, c2 } = arrays;
  const safeFc = Math.max(1e-6, Math.min(candidateFc, maxFc));
  const omega = safeFc * twoPiOverSr;
  const cs = Math.cos(omega);
  const sn = Math.sin(omega);
  const A = Math.exp(LN10_OVER_40 * candidateGain);
  const alpha = sn / (2 * candidateQ);
  const sinHalf = Math.sin(omega / 2);
  const as = 16 * sinHalf * sinHalf * sinHalf * sinHalf;
  const alpha2 = alpha * alpha;
  const idx = numFromFilters;
  c2[idx] = -8 * cs;
  aC3[idx] = 2 * (1 - alpha2 / (A * A));
  aSum[idx] = as;
  bC3[idx] = 2 * (1 - alpha2 * A * A);
  bSum[idx] = as;
  return numFromFilters + 1;
}
