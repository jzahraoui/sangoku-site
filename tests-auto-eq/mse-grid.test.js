import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildMseGrid } from '../src/optimization/mseGrid.js';

const spans = [{ start: 20, end: 20000 }];
const freqs = [100, 200, 500, 1000, 2000, 5000, 10000];
const measured = [1, 2, 3, 4, 5, 6, 7];
const target = [1, 1, 1, 1, 1, 1, 1];

test('count equals number of in-span frequencies', () => {
  const grid = buildMseGrid({
    spans,
    freqs,
    measuredMagnitude: measured,
    targetMagnitude: target,
    sampleRate: 48000,
  });
  assert.equal(grid.count, freqs.length);
});

test('frequencies outside spans are excluded', () => {
  const narrowSpans = [{ start: 500, end: 2000 }];
  const grid = buildMseGrid({
    spans: narrowSpans,
    freqs,
    measuredMagnitude: measured,
    targetMagnitude: target,
    sampleRate: 48000,
  });
  assert.equal(grid.count, 3); // 500, 1000, 2000
});

test('deltas equal measured minus target', () => {
  const grid = buildMseGrid({
    spans,
    freqs,
    measuredMagnitude: measured,
    targetMagnitude: target,
    sampleRate: 48000,
  });
  for (let i = 0; i < grid.count; i++) {
    assert.ok(
      Math.abs(grid.deltas[i] - (measured[i] - target[i])) < 1e-5,
      `delta[${i}] mismatch`,
    );
  }
});

test('weights are finite and positive', () => {
  const grid = buildMseGrid({
    spans,
    freqs,
    measuredMagnitude: measured,
    targetMagnitude: target,
    sampleRate: 48000,
  });
  for (let i = 0; i < grid.count; i++) {
    assert.ok(Number.isFinite(grid.weights[i]), `weight[${i}] not finite`);
    assert.ok(grid.weights[i] > 0, `weight[${i}] not positive`);
  }
});

test('sth and sth2 are finite', () => {
  const grid = buildMseGrid({
    spans,
    freqs,
    measuredMagnitude: measured,
    targetMagnitude: target,
    sampleRate: 48000,
  });
  for (let i = 0; i < grid.count; i++) {
    assert.ok(Number.isFinite(grid.sth[i]), `sth[${i}] not finite`);
    assert.ok(Number.isFinite(grid.sth2[i]), `sth2[${i}] not finite`);
  }
});
