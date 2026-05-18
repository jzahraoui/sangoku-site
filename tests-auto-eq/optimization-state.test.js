import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildOptimizationState } from '../src/optimization/optimizationState.js';

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

function makeFilters() {
  return [
    { fc: 100, Q: 2, gain: -4 },
    { fc: 1000, Q: 1.5, gain: 3 },
    { fc: 5000, Q: 3, gain: 0.5 },
  ];
}

test('P = nG + nQ when optimizeFc=false', () => {
  const filters = makeFilters();
  const state = buildOptimizationState({ ...defaultParams, filters });
  assert.equal(state.nG, 3);
  assert.equal(state.nQ, 3);
  assert.equal(state.nF, 0);
  assert.equal(state.P, 6);
  assert.equal(state.initT.length, 6);
});

test('P = nG + nQ + nF when optimizeFc=true', () => {
  const filters = makeFilters();
  const state = buildOptimizationState({ ...defaultParams, filters, optimizeFc: true });
  assert.equal(state.nG, 3);
  assert.equal(state.nQ, 3);
  assert.equal(state.nF, 3);
  assert.equal(state.P, 9);
});

test('gain bounds: cut filter (gain < -2) has gainUpperBound = 0', () => {
  const filters = [{ fc: 500, Q: 2, gain: -4 }];
  const state = buildOptimizationState({ ...defaultParams, filters });
  assert.equal(state.gainUpperBounds[0], 0);
});

test('gain bounds: boost filter (gain > 2) has gainLowerBound = 0', () => {
  const filters = [{ fc: 500, Q: 2, gain: 4 }];
  const state = buildOptimizationState({ ...defaultParams, filters });
  assert.equal(state.gainLowerBounds[0], 0);
});

test('frequency bounds capped at endFreq * 0.98', () => {
  const filters = [{ fc: 15000, Q: 2, gain: -2 }];
  const state = buildOptimizationState({ ...defaultParams, filters, optimizeFc: true });
  assert.ok(state.frequencyUpperBounds[0] <= 20000 * 0.98 + 1e-9);
});

test('workingFilters is a deep copy — mutations do not propagate', () => {
  const filters = makeFilters();
  const state = buildOptimizationState({ ...defaultParams, filters });
  assert.notStrictEqual(state.workingFilters, filters);
  assert.notStrictEqual(state.workingFilters[0], filters[0]);
  state.workingFilters[0].gain = 99;
  assert.notEqual(filters[0].gain, 99);
});
