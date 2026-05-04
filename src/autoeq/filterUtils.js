/**
 * filterUtils.js
 *
 * Pure utility functions for working with filter arrays.
 * No external dependencies; safe to import anywhere in the pipeline.
 */

/**
 * Returns a shallow clone of each filter's `{fc, Q, gain}` properties.
 *
 * @param {Array<{fc: number, Q: number, gain: number}>} filters
 * @returns {Array<{fc: number, Q: number, gain: number}>}
 */
export function cloneFilters(filters) {
  return filters.map(filter => ({
    fc: filter.fc,
    Q: filter.Q,
    gain: filter.gain,
  }));
}

/**
 * Replaces the contents of `targetFilters` in-place with clones of `sourceFilters`.
 *
 * @param {Array<{fc: number, Q: number, gain: number}>} targetFilters - Modified in-place.
 * @param {Array<{fc: number, Q: number, gain: number}>} sourceFilters
 */
export function replaceFilters(targetFilters, sourceFilters) {
  targetFilters.splice(0, targetFilters.length, ...cloneFilters(sourceFilters));
}

/**
 * Removes filters whose absolute gain is at or below `threshold`.
 * Mutates `filters` in-place.
 *
 * @param {Array<{fc: number, Q: number, gain: number}>} filters - Modified in-place.
 * @param {number} threshold
 * @returns {{ removedCount: number, maxRemovedGain: number }}
 */
export function removeWeakFilters(filters, threshold) {
  let removedCount = 0;
  let maxRemovedGain = 0;
  for (let i = filters.length - 1; i >= 0; i--) {
    const absGain = Math.abs(filters[i].gain);
    if (absGain <= threshold) {
      maxRemovedGain = Math.max(maxRemovedGain, absGain);
      filters.splice(i, 1);
      removedCount++;
    }
  }
  return { removedCount, maxRemovedGain };
}

/**
 * Computes the merged bandwidth spans covered by a set of peaking filters,
 * clipped to [rangeStart, rangeEnd].
 * Falls back to a single full-range span when no filter covers the range.
 *
 * @param {Array<{fc: number, Q: number, gain: number}>} filters
 * @param {number} rangeStart - Lower frequency bound (Hz)
 * @param {number} rangeEnd   - Upper frequency bound (Hz)
 * @returns {Array<{start: number, end: number}>}
 */
export function getFilterBandwidthSpans(filters, rangeStart, rangeEnd) {
  const spans = [];
  for (const f of filters) {
    const safeQ = Math.min(f.Q, 20);
    const inv2Q = 1 / (2 * safeQ);
    const freqHi = f.fc * (inv2Q + Math.sqrt(1 + inv2Q * inv2Q));
    const freqLo = (f.fc * f.fc) / freqHi;
    spans.push({
      start: Math.max(rangeStart, freqLo),
      end: Math.min(rangeEnd, freqHi),
    });
  }
  spans.sort((a, b) => a.start - b.start);

  const merged = [];
  for (const s of spans) {
    if (s.start >= s.end) continue;
    const last = merged.length > 0 ? merged.at(-1) : null;
    if (!last || s.start > last.end) {
      merged.push({ start: s.start, end: s.end });
    } else {
      last.end = Math.max(last.end, s.end);
    }
  }
  return merged.length > 0 ? merged : [{ start: rangeStart, end: rangeEnd }];
}
