/**
 * perceptualRegularizer.js
 *
 * Applies perceptual Q and gain regularization to a filter set.
 * Pure functional — no class state; all context passed as parameters.
 */

import { cloneFilters } from './filterUtils.js';
import { getBoostQUpperBound, getCutQCap } from './math/filterMath.js';

/**
 * Returns a cloned, regularized copy of `filters` with quantization applied.
 * Mutates nothing in the input array.
 *
 * @param {Array<{fc: number, Q: number, gain: number}>} filters
 * @param {Object} options
 * @param {boolean}  options.varyQAbove200Hz
 * @param {Object}   options.equalizerAdapter - EqualizerAdapter instance
 * @returns {{ filters: Array, changed: boolean }}
 */
export function buildPerceptualRegularizedFilters(
  filters,
  { varyQAbove200Hz, equalizerAdapter },
) {
  const regularizedFilters = cloneFilters(filters);
  let changed = false;

  for (let index = 0; index < regularizedFilters.length; index++) {
    const result = regularizeFilterForPerception(
      regularizedFilters[index],
      varyQAbove200Hz,
    );
    regularizedFilters[index] = result.filter;
    changed = changed || result.changed;
  }

  equalizerAdapter.adaptFilters(regularizedFilters);
  return { filters: regularizedFilters, changed };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function regularizeFilterForPerception(filter, varyQAbove200Hz) {
  if (Math.abs(filter.gain) < 0.1) {
    return { filter, changed: false };
  }
  return filter.gain > 0
    ? regularizeBoostFilter(filter, varyQAbove200Hz)
    : regularizeCutFilter(filter);
}

function regularizeBoostFilter(filter, varyQAbove200Hz) {
  const regularized = { ...filter };
  let changed = false;

  const boostQCap = getBoostQUpperBound(regularized.fc, varyQAbove200Hz);
  if (regularized.Q > boostQCap) {
    regularized.Q = boostQCap;
    changed = true;
  }
  if (regularized.fc > 3000 && regularized.gain > 2.5) {
    regularized.gain *= 0.9;
    changed = true;
  }
  return { filter: regularized, changed };
}

function regularizeCutFilter(filter) {
  const regularized = { ...filter };
  const cutQCap = getCutQCap(regularized.fc, 12, 10, 6);
  if (regularized.Q <= cutQCap) {
    return { filter: regularized, changed: false };
  }
  regularized.Q = cutQCap;
  return { filter: regularized, changed: true };
}
