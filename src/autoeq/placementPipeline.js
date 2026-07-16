/**
 * placementPipeline.js
 *
 * Iterative per-slot filter placement pipeline.
 * Places filters one-by-one using selectPlacementCandidate, then ensures
 * the HF region has adequate coverage.
 */

import { buildResiduals } from './residuals.js';
import { selectPlacementCandidate } from './placementCandidateSelector.js';
import { ensureHFCoverage } from './hfCoverage.js';
import { buildModalInitialFilters } from './math/modalAnalyzer.js';
import { getFilterBandwidthSpans } from './filterUtils.js';
import { initializeOptimizer } from './optimizerRunner.js';

/**
 * 'modal-first' strategy: pre-places one cut filter per detected mode (fc
 * pinned on the mode) and runs a gain+Q optimization pass on that initial
 * set. The regular per-slot placement then completes the remaining slots.
 */
async function placeModalInitialFilters({
  filters,
  scanFreqs,
  measuredArr,
  targetArr,
  calculationContext,
  placementOptimizer,
  config,
  equalizerAdapter,
  modalSeeds,
  onLog,
}) {
  const residuals = buildResiduals(scanFreqs, measuredArr, targetArr, [], config.sampleRate);
  const initial = buildModalInitialFilters({
    modes: modalSeeds.modes,
    freqs: scanFreqs,
    residuals,
    minFreq: modalSeeds.minFreq,
    maxFreq: modalSeeds.maxFreq,
    maxCount: Math.min(config.numFilters, modalSeeds.initialCap ?? Infinity),
    maxCutDb: config.maxCutDb,
  });
  if (initial.length === 0) return;

  filters.push(
    ...initial.map(f => ({
      fc: equalizerAdapter.quantizeFrequency(
        Math.max(config.matchRangeStart, Math.min(config.matchRangeEnd, f.fc)),
      ),
      Q: f.Q,
      gain: f.gain,
    })),
  );
  const bandwidthSpans = getFilterBandwidthSpans(
    filters,
    config.matchRangeStart,
    config.matchRangeEnd,
  );
  initializeOptimizer(placementOptimizer, calculationContext, bandwidthSpans);
  await placementOptimizer.optimizeGainAndQ(filters, null, 100);
  equalizerAdapter.adaptFilters(filters);
  onLog(
    `  Placement modal initial: ${filters.length} filtre(s) sur modes (${filters
      .map(f => f.fc.toFixed(1))
      .join(', ')} Hz)`,
  );
}

export async function placeIterativeFilters({
  scanFreqs,
  measuredArr,
  targetArr,
  calculationContext,
  placementOptimizer,
  useCandidatePlacement,
  config,
  spanFinder,
  qualityEvaluator,
  equalizerAdapter,
  modalSeeds = null,
  onLog,
  onProgress,
  checkCancellation,
}) {
  const filters = [];
  const modalFirst = modalSeeds?.strategy === 'modal-first';
  const selectorSeeds = modalFirst ? null : modalSeeds;

  if (modalFirst) {
    await placeModalInitialFilters({
      filters,
      scanFreqs,
      measuredArr,
      targetArr,
      calculationContext,
      placementOptimizer,
      config,
      equalizerAdapter,
      modalSeeds,
      onLog,
    });
  }

  for (let slot = filters.length; slot < config.numFilters; slot++) {
    checkCancellation();

    const residuals = buildResiduals(
      scanFreqs,
      measuredArr,
      targetArr,
      filters,
      config.sampleRate,
    );

    const placement = await selectPlacementCandidate({
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
      modalSeeds: selectorSeeds,
    });

    if (!placement) {
      onLog(`  Slot ${slot + 1}: aucun span valide → arrêt`);
      break;
    }

    filters.splice(0, filters.length, ...placement.filters);

    const placed = filters.at(-1);
    const slotMSE = placement.quality.fullRms;

    onLog(
      `  Slot ${slot + 1}: fc=${placed.fc.toFixed(1)} Hz  Q=${placed.Q.toFixed(3)}  gain=${placed.gain.toFixed(2)} dB | MSE → ${slotMSE.toFixed(3)} dB RMS`,
    );

    onProgress(10 + Math.round(((slot + 1) / config.numFilters) * 40), 'Placement…');
  }

  await ensureHFCoverage({
    filters,
    scanFreqs,
    measuredArr,
    targetArr,
    calculationContext,
    placementOptimizer,
    config,
    equalizerAdapter,
    onLog,
  });

  return filters;
}
