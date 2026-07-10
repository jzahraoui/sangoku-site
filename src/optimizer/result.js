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

/**
 * Attempts to refine a single sub via local search. The result is accepted
 * only if the GLOBAL combined score improves — a local gain that degrades
 * the ensemble is rejected. This prevents coordinate descent from diverging
 * when a sub's individual score improves against its `otherSum` but the
 * overall combined response gets worse.
 */
function tryRefineSub(
  optimizer,
  preparedSubs,
  subIndex,
  globalTheoreticalMax,
  maxIterations,
  globalScore,
) {
  const targetSub = preparedSubs[subIndex];
  const originalParam = cloneParam(targetSub.param);
  const otherSum = calculateCombinedResponse(
    buildParameterizedSubResponses(preparedSubs, subIndex, { validate: false }),
    false,
    false,
    { validate: false },
  );

  // Use the global theoretical max (absolute, phase=0) for the local search,
  // consistent with the main optimization phase (sub-search.js now uses
  // options.globalTheoreticalMax). This ensures the refinement scores are
  // comparable to the main phase scores.
  const perSubTheo = globalTheoreticalMax;

  targetSub.param = originalParam;
  const currentResult = evaluateParametersCached(
    optimizer,
    targetSub,
    otherSum,
    perSubTheo,
    { validate: false },
  );
  const refinedResult = optimizer.localSearch(
    originalParam,
    targetSub,
    otherSum,
    perSubTheo,
    maxIterations,
  );

  if (refinedResult.score <= currentResult.score) {
    targetSub.param = originalParam;
    return { accepted: false };
  }

  // Guard: tentatively apply the refined parameter and check the GLOBAL
  // score (computed with globalTheoreticalMax). Even though the local search
  // found a better score against perSubTheo, the change must also improve
  // (or at least not degrade) the global score. This prevents coordinate
  // descent from diverging when a local improvement hurts the ensemble.
  targetSub.param = cloneParam(refinedResult.param);
  const newGlobalScore = scoreOptimizedSubSum(
    optimizer,
    preparedSubs,
    globalTheoreticalMax,
  ).score;

  if (newGlobalScore <= globalScore) {
    targetSub.param = originalParam;
    return { accepted: false };
  }

  const optimizedSub = optimizer.optimizedSubs.find(
    sub => sub.measurement === targetSub.measurement,
  );
  if (optimizedSub) {
    optimizedSub.param = cloneParam(refinedResult.param);
  }
  return { accepted: true, newGlobalScore };
}

export function refineOptimizedSubsGlobally(optimizer, preparedSubs, result) {
  const { passes, maxIterations } = optimizer.config.optimization.globalRefinement;
  // Absolute theoretical maximum (phase=0): time-invariant, consistent with
  // flow.js. Using minimum phase here would create a moving target that
  // penalizes delay usage.
  const globalTheoreticalMax = calculateCombinedResponse(preparedSubs, true, false);
  let improvements = 0;

  // Start from a clean cache so leftover entries from earlier search phases do
  // not bias the LRU eviction during refinement. Within refinement we keep the
  // cache populated: hashEvaluation is keyed on the sub identifier and the
  // current `otherSum`, so cross-sub entries never collide and the same sub
  // benefits from cache hits across iterations and passes.
  clearEvaluationCache(optimizer);

  // Track the global score (computed with globalTheoreticalMax) to validate
  // that each refinement actually improves the combined response, not just
  // the individual sub's score against its per-sub theoretical max.
  let globalScore = scoreOptimizedSubSum(
    optimizer,
    preparedSubs,
    globalTheoreticalMax,
  ).score;

  for (let pass = 0; pass < passes; pass++) {
    let improvedThisPass = false;

    const indices = buildRefinementOrder(preparedSubs.length, pass, optimizer._random);

    for (const subIndex of indices) {
      const outcome = tryRefineSub(
        optimizer,
        preparedSubs,
        subIndex,
        globalTheoreticalMax,
        maxIterations,
        globalScore,
      );

      if (outcome.accepted) {
        globalScore = outcome.newGlobalScore;
        improvements++;
        improvedThisPass = true;
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
  // The reference sub (index 0) is the timing anchor: all delays are
  // relative to it. Optimizing its delay would shift the entire ensemble
  // without changing relative alignments (the acoustic result is identical).
  // MSO works the same way — the reference sub stays fixed at delay=0.
  // We therefore refine subs 1..N-1 only.
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
