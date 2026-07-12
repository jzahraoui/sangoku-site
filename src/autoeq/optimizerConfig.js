/**
 * optimizerConfig.js
 *
 * Maps AutoEQ calculator state to the config object expected by
 * FilterParameterOptimizer. Pure function — no side effects.
 */

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
    maxQ: equalizerAdapter.getQBounds().max,
    varyQAbove200Hz: config.varyQAbove200Hz,
    allowNarrowFiltersBelow200Hz: config.allowNarrowFiltersBelow200Hz,
    gainSignLockThreshold: config.gainSignLockThreshold,
  };
}
