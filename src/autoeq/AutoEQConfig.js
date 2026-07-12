/**
 * AutoEQConfig.js
 *
 * Validates and returns a plain configuration object for the AutoEQ pipeline.
 * Separating this concern keeps AutoEQCalculator lean and makes defaults &
 * constraints easy to find in one place.
 */

import { validateNumber, validateBoolean } from '../core/validators.js';

/**
 * Validates and returns a plain configuration object for the AutoEQ pipeline.
 *
 * @param {Object} [config={}] - Raw user-supplied configuration.
 * @returns {Object} Validated configuration with all defaults applied.
 */
export function createAutoEQConfig(config = {}) {
  const sampleRate = validateNumber(config.sampleRate, 'sampleRate', 44100, 96000, 48000);
  const numFilters = validateNumber(config.numFilters, 'numFilters', 1, 30, 20);

  const matchRangeStart = validateNumber(
    config.matchRangeStart,
    'matchRangeStart',
    10,
    sampleRate / 2,
    20,
  );
  const matchRangeEnd = validateNumber(
    config.matchRangeEnd,
    'matchRangeEnd',
    matchRangeStart,
    sampleRate / 2,
    20000,
  );

  const individualMaxBoostDb = validateNumber(
    config.individualMaxBoostDb,
    'individualMaxBoostDb',
    0,
    30,
    6,
  );
  const overallMaxBoostDb = validateNumber(
    config.overallMaxBoostDb,
    'overallMaxBoostDb',
    0,
    30,
    6,
  );
  const maxCutDb = validateNumber(config.maxCutDb, 'maxCutDb', 0, 30, 12);
  const flatnessTarget = validateNumber(
    config.flatnessTarget,
    'flatnessTarget',
    0.1,
    6,
    1,
  );

  const notchExclusionThreshold = validateNumber(
    config.notchExclusionThreshold,
    'notchExclusionThreshold',
    2,
    15,
    6,
  );

  // Protection ampli/enceintes (spec FR-032) : aucun boost sous cette
  // fréquence. 0 (défaut) ou toute valeur ≤ matchRangeStart = inactif.
  const maxBoostFreq = validateNumber(config.maxBoostFreq, 'maxBoostFreq', 0, 500, 0);
  // Poids de la pénalité douce d'overshoot dans le MSE (au-delà de +1 dB).
  const overshootPenaltyWeight = validateNumber(
    config.overshootPenaltyWeight,
    'overshootPenaltyWeight',
    0,
    10,
    0.3,
  );
  // Seuil de la passe de réduction post-optimisation des overshoots (dB).
  const maxAllowedOvershoot = validateNumber(
    config.maxAllowedOvershoot,
    'maxAllowedOvershoot',
    0.1,
    6,
    1.5,
  );

  const equalizerFreqStep =
    config.equalizerFreqStep == null
      ? null
      : validateNumber(config.equalizerFreqStep, 'equalizerFreqStep', 0.001, 10);
  const equalizerGainStep = validateNumber(
    config.equalizerGainStep,
    'equalizerGainStep',
    0.01,
    6,
    0.1,
  );
  const equalizerQStep =
    config.equalizerQStep == null
      ? null
      : validateNumber(config.equalizerQStep, 'equalizerQStep', 0.001, 10);
  const equalizerManufacturer = config.equalizerManufacturer ?? null;
  const equalizerModel = config.equalizerModel ?? null;

  const numOptimizationPasses = validateNumber(
    config.numOptimizationPasses,
    'numOptimizationPasses',
    1,
    20,
    10,
  );
  const gainSignLockThreshold = validateNumber(
    config.gainSignLockThreshold,
    'gainSignLockThreshold',
    0.1,
    2,
    0.5,
  );
  const minFilterGain = validateNumber(
    config.minFilterGain,
    'minFilterGain',
    0.1,
    2,
    0.4,
  );

  const enableRefinement = validateBoolean(
    config.enableRefinement,
    'enableRefinement',
    false,
  );

  const varyQAbove200Hz = validateBoolean(
    config.varyQAbove200Hz,
    'varyQAbove200Hz',
    false,
  );

  const allowNarrowFiltersBelow200Hz = validateBoolean(
    config.allowNarrowFiltersBelow200Hz,
    'allowNarrowFiltersBelow200Hz',
    true,
  );
  // Negative residual spans are only tracked when allowBoosts is true.
  const allowBoosts = validateBoolean(config.allowBoosts, 'allowBoosts', true);

  const enableBeatRewOptimization = validateBoolean(
    config.enableBeatRewOptimization,
    'enableBeatRewOptimization',
    false,
  );
  const enableCandidatePlacement = validateBoolean(
    config.enableCandidatePlacement,
    'enableCandidatePlacement',
    false,
  );
  const placementCandidateCount = validateNumber(
    config.placementCandidateCount,
    'placementCandidateCount',
    1,
    6,
    3,
  );
  const placementCandidateIterations = validateNumber(
    config.placementCandidateIterations,
    'placementCandidateIterations',
    10,
    150,
    60,
  );
  // Skip secondary candidates whose priority is below this ratio of the top priority.
  // 0 = no pruning, 1 = keep only the best candidate.
  const placementCandidatePriorityRatio = validateNumber(
    config.placementCandidatePriorityRatio,
    'placementCandidatePriorityRatio',
    0,
    1,
    0.6,
  );
  const challengerOptimizationIterations = validateNumber(
    config.challengerOptimizationIterations,
    'challengerOptimizationIterations',
    50,
    500,
    220,
  );

  const enableReduceRepair = validateBoolean(
    config.enableReduceRepair,
    'enableReduceRepair',
    true,
  );
  const reduceRepairPasses = validateNumber(
    config.reduceRepairPasses,
    'reduceRepairPasses',
    0,
    5,
    2,
  );
  const reduceRepairCandidateLimit = validateNumber(
    config.reduceRepairCandidateLimit,
    'reduceRepairCandidateLimit',
    1,
    20,
    7,
  );
  const reduceRepairOptimizationLimit = validateNumber(
    config.reduceRepairOptimizationLimit,
    'reduceRepairOptimizationLimit',
    1,
    20,
    2,
  );

  const enableCriticalBandRefinement = validateBoolean(
    config.enableCriticalBandRefinement,
    'enableCriticalBandRefinement',
    true,
  );
  const defaultCriticalStart = Math.max(matchRangeStart, Math.min(40, matchRangeEnd));
  const defaultCriticalEnd = Math.min(
    matchRangeEnd,
    Math.max(defaultCriticalStart, 3000),
  );
  const criticalBandStart = validateNumber(
    config.criticalBandStart,
    'criticalBandStart',
    matchRangeStart,
    matchRangeEnd,
    defaultCriticalStart,
  );
  const criticalBandEnd = validateNumber(
    config.criticalBandEnd,
    'criticalBandEnd',
    criticalBandStart,
    matchRangeEnd,
    defaultCriticalEnd,
  );

  const maxFullRmsRegression = validateNumber(
    config.maxFullRmsRegression,
    'maxFullRmsRegression',
    0,
    1,
    0.03,
  );
  const maxMidRmsRegression = validateNumber(
    config.maxMidRmsRegression,
    'maxMidRmsRegression',
    0,
    1,
    0.02,
  );
  const maxOvershootRegression = validateNumber(
    config.maxOvershootRegression,
    'maxOvershootRegression',
    0,
    3,
    0.2,
  );
  const qRiskPenaltyWeight = validateNumber(
    config.qRiskPenaltyWeight,
    'qRiskPenaltyWeight',
    0,
    5,
    0.08,
  );
  const filterCountPenalty = validateNumber(
    config.filterCountPenalty,
    'filterCountPenalty',
    0,
    1,
    0.025,
  );
  const refinementIterations = validateNumber(
    config.refinementIterations,
    'refinementIterations',
    10,
    500,
    100,
  );

  return {
    sampleRate,
    numFilters,
    matchRangeStart,
    matchRangeEnd,
    individualMaxBoostDb,
    overallMaxBoostDb,
    maxCutDb,
    flatnessTarget,
    notchExclusionThreshold,
    maxBoostFreq,
    overshootPenaltyWeight,
    maxAllowedOvershoot,
    equalizerFreqStep,
    equalizerGainStep,
    equalizerQStep,
    equalizerManufacturer,
    equalizerModel,
    numOptimizationPasses,
    gainSignLockThreshold,
    minFilterGain,
    enableRefinement,
    varyQAbove200Hz,
    allowNarrowFiltersBelow200Hz,
    allowBoosts,
    enableBeatRewOptimization,
    enableCandidatePlacement,
    placementCandidateCount,
    placementCandidateIterations,
    placementCandidatePriorityRatio,
    challengerOptimizationIterations,
    enableReduceRepair,
    reduceRepairPasses,
    reduceRepairCandidateLimit,
    reduceRepairOptimizationLimit,
    enableCriticalBandRefinement,
    criticalBandStart,
    criticalBandEnd,
    maxFullRmsRegression,
    maxMidRmsRegression,
    maxOvershootRegression,
    qRiskPenaltyWeight,
    filterCountPenalty,
    refinementIterations,
  };
}
