/**
 * candidatePlacementChallenger.js
 *
 * Runs a silent challenger placement pass (with enableCandidatePlacement=true)
 * and accepts it if its quality beats the baseline.
 */

import { FilterParameterOptimizer } from '../optimization/FilterParameterOptimizer.js';
import { placeIterativeFilters } from './placementPipeline.js';
import { runFinalOptimizationStages } from './finalOptimizationStages.js';

const noop = () => {};

export async function selectCandidatePlacementChallenger({
  baselineFilters,
  scanFreqs,
  measuredArr,
  targetArr,
  calculationContext,
  spanAnalyzer,
  optimizerConfig,
  config,
  spanFinder,
  qualityEvaluator,
  equalizerAdapter,
  modalSeeds = null,
  forceRun = false,
  label = 'Placement challenger',
  acceptOverrides = null,
  onLog,
  checkCancellation,
}) {
  if (!forceRun && !config.enableCandidatePlacement) {
    return baselineFilters;
  }

  const baselineQuality = qualityEvaluator.evaluate(baselineFilters, calculationContext);

  const challengerPlacementOptimizer = new FilterParameterOptimizer(optimizerConfig);
  const challengerFinalOptimizer = new FilterParameterOptimizer(optimizerConfig);

  const challengerFilters = await placeIterativeFilters({
    scanFreqs,
    measuredArr,
    targetArr,
    calculationContext,
    placementOptimizer: challengerPlacementOptimizer,
    useCandidatePlacement: true,
    config,
    spanFinder,
    qualityEvaluator,
    equalizerAdapter,
    modalSeeds,
    onLog: noop,
    onProgress: noop,
    checkCancellation,
  });

  await runFinalOptimizationStages({
    filters: challengerFilters,
    spanAnalyzer,
    finalOptimizer: challengerFinalOptimizer,
    calculationContext,
    config,
    qualityEvaluator,
    equalizerAdapter,
    onLog: noop,
    onProgress: noop,
    checkCancellation,
    options: {
      runBeatEnhancements: false,
      maxIter: config.challengerOptimizationIterations,
      runAllOptions: { useDecimated: true },
    },
  });

  const challengerQuality = qualityEvaluator.evaluate(
    challengerFilters,
    calculationContext,
  );

  if (
    qualityEvaluator.acceptCandidate(challengerQuality, baselineQuality, {
      fullRegression: 0.01,
      midRegression: 0.01,
      overshootRegression: 0.1,
      scoreMargin: 0.02,
      ...acceptOverrides,
    })
  ) {
    onLog(
      `  ${label} accepté: score ${baselineQuality.score.toFixed(3)} → ${challengerQuality.score.toFixed(3)}`,
    );
    return challengerFilters;
  }

  onLog(
    `  ${label} rejeté: score ${challengerQuality.score.toFixed(3)} (baseline ${baselineQuality.score.toFixed(3)})`,
  );

  return baselineFilters;
}
