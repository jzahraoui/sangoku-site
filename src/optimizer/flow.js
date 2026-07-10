import { EMPTY_CONFIG, cloneParam } from './config.js';
import { checkDelayBoundaries, generateLogResults } from './output.js';
import { buildOptimizationOptions } from './params.js';
import { buildParameterizedSubResponses, calculateCombinedResponse } from './response.js';
import {
  buildOptimizationReport,
  calculateReportMetrics,
  logOptimizationReport,
  refineOptimizedSubsGloballyIfNeeded,
} from './result.js';
import { optimizeSingleSub } from './sub-search.js';

// Above this number of total parameter combinations, the exhaustive ("classic")
// search is replaced by the genetic optimizer.
const GENETIC_PARAM_COUNT_THRESHOLD = 1000;

export function optimizeSubwoofers(optimizer) {
  const start = performance.now();
  const optimizedParams = findOptimalParameters(optimizer, optimizer.preparedSubs);
  const end = performance.now();
  const executionTime = end - start;

  optimizer.lm.info(`Execution time: ${executionTime.toFixed(2)}ms`);
  generateLogResults(
    optimizer,
    optimizedParams.optimizedSubs,
    optimizedParams.bestSum.score,
  );

  if (optimizedParams.optimizationReport) {
    optimizedParams.optimizationReport.executionTimeMs = executionTime;
    logOptimizationReport(optimizer, optimizedParams.optimizationReport);
  }

  return optimizedParams;
}

export function findOptimalParameters(optimizer, preparedSubs) {
  if (!preparedSubs?.length) {
    throw new Error('No subwoofer measurements provided for optimization');
  }

  if (preparedSubs?.length < 2) {
    throw new Error('At least 2 subwoofers are required for optimization');
  }

  const referenceSub = preparedSubs[0];
  referenceSub.param = EMPTY_CONFIG;

  // Absolute theoretical maximum (phase=0 for all subs): this is
  // time-invariant — it does not change when delays or polarity are applied.
  // The minimum phase was previously used, but it represents the best phase
  // alignment WITHOUT delays. Since the optimizer applies delays, the
  // minimum phase is a moving target that shifts as params change, causing
  // the efficiency to drop artificially when delays are applied. The absolute
  // max (phase=0) provides a stable, physically meaningful upper bound that
  // rewards phase alignment without penalizing delay usage.
  const globalTheoreticalMax = calculateCombinedResponse(preparedSubs, true, false, {
    validate: false,
  });
  const baselineMetrics = calculateReportMetrics(
    optimizer,
    calculateCombinedResponse(preparedSubs, false, false, { validate: false }),
    globalTheoreticalMax,
  );

  const subsWithoutFirst = preparedSubs.slice(1);
  const paramCount = optimizer.allPossibleCombinationsCount;
  const method = paramCount > GENETIC_PARAM_COUNT_THRESHOLD ? 'genetic' : 'classic';

  optimizer.lm.info(
    `Optimizing with ${method} method: ${paramCount} test parameters per sub`,
  );

  let previousValidSum = referenceSub;
  optimizer.optimizedSubs = [];
  const comparativeAnalysis = [];
  const options = buildOptimizationOptions(optimizer.config, method);
  // Pass the global theoretical max so each sub is scored against the same
  // stable reference, instead of a per-sub theo that shifts at each step.
  options.globalTheoreticalMax = globalTheoreticalMax;

  for (const subToOptimize of subsWithoutFirst) {
    const { finalResponse, comparative } = optimizeSingleSub(
      optimizer,
      subToOptimize,
      previousValidSum,
      options,
    );

    previousValidSum = finalResponse;
    subToOptimize.param = cloneParam(finalResponse.param);
    optimizer.optimizedSubs.push(subToOptimize);
    checkDelayBoundaries(optimizer, subToOptimize);

    comparativeAnalysis.push({
      analysis: comparative.improvementPercentage,
      recommended: finalResponse.hasAllPass ? 'with-allpass' : 'without-allpass',
      searchStats: comparative.searchStats,
    });
  }

  const preRefinementMetrics = calculateReportMetrics(
    optimizer,
    calculateCombinedResponse(
      buildParameterizedSubResponses(preparedSubs, -1, { validate: false }),
      false,
      false,
      { validate: false },
    ),
    globalTheoreticalMax,
  );

  let result = {
    optimizedSubs: optimizer.optimizedSubs,
    bestSum: previousValidSum,
    comparativeAnalysis,
  };

  result = refineOptimizedSubsGloballyIfNeeded(optimizer, preparedSubs, result);
  result.optimizationReport = buildOptimizationReport(
    optimizer,
    preparedSubs,
    result,
    baselineMetrics,
    preRefinementMetrics,
    globalTheoreticalMax,
  );

  return result;
}
