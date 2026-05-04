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
  onLog,
  onProgress,
  checkCancellation,
}) {
  const filters = [];

  for (let slot = 0; slot < config.numFilters; slot++) {
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
