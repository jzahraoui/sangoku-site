import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildOptimizationFrequencyGrid } from '../src/optimization/frequencyGrid.js';

const sampleRate = 48000;
const freqs = [100, 200, 400, 800, 1600, 3200, 6400, 12800];
const measured = [2, 1, 0, -1, -2, -1, 0, 1];
const target = [0, 0, 0, 0, 0, 0, 0, 0];

test('numPoints equals total freqs when no spans and range covers all', () => {
  const grid = buildOptimizationFrequencyGrid({
    freqs,
    measuredMagnitude: measured,
    targetMagnitude: target,
    spans: null,
    startFreq: 20,
    endFreq: 20000,
    sampleRate,
  });
  assert.equal(grid.numPoints, freqs.length);
});

test('spans filter frequencies outside active ranges', () => {
  const grid = buildOptimizationFrequencyGrid({
    freqs,
    measuredMagnitude: measured,
    targetMagnitude: target,
    spans: [{ start: 200, end: 800 }],
    startFreq: 20,
    endFreq: 20000,
    sampleRate,
  });
  // 200, 400, 800 → 3 points
  assert.equal(grid.numPoints, 3);
});

test('deltas equal measured - target', () => {
  const grid = buildOptimizationFrequencyGrid({
    freqs,
    measuredMagnitude: measured,
    targetMagnitude: target,
    spans: null,
    startFreq: 20,
    endFreq: 20000,
    sampleRate,
  });
  for (let i = 0; i < freqs.length; i++) {
    assert.ok(Math.abs(grid.deltas[i] - (measured[i] - target[i])) < 1e-6);
  }
});

test('weights are finite and positive', () => {
  const grid = buildOptimizationFrequencyGrid({
    freqs,
    measuredMagnitude: measured,
    targetMagnitude: target,
    spans: null,
    startFreq: 20,
    endFreq: 20000,
    sampleRate,
  });
  for (let i = 0; i < grid.numPoints; i++) {
    assert.ok(Number.isFinite(grid.weights[i]));
    assert.ok(grid.weights[i] > 0);
  }
});

test('decimated grid is consistent with full grid', () => {
  const grid = buildOptimizationFrequencyGrid({
    freqs,
    measuredMagnitude: measured,
    targetMagnitude: target,
    spans: null,
    startFreq: 20,
    endFreq: 20000,
    sampleRate,
  });
  assert.equal(grid.decNumPoints, Math.ceil(grid.numPoints / 2));
  assert.ok(Math.abs(grid.decDeltas[0] - grid.deltas[0]) < 1e-6);
  assert.ok(Math.abs(grid.decSth[0] - grid.sth[0]) < 1e-9);
});
