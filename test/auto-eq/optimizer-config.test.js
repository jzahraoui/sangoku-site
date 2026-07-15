import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFilterOptimizerConfig, PK_MAX_Q } from '../../src/autoeq/optimizerConfig.js';

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

test('maxQ est plafonné à PK_MAX_Q — la borne équaliseur (50) dépasserait la garde dure', () => {
  // checkFilterGain refuse tout PK avec Q > PK_MAX_Q APRÈS la pose des
  // filtres : un espace de recherche plus large produit des filtres condamnés
  // (vécu : creux étroits → Q 20.07/21.65 → « Q is out of limits »).
  const config = { lowBandMaxQ: 0, highBandMaxQ: 0 };
  const equalizerAdapter = {
    getGainBounds: () => ({ min: -25, max: 6 }),
    getQBounds: () => ({ min: 0.01, max: 50 }),
  };

  const result = createFilterOptimizerConfig(config, equalizerAdapter);

  assert.equal(PK_MAX_Q, 20);
  assert.equal(result.maxQ, PK_MAX_Q);
});
