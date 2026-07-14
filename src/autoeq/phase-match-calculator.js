import { AutoEQCalculator } from './AutoEQCalculator.js';

/**
 * AutoEQCalculator factory for the RCH (phase-match) filter mode.
 *
 * [MOTEUR] module — single construction point shared by the MeasurementItem
 * adapter (Knockout path) and the services' operations path (ADR 002). The
 * `autoEqConfig` fields come from the RCH settings panel: they may be Knockout
 * observables or plain values, both are unwrapped here.
 */

const unwrap = value => (typeof value === 'function' ? value() : value);

function createPhaseMatchCalculator({
  sampleRate,
  freqStart,
  freqEnd,
  autoEqConfig,
  individualMaxBoostDb,
  overallMaxBoostDb,
  onLog = () => {},
}) {
  if (!autoEqConfig) {
    throw new Error('autoEqConfig is required to build the phase-match calculator');
  }
  const cfg = field => unwrap(autoEqConfig[field]);
  // Optional numeric fields: absent from older configs — let AutoEQConfig
  // apply its documented default instead of failing on NaN.
  const optionalNum = field => {
    const value = cfg(field);
    return value == null || value === '' ? undefined : +value;
  };

  return new AutoEQCalculator({
    sampleRate,
    numFilters: +cfg('numFilters'),
    matchRangeStart: freqStart,
    matchRangeEnd: freqEnd,
    individualMaxBoostDb: +individualMaxBoostDb,
    overallMaxBoostDb: +overallMaxBoostDb,
    maxCutDb: +cfg('maxCutDb'),
    flatnessTarget: +cfg('flatnessTarget'),
    maxBoostFreq: optionalNum('maxBoostFreq'),
    lowBandMaxQ: optionalNum('lowBandMaxQ'),
    highBandMaxQ: optionalNum('highBandMaxQ'),
    highBandStartFreq: optionalNum('highBandStartFreq'),
    overshootPenaltyWeight: optionalNum('overshootPenaltyWeight'),
    maxAllowedOvershoot: optionalNum('maxAllowedOvershoot'),
    enableRefinement: cfg('enableRefinement'),
    numOptimizationPasses: +cfg('numOptimizationPasses'),
    gainSignLockThreshold: +cfg('gainSignLockThreshold'),
    notchExclusionThreshold: +cfg('notchExclusionThreshold'),
    minFilterGain: +cfg('minFilterGain'),
    enableBeatRewOptimization: cfg('enableBeatRewOptimization'),
    enableCandidatePlacement: cfg('enableCandidatePlacement'),
    enableReduceRepair: cfg('enableReduceRepair'),
    enableCriticalBandRefinement: cfg('enableCriticalBandRefinement'),
    refinementIterations: +cfg('refinementIterations'),
    varyQAbove200Hz: cfg('varyQAbove200Hz'),
    allowNarrowFiltersBelow200Hz: cfg('allowNarrowFiltersBelow200Hz'),
    allowBoosts: cfg('allowBoosts'),
    onLog,
  });
}

export { createPhaseMatchCalculator };
