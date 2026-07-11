import { cloneParam, normalizeParam } from './config.js';
import {
  clearEvaluationCache as clearEvaluationCacheState,
  evaluateWithCache,
  hashEvaluation,
} from './cache.js';
import { calculateCombinedResponse, calculateResponseWithParams } from './response.js';

export function calculateEfficiencyRatio(optimizer, actualResponse, theoreticalResponse) {
  return optimizer._scorer.calculateEfficiencyRatio(actualResponse, theoreticalResponse);
}

/**
 * Calculates a comprehensive quality score for frequency response.
 *
 * Based on industry-standard metrics used by:
 * - MSO (Multi-Sub Optimizer): Peak-to-valley minimization
 * - Dirac Live: Weighted RMS error to target
 * - Audyssey: Frequency-weighted smoothness
 * - Harman/JBL: Preference-based curves
 *
 * Key principles:
 * 1. DIPS ARE WORSE THAN PEAKS (asymmetric penalty)
 *    - Dips cannot be corrected by EQ without massive amplification
 *    - Peaks can be easily reduced with EQ
 * 2. Narrowband nulls are especially problematic (phase cancellation)
 * 3. Overall level (efficiency) matters for headroom
 * 4. Smoothness in critical listening region (30-80Hz)
 *
 * @param {Object} response - Combined frequency response
 * @param {Object} theoreticalMax - Theoretical maximum response
 * @returns {number} Quality score (higher is better)
 */
export function calculateQualityScore(optimizer, response, theoreticalMax) {
  return optimizer._scorer.calculateQualityScore(response, theoreticalMax);
}

export function calculateOptimizationScore(optimizer, response, theoreticalMax) {
  return calculateOptimizationScoreDetails(optimizer, response, theoreticalMax).score;
}

export function calculateOptimizationScoreDetails(optimizer, response, theoreticalMax) {
  if (optimizer.config.optimization.objective === 'pre-eq') {
    const score = optimizer._scorer.calculatePreEqScore(response, theoreticalMax);
    return { score, qualityScore: score };
  }

  const qualityScore = optimizer.calculateQualityScore(response, theoreticalMax);
  if (optimizer.config.optimization.objective === 'balanced') {
    return { score: qualityScore, qualityScore };
  }

  const efficiencyRatio = optimizer.calculateEfficiencyRatio(response, theoreticalMax);
  const cappedEfficiency = Math.max(0, Math.min(efficiencyRatio, 100));
  const theoreticalWeight = optimizer.config.optimization.theoreticalWeight;
  const score =
    qualityScore * (1 - theoreticalWeight) + cappedEfficiency * theoreticalWeight;

  return { score, qualityScore, efficiencyRatio };
}

/**
 * Soft regularizer that nudges the search toward shorter delays without
 * blocking boundary solutions when they genuinely dominate.
 *
 * Shape (Obs E):
 *  - Dead zone: |τ|/τmax < DELAY_PENALTY_DEAD_ZONE → no penalty.
 *  - Smooth ramp: quadratic on the overshoot, capped at DELAY_PENALTY_MAX_POINTS.
 *
 * This keeps a latency preference for marginal trade-offs but stays well below
 * the score deltas that distinguish acoustically meaningful solutions, so an
 * optimum at the boundary is no longer hidden by the regularizer. The proper
 * implementation cost is still charged later in `audio-selection.js`.
 */
const DELAY_PENALTY_DEAD_ZONE = 0.5;
const DELAY_PENALTY_MAX_POINTS = 0.5;

function calculateDelayPenalty(optimizer, param) {
  const maxDelay = Math.max(
    Math.abs(optimizer.config.delay.max),
    Math.abs(optimizer.config.delay.min),
  );
  if (maxDelay <= 0) {
    return 0;
  }

  const normalizedDelay = Math.abs(param.delay) / maxDelay;
  if (normalizedDelay <= DELAY_PENALTY_DEAD_ZONE) {
    return 0;
  }

  const overshoot =
    (normalizedDelay - DELAY_PENALTY_DEAD_ZONE) / (1 - DELAY_PENALTY_DEAD_ZONE);
  return overshoot * overshoot * DELAY_PENALTY_MAX_POINTS;
}

export function evaluateParameters(
  optimizer,
  subToOptimize,
  previousValidSum,
  theoreticalMax,
  options = {},
) {
  const param = normalizeParam(subToOptimize.param);
  subToOptimize.param = param;
  const subModified = calculateResponseWithParams(subToOptimize, options);
  const response = calculateCombinedResponse(
    [subModified, previousValidSum],
    false,
    false,
    options,
  );
  const scoreDetails = calculateOptimizationScoreDetails(
    optimizer,
    response,
    theoreticalMax,
  );

  response.score = scoreDetails.score - calculateDelayPenalty(optimizer, param);
  response.qualityScore = scoreDetails.qualityScore;
  if (scoreDetails.efficiencyRatio != null) {
    response.efficiencyRatio = scoreDetails.efficiencyRatio;
  }
  response.objective = optimizer.config.optimization.objective;
  response.param = cloneParam(param);
  response.hasAllPass = param.allPass.enabled;

  return response;
}

export function evaluateParametersCached(
  optimizer,
  subToOptimize,
  previousValidSum,
  theoreticalMax,
  options = {},
) {
  const cacheKey = hashEvaluation({
    cache: optimizer._evaluationCache,
    config: optimizer.config,
    subToOptimize,
    previousValidSum,
    theoreticalMax,
  });

  return evaluateWithCache(optimizer._evaluationCache, cacheKey, () =>
    evaluateParameters(
      optimizer,
      subToOptimize,
      previousValidSum,
      theoreticalMax,
      options,
    ),
  );
}

export function clearEvaluationCache(optimizer) {
  clearEvaluationCacheState(optimizer._evaluationCache);
}
