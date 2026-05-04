/**
 * hfCoverage.js
 *
 * Ensures the high-frequency region has a dedicated filter when the residual
 * error is significant. Runs after iterative placement.
 */

import { buildResiduals } from './residuals.js';
import { getFilterBandwidthSpans } from './filterUtils.js';
import { initializeOptimizer } from './optimizerRunner.js';

export async function ensureHFCoverage({
  filters,
  scanFreqs,
  measuredArr,
  targetArr,
  calculationContext,
  placementOptimizer,
  config,
  equalizerAdapter,
  onLog,
}) {
  if (filters.length < 3) return;

  const residuals = buildResiduals(
    scanFreqs,
    measuredArr,
    targetArr,
    filters,
    config.sampleRate,
  );
  const hfThreshold = 8000;

  // Find worst HF error
  let worstHFError = 0;
  let worstHFFreq = 0;
  for (let i = 0; i < scanFreqs.length; i++) {
    if (scanFreqs[i] < hfThreshold) continue;
    const absErr = Math.abs(residuals[i]);
    if (absErr > worstHFError) {
      worstHFError = absErr;
      worstHFFreq = scanFreqs[i];
    }
  }

  // Only act if HF error is significant
  if (worstHFError < 3) return;

  // Check if we have a filter near the problematic region
  const hasNearbyHF = filters.some(
    f => f.fc > worstHFFreq * 0.5 && Math.abs(f.gain) > 0.5,
  );
  if (hasNearbyHF) return;

  // Find weakest filter (smallest |gain|)
  let weakestIdx = 0;
  let weakestGain = Infinity;
  for (let i = 0; i < filters.length; i++) {
    if (Math.abs(filters[i].gain) < weakestGain) {
      weakestGain = Math.abs(filters[i].gain);
      weakestIdx = i;
    }
  }

  // Only replace if the weakest filter contributes less than the HF error
  if (weakestGain > worstHFError * 0.5) return;

  const removed = filters[weakestIdx];
  onLog(
    `  HF: remplacement fc=${removed.fc.toFixed(0)} Hz (gain=${removed.gain.toFixed(2)}) par HF @ ${worstHFFreq.toFixed(0)} Hz`,
  );
  filters[weakestIdx] = { fc: worstHFFreq, Q: 2, gain: 0 };

  // Re-optimize all filters with the new HF filter
  const bwSpans = getFilterBandwidthSpans(
    filters,
    config.matchRangeStart,
    config.matchRangeEnd,
  );
  initializeOptimizer(placementOptimizer, calculationContext, bwSpans);
  await placementOptimizer.optimizeGainAndQ(
    filters,
    null,
    config.placementCandidateIterations,
  );
  equalizerAdapter.adaptFilters(filters);
}
