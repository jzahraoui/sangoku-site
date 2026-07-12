import { cosForward } from './parameterTransform.js';
import { getOptimizedQBounds } from './filterParameterBounds.js';

/**
 * Builds the optimization state: bounds (gain, Q, fc) + cosine-encoded
 * initial parameter vector.
 *
 * Note: caller must initialize zero-gain filters before calling this
 * (via FilterParameterOptimizer._initializeZeroGains), since bounds
 * are sign-locked to the current gain values.
 *
 * @param {Object} params
 * @param {Array<{fc,Q,gain}>} params.filters
 *   Filters may have Q clamped in-place before workingFilters is copied.
 * @param {boolean} params.optimizeQ
 * @param {boolean} params.optimizeFc
 * @param {number}  params.startFreq
 * @param {number}  params.endFreq
 * @param {number}  params.maxCutDb
 * @param {number}  params.maxBoostDb
 * @param {number}  params.maxQ
 * @param {boolean} params.varyQAbove200Hz
 * @param {boolean} params.allowNarrowFiltersBelow200Hz - Modal-narrow cuts below 200 Hz
 * @param {number}  params.gainSignLockThreshold - |gain| above which the sign is locked
 * @returns {state}
 */
export function buildOptimizationState({
  filters,
  optimizeQ,
  optimizeFc,
  startFreq,
  endFreq,
  maxCutDb,
  maxBoostDb,
  maxQ,
  varyQAbove200Hz,
  allowNarrowFiltersBelow200Hz = true,
  gainSignLockThreshold = 0.5,
}) {
  const { gainLowerBounds, gainUpperBounds } = _buildGainBounds(
    filters,
    maxCutDb,
    maxBoostDb,
    gainSignLockThreshold,
  );
  const { qLowerBounds, qUpperBounds } = _buildQBounds(
    filters,
    optimizeQ,
    maxQ,
    varyQAbove200Hz,
    allowNarrowFiltersBelow200Hz,
  );
  const { frequencyLowerBounds, frequencyUpperBounds } = _buildFrequencyBounds(
    filters,
    optimizeFc,
    startFreq,
    endFreq,
  );

  const nG = filters.length;
  const nQ = optimizeQ ? filters.length : 0;
  const nF = optimizeFc ? filters.length : 0;
  const P = nG + nQ + nF;
  const initT = new Array(P);

  // Encode gains with the SAME bounds used by the decoder (sign-locked bounds).
  // This ensures the encode→decode round-trip preserves the initial gain values,
  // giving the optimizer a correct starting point.
  for (let i = 0; i < nG; i++) {
    initT[i] = cosForward(filters[i].gain, gainLowerBounds[i], gainUpperBounds[i]);
  }
  for (let i = 0; i < nQ; i++) {
    initT[nG + i] = cosForward(filters[i].Q, qLowerBounds[i], qUpperBounds[i]);
  }
  for (let i = 0; i < nF; i++) {
    initT[nG + nQ + i] = cosForward(
      filters[i].fc,
      frequencyLowerBounds[i],
      frequencyUpperBounds[i],
    );
  }

  return {
    gainLowerBounds,
    gainUpperBounds,
    qLowerBounds,
    qUpperBounds,
    frequencyLowerBounds,
    frequencyUpperBounds,
    nG,
    nQ,
    nF,
    P,
    initT,
    workingFilters: filters.map(f => ({ fc: f.fc, Q: f.Q, gain: f.gain })),
  };
}

function _buildGainBounds(filters, maxCutDb, maxBoostDb, gainSignLockThreshold) {
  const gainLowerBounds = new Float64Array(filters.length);
  const gainUpperBounds = new Float64Array(filters.length);

  for (let i = 0; i < filters.length; i++) {
    gainLowerBounds[i] = -maxCutDb;
    gainUpperBounds[i] = maxBoostDb;
    if (filters[i].gain < -gainSignLockThreshold) {
      gainUpperBounds[i] = 0;
    } else if (filters[i].gain > gainSignLockThreshold) {
      gainLowerBounds[i] = 0;
    }
  }

  return { gainLowerBounds, gainUpperBounds };
}

function _buildQBounds(
  filters,
  optimizeQ,
  maxQ,
  varyQAbove200Hz,
  allowNarrowFiltersBelow200Hz,
) {
  const qLowerBounds = new Float64Array(filters.length);
  const qUpperBounds = new Float64Array(filters.length);

  if (!optimizeQ) {
    return { qLowerBounds, qUpperBounds };
  }

  for (let i = 0; i < filters.length; i++) {
    const bounds = getOptimizedQBounds({
      fc: filters[i].fc,
      gain: filters[i].gain,
      baseMaxQ: maxQ,
      varyQAbove200Hz,
      allowNarrowFiltersBelow200Hz,
    });
    qLowerBounds[i] = bounds.lo;
    qUpperBounds[i] = bounds.hi;

    let q = filters[i].Q;
    const paddedLo = Math.min(qLowerBounds[i] + 0.1, qUpperBounds[i]);
    const paddedHi = Math.max(qUpperBounds[i] - 0.1, qLowerBounds[i]);
    if (q < paddedLo) q = paddedLo;
    else if (q > paddedHi) q = paddedHi;
    filters[i].Q = Math.max(qLowerBounds[i], Math.min(qUpperBounds[i], q));
  }

  return { qLowerBounds, qUpperBounds };
}

function _buildFrequencyBounds(filters, optimizeFc, startFreq, endFreq) {
  const frequencyLowerBounds = new Float64Array(filters.length);
  const frequencyUpperBounds = new Float64Array(filters.length);

  if (!optimizeFc) {
    return { frequencyLowerBounds, frequencyUpperBounds };
  }

  // Cap at 98% of endFreq to prevent filters from reaching the exact band edge,
  // where peaking filter behavior degrades and spills beyond the measured range.
  const maxFc = endFreq * 0.98;
  for (let i = 0; i < filters.length; i++) {
    frequencyLowerBounds[i] = Math.max(0.75 * filters[i].fc, startFreq);
    frequencyUpperBounds[i] = Math.min(1.3 * filters[i].fc, maxFc);
  }

  return { frequencyLowerBounds, frequencyUpperBounds };
}
