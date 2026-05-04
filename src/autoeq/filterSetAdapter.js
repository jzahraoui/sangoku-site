/**
 * filterSetAdapter.js
 *
 * Applies a computed filter array to a BiquadFilter-based FilterSet.
 * Pure function — no class state; all context passed as parameters.
 */

/**
 * Writes `filters` into `filterSet`, applying equalizer quantization and
 * frequency clamping. Excess filterSet slots are reset.
 *
 * @param {Object}   filterSet          - FilterSet instance (resetAll, filters[])
 * @param {Array<{fc:number,Q:number,gain:number}>} filters
 * @param {Object}   options
 * @param {Object}   options.equalizerAdapter  - EqualizerAdapter instance
 * @param {number}   options.matchRangeStart   - Minimum allowed fc (Hz)
 * @param {number}   options.sampleRate        - Sample rate (Hz)
 */
export function applyFiltersToFilterSet(
  filterSet,
  filters,
  { equalizerAdapter, matchRangeStart, sampleRate },
) {
  filterSet.resetAll();

  const maxIdx = Math.min(filters.length, filterSet.filters.length);
  for (let i = 0; i < maxIdx; i++) {
    const target = filterSet.filters[i];
    const source = { ...filters[i] };

    equalizerAdapter.adaptFilter(source);

    target.fc = Math.max(matchRangeStart, Math.min(sampleRate * 0.45, source.fc));
    target.Q = source.Q;
    target.gain = source.gain;
    target.filterType = 'PEAKING';
    target.enabled = true;
    target.calcBiquad();
  }
}
