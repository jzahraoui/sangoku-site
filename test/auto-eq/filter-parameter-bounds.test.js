import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getOptimizedQBounds } from '../../src/optimization/filterParameterBounds.js';

// Default flags = REW defaults: usemodaleq TRUE (allowNarrowFiltersBelow200Hz),
// varyqabovemodal FALSE (varyQAbove200Hz).

test('REW default: cut above 200 Hz is capped at 5', () => {
  const { lo, hi } = getOptimizedQBounds({
    fc: 1000,
    gain: -3,
    baseMaxQ: 50,
    varyQAbove200Hz: false,
  });
  assert.equal(hi, 5);
  assert.ok(lo >= 1);
});

test('REW default: cut below 200 Hz may be modal-narrow (hi = fc/2, lo relaxed)', () => {
  const { lo, hi } = getOptimizedQBounds({
    fc: 80,
    gain: -6,
    baseMaxQ: 50,
    varyQAbove200Hz: false,
  });
  assert.equal(hi, 40); // fc/2
  assert.equal(lo, 2); // min(2, hi - 0.1)
});

test('allowNarrowFiltersBelow200Hz=false: cuts capped at 5 everywhere', () => {
  for (const fc of [50, 150, 1000, 8000]) {
    const { lo, hi } = getOptimizedQBounds({
      fc,
      gain: -6,
      baseMaxQ: 50,
      varyQAbove200Hz: false,
      allowNarrowFiltersBelow200Hz: false,
    });
    assert.equal(hi, 5, `fc=${fc}`);
    assert.ok(lo >= 1);
  }
});

test('varyQAbove200Hz=true: cut cap follows the 10→3 log law above 200 Hz', () => {
  const at200 = getOptimizedQBounds({
    fc: 200,
    gain: -3,
    baseMaxQ: 50,
    varyQAbove200Hz: true,
  });
  const at10k = getOptimizedQBounds({
    fc: 10000,
    gain: -3,
    baseMaxQ: 50,
    varyQAbove200Hz: true,
  });
  assert.ok(Math.abs(at200.hi - 10) < 1e-9, `hi at 200 Hz = ${at200.hi}`);
  assert.ok(Math.abs(at10k.hi - 3) < 1e-9, `hi at 10 kHz = ${at10k.hi}`);
});

test('boost filter (gain > 0) uses getBoostQUpperBound cap', () => {
  // Non-adaptive law: min(fc/6.22, 7.5)
  const { hi: hiBoost } = getOptimizedQBounds({
    fc: 1000,
    gain: 6,
    baseMaxQ: 50,
    varyQAbove200Hz: false,
  });
  assert.ok(Math.abs(hiBoost - 7.5) < 1e-9, `boost hi = ${hiBoost}`);

  const { hi: hiBoostAdaptive } = getOptimizedQBounds({
    fc: 10000,
    gain: 6,
    baseMaxQ: 50,
    varyQAbove200Hz: true,
  });
  assert.ok(Math.abs(hiBoostAdaptive - 3) < 1e-9, `adaptive boost hi = ${hiBoostAdaptive}`);
});

test('lo <= hi always', () => {
  const cases = [
    { fc: 50, gain: 0, baseMaxQ: 10, varyQAbove200Hz: true },
    { fc: 50, gain: 0, baseMaxQ: 10, varyQAbove200Hz: false },
    { fc: 1000, gain: 3, baseMaxQ: 10, varyQAbove200Hz: true },
    { fc: 10000, gain: -6, baseMaxQ: 10, varyQAbove200Hz: true },
    { fc: 20, gain: 0, baseMaxQ: 1, varyQAbove200Hz: true }, // edge: very low fc
    { fc: 20, gain: -3, baseMaxQ: 50, varyQAbove200Hz: false }, // fc/2 = 10
    { fc: 3, gain: -3, baseMaxQ: 50, varyQAbove200Hz: false }, // fc/2 < lo
  ];
  for (const p of cases) {
    const { lo, hi } = getOptimizedQBounds(p);
    assert.ok(lo <= hi, `lo > hi for fc=${p.fc}: lo=${lo} hi=${hi}`);
    assert.ok(lo >= 0.1, `lo < 0.1 for fc=${p.fc}: lo=${lo}`);
  }
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
