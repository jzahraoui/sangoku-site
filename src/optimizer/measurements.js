import Scorer from './scoring.js';
import { EMPTY_CONFIG } from './config.js';
import { validateMatchingFrequencyGrid } from './response.js';

export function prepareMeasurements(optimizer) {
  const freqRangeStart = optimizer.config.frequency.min;
  const freqRangeEnd = optimizer.config.frequency.max;

  const preparedSubs = optimizer.subMeasurements.map(frequencyResponse => {
    const freqs = frequencyResponse.freqs;
    const len = freqs.length;
    const startIdx = findFirstFrequencyIndex(freqs, freqRangeStart);
    const endIdx = findFirstFrequencyAboveIndex(freqs, freqRangeEnd, startIdx, len);
    const validCount = endIdx - startIdx;
    const filteredFreqs = freqs.slice(startIdx, endIdx);

    return {
      ...frequencyResponse,
      freqs: filteredFreqs,
      magnitude: frequencyResponse.magnitude.slice(startIdx, endIdx),
      phase: frequencyResponse.phase.slice(startIdx, endIdx),
      startFreq: filteredFreqs[0],
      endFreq: filteredFreqs[validCount - 1],
      param: EMPTY_CONFIG,
    };
  });

  validatePreparedFrequencyGrid(preparedSubs);
  calculateFrequencyWeights(optimizer, preparedSubs[0].freqs);

  const targetCurve = optimizer.config.optimization.targetCurve;
  if (targetCurve) {
    optimizer.targetMagnitude = clampTargetToTheoreticalCeiling(
      optimizer,
      resampleCurveToGrid(targetCurve, preparedSubs[0].freqs),
      preparedSubs,
    );
  }

  return preparedSubs;
}

/**
 * Caps the effective target at the theoretical ceiling (coherent sum of the
 * raw magnitudes). The requested target is anchored for the SUM of N subs;
 * wherever fewer subs carry the signal (low-end extension, band edges,
 * geometrically incoherent zones) it exceeds what any solution can reach —
 * and the asymmetric below-target cost would endlessly pull boost onto the
 * remaining sub(s) chasing it. Above-ceiling bins are structurally
 * unreachable: clamping them makes the optimizer spend its levers where
 * they can actually win.
 */
function clampTargetToTheoreticalCeiling(optimizer, targetMagnitude, preparedSubs) {
  const size = targetMagnitude.length;
  let clampedCount = 0;

  for (let i = 0; i < size; i++) {
    let linearSum = 0;
    for (const sub of preparedSubs) {
      linearSum += Math.pow(10, sub.magnitude[i] / 20);
    }
    const ceilingDb = 20 * Math.log10(Math.max(linearSum, Number.EPSILON));
    if (targetMagnitude[i] > ceilingDb) {
      targetMagnitude[i] = ceilingDb;
      clampedCount++;
    }
  }

  if (clampedCount > 0) {
    optimizer.lm.info(
      `Target clamped to the theoretical ceiling on ${clampedCount}/${size} bins ` +
        `(requested target unreachable there)`,
    );
  }
  return targetMagnitude;
}

/**
 * Resamples a {freqs, magnitude} curve onto the optimization grid by linear
 * interpolation on log-frequency (flat extrapolation beyond the curve ends).
 * Used for the target curve of the 'target-match' objective; the curve may
 * come from an arbitrary grid (REW target, house curve).
 */
export function resampleCurveToGrid(curve, gridFreqs) {
  const { freqs, magnitude } = curve;
  if (!freqs?.length || freqs.length !== magnitude.length) {
    throw new Error('Curve must provide matching freqs and magnitude arrays');
  }

  const out = new Float64Array(gridFreqs.length);
  let j = 0;
  for (let i = 0; i < gridFreqs.length; i++) {
    const f = gridFreqs[i];
    if (f <= freqs[0]) {
      out[i] = magnitude[0];
      continue;
    }
    if (f >= freqs[freqs.length - 1]) {
      out[i] = magnitude[freqs.length - 1];
      continue;
    }
    while (freqs[j + 1] < f) j++;
    const t = Math.log(f / freqs[j]) / Math.log(freqs[j + 1] / freqs[j]);
    out[i] = magnitude[j] + t * (magnitude[j + 1] - magnitude[j]);
  }
  return out;
}

function findFirstFrequencyIndex(freqs, freqRangeStart) {
  let lo = 0;
  let hi = freqs.length;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (freqs[mid] < freqRangeStart) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

function findFirstFrequencyAboveIndex(freqs, freqRangeEnd, startIdx, len) {
  let lo = startIdx;
  let hi = len;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (freqs[mid] <= freqRangeEnd) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

function validatePreparedFrequencyGrid(preparedSubs) {
  if (preparedSubs[0].freqs.length === 0) {
    throw new Error('Frequency response arrays cannot be empty');
  }

  validateMatchingFrequencyGrid(preparedSubs);
}

export function calculateFrequencyWeights(optimizer, frequencies) {
  const weights = Scorer.buildWeights(frequencies);
  optimizer.frequencyWeights = weights;
  optimizer._scorer = new Scorer(weights);
  return weights;
}
