import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFilterOptimizerConfig } from '../../src/autoeq/optimizerConfig.js';

test('createFilterOptimizerConfig maps AutoEQ config to FilterParameterOptimizer config', () => {
  const config = {
    sampleRate: 48000,
    matchRangeStart: 20,
    matchRangeEnd: 20000,
    overallMaxBoostDb: 6,
    individualMaxBoostDb: 5,
    varyQAbove200Hz: true,
    allowNarrowFiltersBelow200Hz: false,
    gainSignLockThreshold: 0.5,
    maxBoostFreq: 50,
    lowBandMaxQ: 6,
    highBandMaxQ: 2,
    highBandStartFreq: 2000,
    overshootPenaltyWeight: 0.3,
  };

  const equalizerAdapter = {
    getGainBounds() {
      return { min: -12, max: 6 };
    },
    getQBounds() {
      return { min: 0.1, max: 10 };
    },
  };

  assert.deepEqual(createFilterOptimizerConfig(config, equalizerAdapter), {
    sampleRate: 48000,
    startFreq: 20,
    endFreq: 20000,
    boostPenaltyThresholdDb: 6,
    maxBoostDb: 5,
    maxCutDb: 12,
    maxQ: 10,
    lowBandMaxQ: 6,
    highBandMaxQ: 2,
    highBandStartFreq: 2000,
    varyQAbove200Hz: true,
    allowNarrowFiltersBelow200Hz: false,
    gainSignLockThreshold: 0.5,
    maxBoostFreq: 50,
    overshootPenaltyWeight: 0.3,
  });
});
