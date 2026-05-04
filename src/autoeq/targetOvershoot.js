/**
 * targetOvershoot.js
 *
 * Detects and reduces above-target overshoot caused by boost filters.
 * Pure functional — no class state; all context passed as parameters.
 */

import {
  createPeakingProfiles,
  sumProfilesDbAtFrequency,
} from '../dsp/peakingProfiles.js';
import { peakMagExact } from '../dsp/peakingMagnitude.js';
import { getGridStride } from './math/filterMath.js';

/**
 * Iteratively reduces above-target overshoot by trimming the most responsible
 * boost filter at each worst-overshoot point.
 * Mutates `filters` in-place.
 *
 * @param {Array<{fc: number, Q: number, gain: number}>} filters
 * @param {Object} calculationContext - GridCalculationContext instance
 * @param {Object} options
 * @param {number}   options.sampleRate
 * @param {Function} [options.onLog]    - Log callback, defaults to no-op
 * @param {boolean}  [options.silent]   - Suppress all log output
 * @param {number}   [options.threshold] - Overshoot threshold in dB (default 1.5)
 */
export function reduceTargetOvershoot(
  filters,
  calculationContext,
  { sampleRate, onLog = () => {}, silent = false, threshold = 1.5 } = {},
) {
  const boostFilters = filters.filter(f => f.gain > 0.5);
  if (boostFilters.length === 0) return;

  let reduced = 0;

  while (true) {
    const worst = _findWorstTargetOvershoot(
      filters,
      calculationContext,
      sampleRate,
      threshold,
    );
    if (!worst) break;

    const adjustment = _findOvershootReduction(boostFilters, worst, sampleRate);
    if (!adjustment) break;

    adjustment.filter.gain -= adjustment.reduction;
    reduced++;
    _logOvershootReduction(adjustment, worst, silent, onLog);
  }

  if (reduced > 0 && !silent) {
    onLog(`  ${reduced} ajustement(s) overshoot`);
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _findWorstTargetOvershoot(filters, calculationContext, sampleRate, threshold) {
  const profiles = createPeakingProfiles(filters, sampleRate);
  const stride = getGridStride(calculationContext.pointsPerOctave, 24);
  let worst = null;

  for (let i = 0; i < calculationContext.scanFreqs.length; i += stride) {
    const freq = calculationContext.scanFreqs[i];
    const corrected =
      calculationContext.measuredArr[i] +
      sumProfilesDbAtFrequency(profiles, freq, sampleRate);
    const overshoot = corrected - calculationContext.targetArr[i];
    if (overshoot > threshold && (!worst || overshoot > worst.overshoot)) {
      worst = { freq, overshoot };
    }
  }

  return worst;
}

function _findOvershootReduction(boostFilters, worst, sampleRate) {
  const responsible = _findMostResponsibleBoost(boostFilters, worst.freq, sampleRate);
  if (!responsible || responsible.influence <= 0.3) {
    return null;
  }
  const reduction = Math.min(worst.overshoot * 0.6, responsible.filter.gain * 0.4);
  return reduction > 0.1 ? { ...responsible, reduction } : null;
}

function _findMostResponsibleBoost(boostFilters, freq, sampleRate) {
  let best = null;
  for (const filter of boostFilters) {
    if (filter.gain <= 0.1) continue;
    const influence = peakMagExact(filter.fc, filter.Q, filter.gain, freq, sampleRate);
    if (!best || influence > best.influence) {
      best = { filter, influence };
    }
  }
  return best;
}

function _logOvershootReduction(adjustment, worst, silent, onLog) {
  if (silent) return;
  onLog(
    `  Overshoot réduit: fc=${adjustment.filter.fc.toFixed(0)} Hz  -${adjustment.reduction.toFixed(2)} dB (${worst.overshoot.toFixed(1)} dB @ ${worst.freq.toFixed(0)} Hz)`,
  );
}
