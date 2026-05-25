import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildOptimizationState } from '../../src/optimization/optimizationState.js';
import { createOptimizationDecoder } from '../../src/optimization/optimizerDecoding.js';

const defaultParams = {
  optimizeQ: true,
  optimizeFc: false,
  startFreq: 20,
  endFreq: 20000,
  maxCutDb: 12,
  maxBoostDb: 6,
  maxQ: 10,
  varyQAbove200Hz: false,
};

test('decode(initT) round-trips gain to within 1%', () => {
  const filters = [{ fc: 1000, Q: 2, gain: -3 }];
  const state = buildOptimizationState({ ...defaultParams, filters });
  const decode = createOptimizationDecoder({
    state,
    optimizeQ: true,
    optimizeFc: false,
    maxQ: 10,
    varyQAbove200Hz: false,
  });
  decode(state.initT);
  assert.ok(Math.abs(state.workingFilters[0].gain - -3) < 0.01);
});

test('decoder updates Q to a finite value within bounds', () => {
  const filters = [{ fc: 1000, Q: 2, gain: -3 }];
  const state = buildOptimizationState({ ...defaultParams, filters });
  const decode = createOptimizationDecoder({
    state,
    optimizeQ: true,
    optimizeFc: false,
    maxQ: 10,
    varyQAbove200Hz: false,
  });
  decode(state.initT);
  const q = state.workingFilters[0].Q;
  assert.ok(Number.isFinite(q));
  assert.ok(q >= state.qLowerBounds[0] - 1e-9);
  assert.ok(q <= state.qUpperBounds[0] + 1e-9);
});

test('decoder updates fc when optimizeFc=true', () => {
  const filters = [{ fc: 1000, Q: 2, gain: -3 }];
  const state = buildOptimizationState({ ...defaultParams, filters, optimizeFc: true });
  const decode = createOptimizationDecoder({
    state,
    optimizeQ: true,
    optimizeFc: true,
    maxQ: 10,
    varyQAbove200Hz: false,
  });
  decode(state.initT);
  const fc = state.workingFilters[0].fc;
  assert.ok(Number.isFinite(fc));
  assert.ok(fc > 0);
  assert.ok(fc >= state.frequencyLowerBounds[0] - 1e-9);
  assert.ok(fc <= state.frequencyUpperBounds[0] + 1e-9);
});

test('decoded gain stays within sign-locked bounds', () => {
  const filters = [{ fc: 500, Q: 3, gain: -8 }];
  const state = buildOptimizationState({ ...defaultParams, filters });
  const decode = createOptimizationDecoder({
    state,
    optimizeQ: true,
    optimizeFc: false,
    maxQ: 10,
    varyQAbove200Hz: false,
  });
  decode(state.initT);
  const g = state.workingFilters[0].gain;
  assert.ok(g >= state.gainLowerBounds[0] - 1e-9);
  assert.ok(g <= state.gainUpperBounds[0] + 1e-9);
});
