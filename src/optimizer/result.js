import { cloneParam, normalizeParam } from './config.js';
import {
  calculateEfficiencyRatio,
  calculateOptimizationScoreDetails,
  clearEvaluationCache,
  evaluateParametersCached,
} from './evaluation.js';
import {
  buildOptimizationReport as buildOptimizationReportPayload,
  calculateReportMetrics as calculateReportMetricsPayload,
  logOptimizationReport as logOptimizationReportPayload,
} from './report.js';
import { buildParameterizedSubResponses, calculateCombinedResponse } from './response.js';

export function refineOptimizedSubsGloballyIfNeeded(optimizer, preparedSubs, result) {
  if (!optimizer.config.optimization.globalRefinement.enabled) {
    return result;
  }

  return refineOptimizedSubsGlobally(optimizer, preparedSubs, result);
}

export function refineOptimizedSubsGlobally(optimizer, preparedSubs, result) {
  const { passes, maxIterations } = optimizer.config.optimization.globalRefinement;
  const globalTheoreticalMax = calculateCombinedResponse(preparedSubs, false, true);
  let improvements = 0;

  // Start from a clean cache so leftover entries from earlier search phases do
  // not bias the LRU eviction during refinement. Within refinement we keep the
  // cache populated: hashEvaluation is keyed on the sub identifier and the
  // current `otherSum`, so cross-sub entries never collide and the same sub
  // benefits from cache hits across iterations and passes.
  clearEvaluationCache(optimizer);

  for (let pass = 0; pass < passes; pass++) {
    let improvedThisPass = false;

    // Visit subs in a randomized order at each pass. Coordinate descent in a
    // fixed order can stall in local minima caused by the visit sequence;
    // shuffling between passes gives every sub a chance to react to the
    // accumulated changes of the others. The first pass uses natural order to
    // keep behavior deterministic for single-pass refinements (default).
    const indices = buildRefinementOrder(preparedSubs.length, pass, optimizer._random);

    for (const subIndex of indices) {
      const targetSub = preparedSubs[subIndex];
      const originalParam = cloneParam(targetSub.param);
      const otherSum = calculateCombinedResponse(
        buildParameterizedSubResponses(preparedSubs, subIndex, { validate: false }),
        false,
        false,
        { validate: false },
      );

      targetSub.param = originalParam;
      const currentResult = evaluateParametersCached(
        optimizer,
        targetSub,
        otherSum,
        globalTheoreticalMax,
        { validate: false },
      );
      const refinedResult = optimizer.localSearch(
        originalParam,
        targetSub,
        otherSum,
        globalTheoreticalMax,
        maxIterations,
      );

      if (refinedResult.score > currentResult.score) {
        targetSub.param = cloneParam(refinedResult.param);
        const optimizedSub = optimizer.optimizedSubs.find(
          sub => sub.measurement === targetSub.measurement,
        );
        if (optimizedSub) {
          optimizedSub.param = cloneParam(refinedResult.param);
        }
        improvements++;
        improvedThisPass = true;
      } else {
        targetSub.param = originalParam;
      }
    }

    if (!improvedThisPass) {
      break;
    }
  }

  const bestSum = scoreOptimizedSubSum(optimizer, preparedSubs, globalTheoreticalMax);
  if (improvements > 0) {
    optimizer.lm.info(`Global refinement improved ${improvements} sub alignment(s)`);
  }

  return {
    ...result,
    optimizedSubs: optimizer.optimizedSubs,
    bestSum,
    globalRefinement: {
      enabled: true,
      improvements,
    },
  };
}

function buildRefinementOrder(subCount, pass, random) {
  const indices = [];
  for (let i = 1; i < subCount; i++) indices.push(i);
  if (pass === 0 || indices.length <= 1) return indices;

  // Fisher-Yates shuffle using the optimizer's random source so a seeded
  // optimizer keeps the refinement deterministic.
  const rng = typeof random === 'function' ? random : Math.random;
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

export function scoreOptimizedSubSum(optimizer, preparedSubs, theoreticalMax) {
  const response = calculateCombinedResponse(
    buildParameterizedSubResponses(preparedSubs, -1, { validate: false }),
    false,
    false,
    { validate: false },
  );
  const scoreDetails = calculateOptimizationScoreDetails(
    optimizer,
    response,
    theoreticalMax,
  );
  response.score = scoreDetails.score;
  response.qualityScore = scoreDetails.qualityScore;
  if (scoreDetails.efficiencyRatio != null) {
    response.efficiencyRatio = scoreDetails.efficiencyRatio;
  }
  response.objective = optimizer.config.optimization.objective;
  return response;
}

export function buildOptimizationReport(
  optimizer,
  preparedSubs,
  result,
  baselineMetrics,
  preRefinementMetrics,
  globalTheoreticalMax,
) {
  const finalResponse = calculateCombinedResponse(
    buildParameterizedSubResponses(preparedSubs, -1, { validate: false }),
    false,
    false,
    { validate: false },
  );

  return buildOptimizationReportPayload({
    config: optimizer.config,
    preparedSubs,
    result,
    baselineMetrics,
    preRefinementMetrics,
    globalTheoreticalMax,
    finalResponse,
    optimizedSubs: optimizer.optimizedSubs,
    calculateReportMetrics: (response, theoreticalMax) =>
      calculateReportMetrics(optimizer, response, theoreticalMax),
    normalizeParam,
  });
}

export function calculateReportMetrics(optimizer, response, theoreticalMax) {
  return calculateReportMetricsPayload(response, theoreticalMax, {
    calculateOptimizationScoreDetails: (candidate, target) =>
      calculateOptimizationScoreDetails(optimizer, candidate, target),
    calculateEfficiencyRatio: (candidate, target) =>
      calculateEfficiencyRatio(optimizer, candidate, target),
  });
}

export function logOptimizationReport(optimizer, report) {
  logOptimizationReportPayload(optimizer.lm, report);
}
