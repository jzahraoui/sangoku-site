import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getOptimizedQBounds } from '../../src/optimization/filterParameterBounds.js';

test('without varyQAbove200Hz, hi is capped at 8', () => {
  const { lo, hi } = getOptimizedQBounds({
    fc: 1000,
    gain: -3,
    baseMaxQ: 10,
    varyQAbove200Hz: false,
  });
  assert.ok(hi <= 8, `hi should be <= 8 without adaptive Q, got ${hi}`);
  assert.ok(lo >= 1);
});

test('lo <= hi always', () => {
  const cases = [
    { fc: 50, gain: 0, baseMaxQ: 10, varyQAbove200Hz: true },
    { fc: 50, gain: 0, baseMaxQ: 10, varyQAbove200Hz: false },
    { fc: 1000, gain: 3, baseMaxQ: 10, varyQAbove200Hz: true },
    { fc: 10000, gain: -6, baseMaxQ: 10, varyQAbove200Hz: true },
    { fc: 20, gain: 0, baseMaxQ: 1, varyQAbove200Hz: true }, // edge: very low fc
  ];
  for (const p of cases) {
    const { lo, hi } = getOptimizedQBounds(p);
    assert.ok(lo <= hi, `lo > hi for fc=${p.fc}: lo=${lo} hi=${hi}`);
    assert.ok(lo >= 0.1, `lo < 0.1 for fc=${p.fc}: lo=${lo}`);
  }
});

test('boost filter (gain > 0) uses getBoostQUpperBound cap', () => {
  const { hi: hiBoost } = getOptimizedQBounds({
    fc: 1000,
    gain: 6,
    baseMaxQ: 10,
    varyQAbove200Hz: true,
  });
  const { hi: hiCut } = getOptimizedQBounds({
    fc: 1000,
    gain: -6,
    baseMaxQ: 10,
    varyQAbove200Hz: true,
  });
  // Boost should have lower or equal hi than cut (boost caps Q more tightly)
  assert.ok(hiBoost <= hiCut, `boost hi=${hiBoost} should be <= cut hi=${hiCut}`);
});

test('result is finite for extreme inputs', () => {
  const { lo, hi } = getOptimizedQBounds({
    fc: 20,
    gain: 0,
    baseMaxQ: 100,
    varyQAbove200Hz: true,
  });
  assert.ok(Number.isFinite(lo));
  assert.ok(Number.isFinite(hi));
});
