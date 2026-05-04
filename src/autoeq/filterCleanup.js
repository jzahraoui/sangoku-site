/**
 * filterCleanup.js
 *
 * Final post-optimization filter cleanup.
 * Removes dead filters (near-zero gain or upper-edge boost artefacts).
 * Pure function — mutates `filters` in-place by design (same contract as
 * the inline loop it replaces).
 */

/**
 * Removes filters whose gain is effectively zero or that sit at the upper
 * edge of the matching range and produce no useful correction.
 * Iterates in reverse so splicing does not affect unvisited indices.
 *
 * @param {Array<{fc: number, Q: number, gain: number}>} filters - Mutated in-place
 * @param {Object}   options
 * @param {Object}   options.equalizerAdapter  - EqualizerAdapter instance
 * @param {number}   options.matchRangeEnd     - Upper boundary of matching range (Hz)
 * @returns {{ removedCount: number }}
 */
export function removeFinalDeadFilters(filters, { equalizerAdapter, matchRangeEnd }) {
  const maxAllowedFc = matchRangeEnd * 0.98;
  let removedCount = 0;

  for (let i = filters.length - 1; i >= 0; i--) {
    if (
      Math.abs(filters[i].gain) < 0.1 ||
      equalizerAdapter.isUpperEdgeBoost(filters[i], maxAllowedFc)
    ) {
      filters.splice(i, 1);
      removedCount++;
    }
  }

  return { removedCount };
}
