/**
 * placementCandidateSelector.js
 *
 * Finds the best filter candidate across active placement spans.
 * Evaluates each span, builds a candidate peaking filter, optionally
 * runs a per-candidate optimizer pass, and returns the best-quality placement.
 */

import { buildCandidateFilter } from './candidateFilter.js';
import { cloneFilters, getFilterBandwidthSpans } from './filterUtils.js';
import { initializeOptimizer } from './optimizerRunner.js';
import { selectActivePlacementSpans } from './placementSpanSelection.js';

export async function selectPlacementCandidate({
  scanFreqs,
  residuals,
  filters,
  calculationContext,
  placementOptimizer,
  useCandidatePlacement,
  config,
  spanFinder,
  qualityEvaluator,
  equalizerAdapter,
}) {
  const candidateLimit = useCandidatePlacement ? config.placementCandidateCount : 1;
  const spans = spanFinder.findCandidateSpans(
    scanFreqs,
    residuals,
    filters,
    candidateLimit,
  );
  if (spans.length === 0) return null;

  // Adaptive pruning: skip secondary candidates whose priority is dominated
  // by the top candidate. This avoids running the full optimizer for spans that are
  // unlikely to win, which is the main placement bottleneck.
  const activeSpans = selectActivePlacementSpans(spans, {
    useCandidatePlacement,
    priorityRatio: config.placementCandidatePriorityRatio,
  });

  let bestPlacement = null;
  for (const span of activeSpans) {
    const candidate = buildCandidateFilter(span, calculationContext, filters, {
      sampleRate: config.sampleRate,
      matchRangeStart: config.matchRangeStart,
      matchRangeEnd: config.matchRangeEnd,
      varyQAbove200Hz: config.varyQAbove200Hz,
      equalizerAdapter,
    });
    const trialFilters = cloneFilters(filters);
    trialFilters.push({ fc: candidate.fc, Q: candidate.Q, gain: 0 });

    const bandwidthSpans = getFilterBandwidthSpans(
      trialFilters,
      config.matchRangeStart,
      config.matchRangeEnd,
    );
    initializeOptimizer(placementOptimizer, calculationContext, bandwidthSpans);
    await placementOptimizer.optimizeGainAndQ(
      trialFilters,
      null,
      useCandidatePlacement ? config.placementCandidateIterations : 100,
    );
    equalizerAdapter.adaptFilters(trialFilters);

    const quality = qualityEvaluator.evaluate(trialFilters, calculationContext, {
      ppo: 36,
    });
    if (!bestPlacement || quality.score < bestPlacement.quality.score) {
      bestPlacement = { filters: trialFilters, quality };
    }
  }

  return bestPlacement;
}
