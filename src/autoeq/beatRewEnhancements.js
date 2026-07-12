/**
 * beatRewEnhancements.js
 *
 * Beat REW multi-objective enhancement passes: reduce/repair, critical-band
 * refinement, and perceptual Q/boost regularization.
 */

import { cloneFilters, replaceFilters } from './filterUtils.js';
import { reduceTargetOvershoot } from './targetOvershoot.js';
import { buildPerceptualRegularizedFilters } from './perceptualRegularizer.js';
import { initializeOptimizer, runAllIfNeeded } from './optimizerRunner.js';

export async function runBeatRewEnhancements({
  filters,
  spanAnalyzer,
  finalOptimizer,
  calculationContext,
  config,
  qualityEvaluator,
  equalizerAdapter,
  onLog,
  checkCancellation,
}) {
  if (!config.enableBeatRewOptimization || filters.length === 0) {
    return;
  }

  const beforeQuality = qualityEvaluator.evaluate(filters, calculationContext);
  onLog('\n--- Phase 6: Beat REW multi-objectif ---');
  onLog(
    `  Score initial: ${beforeQuality.score.toFixed(3)} | full=${beforeQuality.fullRms.toFixed(3)} mid=${beforeQuality.criticalRms.toFixed(3)} pRMS=${beforeQuality.positiveRms.toFixed(3)}`,
  );

  await reduceAndRepairFilters({
    filters,
    spanAnalyzer,
    finalOptimizer,
    calculationContext,
    config,
    qualityEvaluator,
    equalizerAdapter,
    onLog,
    checkCancellation,
  });
  await refineCriticalBands({
    filters,
    spanAnalyzer,
    finalOptimizer,
    calculationContext,
    config,
    qualityEvaluator,
    equalizerAdapter,
    onLog,
    checkCancellation,
  });
  await regularizeRiskyFilters({
    filters,
    spanAnalyzer,
    finalOptimizer,
    calculationContext,
    config,
    qualityEvaluator,
    equalizerAdapter,
    onLog,
  });

  const afterQuality = qualityEvaluator.evaluate(filters, calculationContext);
  onLog(
    `  Score final: ${afterQuality.score.toFixed(3)} | full=${afterQuality.fullRms.toFixed(3)} mid=${afterQuality.criticalRms.toFixed(3)} pRMS=${afterQuality.positiveRms.toFixed(3)}`,
  );
}

async function reduceAndRepairFilters({
  filters,
  spanAnalyzer,
  finalOptimizer,
  calculationContext,
  config,
  qualityEvaluator,
  equalizerAdapter,
  onLog,
  checkCancellation,
}) {
  if (
    !config.enableReduceRepair ||
    filters.length <= 1 ||
    config.reduceRepairPasses === 0
  ) {
    return;
  }

  let baselineQuality = qualityEvaluator.evaluate(filters, calculationContext);
  let acceptedCount = 0;

  for (let pass = 0; pass < config.reduceRepairPasses && filters.length > 1; pass++) {
    checkCancellation();
    const candidateIndexes = getReduceRepairCandidateIndexes(
      filters,
      config,
      qualityEvaluator,
    );
    const candidatesToOptimize = screenReduceRepairCandidates(
      filters,
      candidateIndexes,
      baselineQuality,
      calculationContext,
      config,
      qualityEvaluator,
      onLog,
    );
    let bestCandidate = null;

    for (const candidate of candidatesToOptimize) {
      const trialFilters = cloneFilters(candidate.filters);
      await runAllIfNeeded(
        trialFilters,
        spanAnalyzer,
        finalOptimizer,
        calculationContext,
        {
          equalizerAdapter,
          maxIter: 140,
          logOverride: null,
          runAllOptions: { useDecimated: true },
        },
      );
      reduceTargetOvershoot(trialFilters, calculationContext, {
        sampleRate: config.sampleRate,
        threshold: config.maxAllowedOvershoot,
        onLog,
        silent: true,
      });
      const trialQuality = qualityEvaluator.evaluate(trialFilters, calculationContext);

      if (
        qualityEvaluator.acceptCandidate(trialQuality, baselineQuality, {
          allowFilterReduction: true,
          midRegression: config.maxMidRmsRegression * 1.5,
        }) &&
        (!bestCandidate || trialQuality.score < bestCandidate.quality.score)
      ) {
        bestCandidate = {
          filters: trialFilters,
          quality: trialQuality,
          removed: candidate.removed,
        };
      }
    }

    if (!bestCandidate) {
      break;
    }

    replaceFilters(filters, bestCandidate.filters);
    acceptedCount++;
    baselineQuality = bestCandidate.quality;
    onLog(
      `  Reduce/repair: retrait fc=${bestCandidate.removed.fc.toFixed(0)} Hz score=${baselineQuality.score.toFixed(3)}`,
    );
  }

  if (acceptedCount === 0) {
    onLog('  Reduce/repair: aucun retrait accepté');
  }
}

