import { cloneParam, normalizeParam } from './config.js';
import {
  clearEvaluationCache as clearEvaluationCacheState,
  evaluateWithCache,
  hashEvaluation,
} from './cache.js';
import { peakMagApprox } from '../dsp/peakingMagnitude.js';
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
  if (optimizer.config.optimization.objective === 'target-match') {
    if (!optimizer.targetMagnitude) {
      throw new Error(
        'target-match objective requires a target curve (prepareMeasurements resamples optimization.targetCurve onto the grid)',
      );
    }
    const score = optimizer._scorer.calculateTargetMatchScore(
      response,
      optimizer.targetMagnitude,
    );
    return { score, qualityScore: score };
  }

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

// Filter-effort regularizer. Cuts are cheap (they free headroom, and a
// minimum-phase cut also shortens modal ringing). Boosts are the pathology
// this guards against: filling an interference dip with +dB "works" in
// magnitude but wastes driver excursion and rings — the solver must prefer
// re-aligning the other subs (delay/polarity) or cutting the destructive
// contributor. Hence:
//  - cuts: linear, low;
//  - boosts: linear ×2 PLUS a quadratic ramp beyond a small knee, so a big
//    boost must beat a decisive score margin to survive;
//  - cumulative per-sub boost above `joint.overallBoostCapDb` (the app's
//    overall max-boost setting): strong quadratic penalty — soft constraint.
const FILTER_EFFORT_POINTS_PER_DB = 0.05;
const FILTER_EFFORT_BOOST_MULTIPLIER = 2;
const BOOST_KNEE_DB = 2;
const BOOST_QUADRATIC_POINTS = 0.15;
const OVERALL_BOOST_CAP_POINTS = 2;

export function calculateFilterEffortPenalty(optimizer, param) {
  const filters = param.filters ?? [];
  if (filters.length === 0) return 0;

  let penalty = 0;
  for (const filter of filters) {
    const magnitude = Math.abs(filter.gain);
    if (filter.gain > 0) {
      penalty += magnitude * FILTER_EFFORT_BOOST_MULTIPLIER * FILTER_EFFORT_POINTS_PER_DB;
      const overshoot = filter.gain - BOOST_KNEE_DB;
      if (overshoot > 0) {
        penalty += overshoot * overshoot * BOOST_QUADRATIC_POINTS;
      }
    } else {
      penalty += magnitude * FILTER_EFFORT_POINTS_PER_DB;
    }
  }

  const capDb = optimizer.config.optimization.joint?.overallBoostCapDb;
  if (Number.isFinite(capDb)) {
    const cumulativeOvershoot = estimateMaxCumulativeBoostDb(filters) - capDb;
    if (cumulativeOvershoot > 0) {
      penalty += cumulativeOvershoot * cumulativeOvershoot * OVERALL_BOOST_CAP_POINTS;
    }
  }

  return penalty;
}

/**
 * Estimated maximum of the sub's cumulative filter boost: the summed dB
 * response of all filters, probed at each filter's center frequency (the
 * cumulative maximum sits at or near one of them). Uses the fast peaking
 * approximation (~0.3 dB) — this feeds a soft constraint, not a report.
 */
function estimateMaxCumulativeBoostDb(filters) {
  let maxCumulative = 0;
  for (const probe of filters) {
    let cumulative = 0;
    for (const filter of filters) {
      cumulative += peakMagApprox(
        filter.frequency,
        filter.q,
        filter.gain,
        probe.frequency,
      );
    }
    if (cumulative > maxCumulative) maxCumulative = cumulative;
  }
  return maxCumulative;
}

export function calculateDelayPenalty(optimizer, param) {
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

  response.score =
    scoreDetails.score -
    calculateDelayPenalty(optimizer, param) -
    calculateFilterEffortPenalty(optimizer, param);
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
