import { EMPTY_CONFIG, cloneParam } from './config.js';
import { checkDelayBoundaries, generateLogResults } from './output.js';
import { buildOptimizationOptions } from './params.js';
import { buildParameterizedSubResponses, calculateCombinedResponse } from './response.js';
import {
  buildOptimizationReport,
  calculateReportMetrics,
  logOptimizationReport,
  refineOptimizedSubsGloballyIfNeeded,
  scoreOptimizedSubSum,
} from './result.js';
import { optimizeSingleSub } from './sub-search.js';

// Above this number of total parameter combinations, the exhaustive ("classic")
// search is replaced by the genetic optimizer.
const GENETIC_PARAM_COUNT_THRESHOLD = 1000;

// Placement heuristic for the sequential phase when the configured objective
// is 'balanced': subs are placed with a max-theoretical blend (score =
// quality*(1-w) + cappedEfficiency*w) so the greedy phase does not trade
// level for smoothness too early. The 'balanced' landscape traps the greedy
// search in low-efficiency local optima that the global refinement (which
// does optimize the configured objective, and guards every move with it)
// cannot escape. w=0.6 measured best across the real-measurement fixtures:
// higher weights (0.75+) start degrading the final balanced score on some
// datasets, lower weights (0.5) miss part of the efficiency gain.
const SEQUENTIAL_HEURISTIC_WEIGHT = 0.6;

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

  // Scoring reference for each sequential step: the phase=0 theoretical max of
  // the subs actually present in the partial sum (reference + subs optimized so
  // far + the sub being optimized). Like the global max it only depends on the
  // magnitudes (never on delays/polarity/all-pass), so it is a stable target
  // within a step. Unlike the global max of all N subs, it keeps the efficiency
  // term on a meaningful 0-100% scale for the early subs — against the global
  // max, a 2-sub partial sum can never exceed ~50% efficiency and the dip/null
  // penalties dominate the score, steering early subs toward smoothness at the
  // expense of level.
  const subsInSum = [referenceSub];

  // Sequential phase scored with the placement heuristic (see
  // SEQUENTIAL_HEURISTIC_WEIGHT); the configured objective is restored before
  // global refinement, whose guard optimizes the real objective. When the
  // caller already asked for 'max-theoretical', its own weight is kept.
  const configuredObjective = optimizer.config.optimization.objective;
  const configuredWeight = optimizer.config.optimization.theoreticalWeight;
  if (configuredObjective === 'balanced') {
    optimizer.config.optimization.objective = 'max-theoretical';
    optimizer.config.optimization.theoreticalWeight = SEQUENTIAL_HEURISTIC_WEIGHT;
  }

  try {
    for (const subToOptimize of subsWithoutFirst) {
      subsInSum.push(subToOptimize);
      options.stepTheoreticalMax = calculateCombinedResponse(subsInSum, true, false, {
        validate: false,
      });
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
  } finally {
    optimizer.config.optimization.objective = configuredObjective;
    optimizer.config.optimization.theoreticalWeight = configuredWeight;
  }

  // The sequential phase scored `previousValidSum` with the placement
  // heuristic; rescore the final sum under the configured objective so
  // `bestSum.score` is on the caller's scale even when refinement is disabled
  // (refinement recomputes it anyway when enabled).
  previousValidSum = scoreOptimizedSubSum(
    optimizer,
    preparedSubs,
    globalTheoreticalMax,
  );

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
