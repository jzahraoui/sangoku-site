/**
 * optimizerConfig.js
 *
 * Maps AutoEQ calculator state to the config object expected by
 * FilterParameterOptimizer. Pure function — no side effects.
 */

/**
 * Plafond dur du Q des filtres PK sur toute la chaîne aval : checkFilterGain
 * (measurement-operations) refuse tout PK avec Q au-delà APRÈS la pose des
 * filtres dans REW. Borner l'espace de recherche de l'optimiseur au même
 * plafond évite de produire des filtres condamnés — sur des creux étroits
 * (nuls d'interférence aiguisés par la moyenne de positions), l'optimiseur
 * montait à Q≈20-22 avec la borne équaliseur (50) et toute la génération
 * échouait après coup en « Q is out of limits ». Les plafonds par bande
 * (lowBandMaxQ/highBandMaxQ) restent opt-in et plus stricts quand définis.
 */
export const PK_MAX_Q = 20;

/**
 * @param {Object} config             - AutoEQ config (e.g. this in AutoEQCalculator)
 * @param {Object} equalizerAdapter   - EqualizerAdapter instance
 * @returns {Object}                  - FilterParameterOptimizer config
 */
export function createFilterOptimizerConfig(config, equalizerAdapter) {
  return {
    sampleRate: config.sampleRate,
    startFreq: config.matchRangeStart,
    endFreq: config.matchRangeEnd,
    boostPenaltyThresholdDb: config.overallMaxBoostDb,
    maxBoostDb: config.individualMaxBoostDb,
    maxCutDb: Math.abs(equalizerAdapter.getGainBounds().min),
    maxQ: Math.min(equalizerAdapter.getQBounds().max, PK_MAX_Q),
    lowBandMaxQ: config.lowBandMaxQ,
    highBandMaxQ: config.highBandMaxQ,
    highBandStartFreq: config.highBandStartFreq,
    varyQAbove200Hz: config.varyQAbove200Hz,
    allowNarrowFiltersBelow200Hz: config.allowNarrowFiltersBelow200Hz,
    gainSignLockThreshold: config.gainSignLockThreshold,
    maxBoostFreq: config.maxBoostFreq,
    overshootPenaltyWeight: config.overshootPenaltyWeight,
  };
}
