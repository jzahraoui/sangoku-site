import { describe, expect, it } from 'vitest';
import { createPhaseMatchCalculator } from '../../src/autoeq/phase-match-calculator.js';

// Mirror of the RCH settings panel defaults (MeasurementViewModel.autoEqConfig).
const plainConfig = {
  numFilters: 20,
  maxCutDb: 15,
  flatnessTarget: 0.3,
  numOptimizationPasses: 20,
  gainSignLockThreshold: 0.5,
  notchExclusionThreshold: 6,
  minFilterGain: 0.4,
  enableBeatRewOptimization: true,
  enableCandidatePlacement: true,
  enableReduceRepair: true,
  enableCriticalBandRefinement: true,
  enableRefinement: false,
  refinementIterations: 100,
  varyQAbove200Hz: false,
  allowNarrowFiltersBelow200Hz: true,
  allowBoosts: true,
};
// Same values wrapped as Knockout-style observables (functions).
const observableConfig = Object.fromEntries(
  Object.entries(plainConfig).map(([key, value]) => [key, () => value]),
);

describe('createPhaseMatchCalculator', () => {
  it('builds an AutoEQCalculator from plain values', () => {
    const calculator = createPhaseMatchCalculator({
      sampleRate: 48000,
      freqStart: 20,
      freqEnd: 200,
      autoEqConfig: plainConfig,
      individualMaxBoostDb: 6,
      overallMaxBoostDb: 3,
    });
    expect(typeof calculator.calculate).toBe('function');
    expect(calculator.numFilters).toBe(20);
    expect(calculator.individualMaxBoostDb).toBe(6);
  });

  it('unwraps Knockout-style observables (RCH panel values)', () => {
    const calculator = createPhaseMatchCalculator({
      sampleRate: 48000,
      freqStart: 20,
      freqEnd: 200,
      autoEqConfig: observableConfig,
      individualMaxBoostDb: '6',
      overallMaxBoostDb: '3',
    });
    expect(calculator.maxCutDb).toBe(15);
    expect(calculator.individualMaxBoostDb).toBe(6);
    expect(calculator.overallMaxBoostDb).toBe(3);
  });

  it('requires the autoEqConfig accessor', () => {
    expect(() =>
      createPhaseMatchCalculator({
        sampleRate: 48000,
        freqStart: 20,
        freqEnd: 200,
        autoEqConfig: null,
        individualMaxBoostDb: 6,
        overallMaxBoostDb: 3,
      }),
    ).toThrow('autoEqConfig is required');
  });
});
