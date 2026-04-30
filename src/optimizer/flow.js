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

  const globalTheoreticalMax = calculateCombinedResponse(preparedSubs, false, true, {
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
