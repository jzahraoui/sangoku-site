import { cosInverse } from './parameterTransform.js';
import { getOptimizedQBounds } from './filterParameterBounds.js';

/**
 * Creates a decoder function that maps the optimization parameter vector `t`
 * back to filter parameters (gain, Q, fc) via the cosine inverse transform.
 *
 * Decode order: fc → gain → Q
 * Q bounds are re-computed from the current fc/gain after each decode step
 * to match the adaptive-Q behavior of REW.
 *
 * @param {Object} params
 * @param {object}  params.state          - optimization state from buildOptimizationState
 * @param {boolean} params.optimizeQ
 * @param {boolean} params.optimizeFc
 * @param {number}  params.maxQ
 * @param {boolean} params.varyQAbove200Hz
 * @param {boolean} [params.allowNarrowFiltersBelow200Hz=true]
 * @returns {(t: number[]) => void}
 */
export function createOptimizationDecoder({
  state,
  optimizeQ,
  optimizeFc,
  maxQ,
  varyQAbove200Hz,
  allowNarrowFiltersBelow200Hz = true,
}) {
  return t => {
    if (optimizeFc) {
      for (let i = 0; i < state.nF; i++) {
        state.workingFilters[i].fc = cosInverse(
          t[state.nG + state.nQ + i],
          state.frequencyLowerBounds[i],
          state.frequencyUpperBounds[i],
        );
      }
    }

    for (let i = 0; i < state.nG; i++) {
      state.workingFilters[i].gain = cosInverse(
        t[i],
        state.gainLowerBounds[i],
        state.gainUpperBounds[i],
      );
    }

    if (optimizeQ) {
      for (let i = 0; i < state.nQ; i++) {
        const bounds = getOptimizedQBounds({
          fc: state.workingFilters[i].fc,
          gain: state.workingFilters[i].gain,
          baseMaxQ: maxQ,
          varyQAbove200Hz,
          allowNarrowFiltersBelow200Hz,
        });
        state.workingFilters[i].Q = cosInverse(t[state.nG + i], bounds.lo, bounds.hi);
      }
    }
  };
}
