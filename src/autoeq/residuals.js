/**
 * residuals.js
 *
 * Computes the residual error between the filtered measured response and the
 * target curve. Pure functions — no class state; sampleRate passed explicitly.
 */

import {
  createPeakingProfiles,
  sumProfilesDbAtFrequency,
} from '../dsp/peakingProfiles.js';

/**
 * Builds a Float64Array of residuals (filteredSPL − target) at each scan point.
 *
 * @param {ArrayLike<number>} scanFreqs
 * @param {ArrayLike<number>} measuredArr
 * @param {ArrayLike<number>} targetArr
 * @param {Array<{fc:number,Q:number,gain:number}>} filters
 * @param {number} sampleRate
 * @returns {Float64Array}
 */
export function buildResiduals(scanFreqs, measuredArr, targetArr, filters, sampleRate) {
  const residuals = new Float64Array(scanFreqs.length);
  const profiles = createPeakingProfiles(filters, sampleRate);

  for (let i = 0; i < scanFreqs.length; i++) {
    const filteredSPL =
      measuredArr[i] + sumProfilesDbAtFrequency(profiles, scanFreqs[i], sampleRate);
    residuals[i] = filteredSPL - targetArr[i];
  }

  return residuals;
}

/**
 * Returns the filtered SPL (dB) at a single frequency, using the
 * `measuredFn` from calculationContext plus the combined filter response.
 *
 * @param {number} freq
 * @param {Object} calculationContext - must expose `.measuredFn(freq)`
 * @param {Array<{fc:number,Q:number,gain:number}>} filters
 * @param {number} sampleRate
 * @returns {number}
 */
export function getFilteredSPLAt(freq, calculationContext, filters, sampleRate) {
  const profiles = createPeakingProfiles(filters, sampleRate);
  return (
    calculationContext.measuredFn(freq) +
    sumProfilesDbAtFrequency(profiles, freq, sampleRate)
  );
}
