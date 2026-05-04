/**
 * candidateFilter.js
 *
 * Converts a detected correction span into an initial peaking filter candidate.
 * Pure function — all runtime context is passed explicitly.
 */
import { getFilteredSPLAt } from './residuals.js';
import { getBoostQUpperBound } from './math/filterMath.js';

export function buildCandidateFilter(
  span,
  calculationContext,
  existingFilters,
  { sampleRate, matchRangeStart, matchRangeEnd, varyQAbove200Hz, equalizerAdapter },
) {
  const { spanStart, spanEnd, peakFreq, peakVal, sumDelta } = span;
  const geoMean = Math.sqrt(spanStart * spanEnd);

  let fc = geoMean;

  if (peakFreq < 200) {
    fc = peakFreq;
  } else if (sumDelta > 0) {
    const peakFiltered = getFilteredSPLAt(
      peakFreq,
      calculationContext,
      existingFilters,
      sampleRate,
    );
    const geoFiltered = getFilteredSPLAt(
      geoMean,
      calculationContext,
      existingFilters,
      sampleRate,
    );

    fc = peakFiltered - geoFiltered > peakVal / 2 ? peakFreq : geoMean;
  }

  fc = equalizerAdapter.quantizeFrequency(
    Math.max(matchRangeStart, Math.min(matchRangeEnd, fc)),
  );

  const distToEdge = Math.max(Math.min(fc - spanStart, spanEnd - fc), 0);
  let Q = distToEdge > 0 ? fc / distToEdge : fc / Math.max((spanEnd - spanStart) / 2, 1);

  if (sumDelta <= 0) {
    Q = Math.min(Q, getBoostQUpperBound(fc, varyQAbove200Hz));
  }

  return { fc, Q: Math.max(1, Q) };
}
