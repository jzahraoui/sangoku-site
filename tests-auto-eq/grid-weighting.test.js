import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeOptimizationGridWeight } from '../src/optimization/gridWeighting.js';

test('weight is 1 for uniform grid (equal spacing)', () => {
  // step = 100 Hz everywhere, max(0.5, 100)/100 = 1
  const freqs = [100, 200, 300, 400, 500];
  const w = computeOptimizationGridWeight(freqs, 2);
  assert.ok(Math.abs(w - 1) < 1e-9);
});

test('weight >= 1 always (never below 1 for normal spacing)', () => {
  const freqs = [20, 40, 80, 160, 320, 640, 1280, 2560];
  for (let i = 0; i < freqs.length; i++) {
    const w = computeOptimizationGridWeight(freqs, i);
    assert.ok(w >= 1, `weight at index ${i} (${freqs[i]} Hz) < 1: ${w}`);
  }
});

test('weight > 1 for very dense grid spacing (step << 0.5)', () => {
  // step = 0.1 Hz, max(0.5, 0.1)/0.1 = 5
  const freqs = [100, 100.1, 100.2];
  const w = computeOptimizationGridWeight(freqs, 1);
  assert.ok(w > 1, `expected weight > 1 for dense grid, got ${w}`);
});

test('weight is boosted above 8 kHz', () => {
  const below = [7000, 8000, 9000];
  const above = [8000, 9000, 10000];
  const wBelow = computeOptimizationGridWeight(below, 1); // 8000 Hz
  const wAbove = computeOptimizationGridWeight(above, 1); // 9000 Hz
  assert.ok(wAbove > wBelow, `HF boost missing: wAbove=${wAbove} wBelow=${wBelow}`);
});

test('weight at edges uses neighbor correctly (no out-of-bounds)', () => {
  const freqs = [100, 200, 300];
  assert.ok(Number.isFinite(computeOptimizationGridWeight(freqs, 0)));
  assert.ok(Number.isFinite(computeOptimizationGridWeight(freqs, 2)));
});