function screenReduceRepairCandidates(
  filters,
  candidateIndexes,
  baselineQuality,
  calculationContext,
  config,
  qualityEvaluator,
  onLog,
) {
  const screened = candidateIndexes.map(candidateIndex => {
    const trialFilters = cloneFilters(filters).filter(
      (_, index) => index !== candidateIndex,
    );
    reduceTargetOvershoot(trialFilters, calculationContext, {
      sampleRate: config.sampleRate,
      threshold: config.maxAllowedOvershoot,
      onLog,
      silent: true,
    });
    const quality = qualityEvaluator.evaluate(trialFilters, calculationContext, {
      ppo: 24,
    });
    return {
      filters: trialFilters,
      quality,
      removed: filters[candidateIndex],
    };
  });

  screened.sort((left, right) =>
    compareReduceRepairCandidates(left, right, baselineQuality, config, qualityEvaluator),
  );
  return screened.slice(
    0,
    Math.min(config.reduceRepairOptimizationLimit, screened.length),
  );
}

function compareReduceRepairCandidates(
  left,
  right,
  baselineQuality,
  config,
  qualityEvaluator,
) {
  const options = {
    allowFilterReduction: true,
    midRegression: config.maxMidRmsRegression * 2,
    fullRegression: config.maxFullRmsRegression * 3,
    overshootRegression: config.maxOvershootRegression * 2,
  };
  const leftAccepted = qualityEvaluator.acceptCandidate(
    left.quality,
    baselineQuality,
    options,
  );
  const rightAccepted = qualityEvaluator.acceptCandidate(
    right.quality,
    baselineQuality,
    options,
  );

  if (leftAccepted !== rightAccepted) {
    return leftAccepted ? -1 : 1;
  }
  return left.quality.score - right.quality.score;
}

function getReduceRepairCandidateIndexes(filters, config, qualityEvaluator) {
  return filters
    .map((filter, index) => ({
      index,
      priority:
        Math.abs(filter.gain) -
        0.2 * qualityEvaluator.computeQRiskPenalty([filter]) +
        (filter.gain > 0 ? 0.1 : 0),
    }))
    .sort((left, right) => left.priority - right.priority)
    .slice(0, config.reduceRepairCandidateLimit)
    .map(candidate => candidate.index);
}

async function refineCriticalBands({
  filters,
  spanAnalyzer,
  finalOptimizer,
  calculationContext,
  config,
  qualityEvaluator,
  equalizerAdapter,
  onLog,
  checkCancellation,
}) {
  if (!config.enableCriticalBandRefinement || filters.length === 0) {
    return;
  }

  const bands = [
    {
      label: 'grave modal',
      start: config.matchRangeStart,
      end: Math.min(config.matchRangeEnd, 250),
      requireCriticalImprovement: false,
    },
    {
      label: 'médium critique',
      start: config.criticalBandStart,
      end: config.criticalBandEnd,
      requireCriticalImprovement: true,
    },
    {
      label: 'aigu prudent',
      start: Math.max(config.matchRangeStart, 3000),
      end: config.matchRangeEnd,
      requireCriticalImprovement: false,
    },
  ].filter(band => band.end > band.start * 1.02);

  for (const band of bands) {
    checkCancellation();
    const baselineQuality = qualityEvaluator.evaluate(filters, calculationContext);
    const trialFilters = cloneFilters(filters);
    initializeOptimizer(finalOptimizer, calculationContext, [
      { start: band.start, end: band.end },
    ]);
    await finalOptimizer.optimizeAllParameters(trialFilters, null, 180, {
      useDecimated: true,
    });
    equalizerAdapter.adaptFilters(trialFilters);
    const trialQuality = qualityEvaluator.evaluate(trialFilters, calculationContext);

    if (
      qualityEvaluator.acceptCandidate(trialQuality, baselineQuality, {
        requireCriticalImprovement: band.requireCriticalImprovement,
        fullRegression: config.maxFullRmsRegression * 1.5,
      })
    ) {
      replaceFilters(filters, trialFilters);
      onLog(
        `  Bande ${band.label}: score ${baselineQuality.score.toFixed(3)} → ${trialQuality.score.toFixed(3)}`,
      );
      await runAllIfNeeded(filters, spanAnalyzer, finalOptimizer, calculationContext, {
        equalizerAdapter,
        maxIter: 120,
        logOverride: null,
        runAllOptions: { useDecimated: true },
      });
    }
  }
}

async function regularizeRiskyFilters({
  filters,
  spanAnalyzer,
  finalOptimizer,
  calculationContext,
  config,
  qualityEvaluator,
  equalizerAdapter,
  onLog,
}) {
  const regularized = buildPerceptualRegularizedFilters(filters, {
    varyQAbove200Hz: config.varyQAbove200Hz,
    equalizerAdapter,
  });
  if (!regularized.changed) {
    return;
  }

  const baselineQuality = qualityEvaluator.evaluate(filters, calculationContext);
  await runAllIfNeeded(
    regularized.filters,
    spanAnalyzer,
    finalOptimizer,
    calculationContext,
    {
      equalizerAdapter,
      maxIter: 120,
      logOverride: null,
      runAllOptions: { useDecimated: true },
    },
  );
  const trialQuality = qualityEvaluator.evaluate(regularized.filters, calculationContext);

  if (
    qualityEvaluator.acceptCandidate(trialQuality, baselineQuality, {
      fullRegression: config.maxFullRmsRegression * 1.5,
      overshootRegression: 0,
    })
  ) {
    replaceFilters(filters, regularized.filters);
    onLog(
      `  Régularisation Q/boost: score ${baselineQuality.score.toFixed(3)} → ${trialQuality.score.toFixed(3)}`,
    );
  }
}
