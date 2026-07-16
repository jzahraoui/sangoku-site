/**
 * candidateFilter.js
 *
 * Converts a detected correction span into an initial peaking filter candidate.
 * Pure function — all runtime context is passed explicitly.
 */
import { getFilteredSPLAt } from './residuals.js';
import { getBoostQUpperBound } from './math/filterMath.js';
import { seedQFromPeakWidth } from './math/modalAnalyzer.js';

/**
 * Picks the modal seed applicable to a span: cut spans only (all-pole modes
 * are positive peaks), peak inside the seeding band, nearest detected mode
 * lying within the span.
 *
 * @returns {{fc:number}|null}
 */
function pickModalSeed(span, modalSeeds) {
  if (!modalSeeds || span.sumDelta <= 0) return null;
  if (span.peakFreq > modalSeeds.maxFreq) return null;
  const snapOctaves = modalSeeds.snapOctaves ?? 1 / 6;
  let best = null;
  let bestDist = Infinity;
  for (const mode of modalSeeds.modes) {
    if (mode.fc < span.spanStart || mode.fc > span.spanEnd) continue;
    const dist = Math.abs(Math.log2(mode.fc / span.peakFreq));
    if (dist <= snapOctaves && dist < bestDist) {
      best = mode;
      bestDist = dist;
    }
  }
  return best;
}

export function buildCandidateFilter(
  span,
  calculationContext,
  existingFilters,
  {
    sampleRate,
    matchRangeStart,
    matchRangeEnd,
    varyQAbove200Hz,
    equalizerAdapter,
    modalSeeds = null,
    scanFreqs = null,
    residuals = null,
  },
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

  // Modal seeding (opt-in): snap fc to the detected mode inside the span and
  // seed Q from the measured peak width on the current residual.
  const modalSeed = pickModalSeed(span, modalSeeds);
  let modalQ = null;
  if (modalSeed && scanFreqs && residuals) {
    if (modalSeeds.applyFc !== false) {
      fc = modalSeed.fc;
    }
    if (modalSeeds.applyQ !== false) {
      modalQ = seedQFromPeakWidth({
        freqs: scanFreqs,
        residuals,
        fc: modalSeed.fc,
        minFreq: modalSeeds.minFreq,
        maxFreq: modalSeeds.maxFreq,
      });
    }
  }

  fc = equalizerAdapter.quantizeFrequency(
    Math.max(matchRangeStart, Math.min(matchRangeEnd, fc)),
  );

  const distToEdge = Math.max(Math.min(fc - spanStart, spanEnd - fc), 0);
  let Q = distToEdge > 0 ? fc / distToEdge : fc / Math.max((spanEnd - spanStart) / 2, 1);

  if (modalQ !== null) {
    Q = modalQ;
  }

  if (sumDelta <= 0) {
    Q = Math.min(Q, getBoostQUpperBound(fc, varyQAbove200Hz));
  }

  return { fc, Q: Math.max(1, Q) };
}
