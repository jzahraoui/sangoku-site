import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GridCalculationContext } from '../../src/autoeq/GridCalculationContext.js';

const PPO96 = Math.pow(2, 1 / 96);

function makeGrid(startFreq, numPoints) {
  const freqs = new Array(numPoints);
  let f = startFreq;
  for (let i = 0; i < numPoints; i++) {
    freqs[i] = f;
    f *= PPO96;
  }
  return freqs;
}

const config = { matchRangeStart: 20, matchRangeEnd: 20000 };

test('identical grids: target is passed through unchanged', () => {
  const freqs = makeGrid(20, 500);
  const measured = { freqs, magnitude: freqs.map(f => 80 + Math.sin(f)) };
  const target = { freqs, magnitude: freqs.map(f => 75 + Math.log10(f)) };

  const ctx = GridCalculationContext.fromResponses(measured, target, config);

  assert.equal(ctx.scanFreqs.length, ctx.targetArr.length);
  for (let i = 0; i < ctx.scanFreqs.length; i++) {
    assert.ok(
      Math.abs(ctx.targetArr[i] - target.magnitude[i]) < 1e-12,
      `targetArr[${i}] must match the aligned target grid`,
    );
  }
});

test('shifted target grid: values are resampled by frequency, not by index', () => {
  // REW can return measured and target with different startFreq: same 1/96 PPO
  // spacing but the target starts 10 grid steps higher.
  const measuredFreqs = makeGrid(20, 500);
  const targetFreqs = makeGrid(20 * Math.pow(PPO96, 10), 500);

  // Target magnitude encodes its own frequency so we can verify the lookup.
  const measured = { freqs: measuredFreqs, magnitude: measuredFreqs.map(() => 80) };
  const target = { freqs: targetFreqs, magnitude: targetFreqs.map(f => f) };

  const ctx = GridCalculationContext.fromResponses(measured, target, config);

  for (let i = 0; i < ctx.scanFreqs.length; i++) {
    const freq = ctx.scanFreqs[i];
    // Nearest target frequency is at most half a grid step away (except below
    // the target's start, where it clamps to the first point).
    const expected = Math.max(freq, targetFreqs[0]);
    const relativeError = Math.abs(ctx.targetArr[i] - expected) / expected;
    assert.ok(
      relativeError < (PPO96 - 1) / 2 + 1e-9,
      `targetArr[${i}]=${ctx.targetArr[i]} must be the nearest-frequency target value for ${freq}`,
    );
  }

  // Index-based slicing would have produced a systematic one-ratio offset:
  // check explicitly that we did NOT copy target.magnitude[i] blindly.
  const mismatches = [];
  for (let i = 20; i < 100; i++) {
    if (Math.abs(ctx.targetArr[i] - target.magnitude[i]) < 1e-9) {
      mismatches.push(i);
    }
  }
  assert.equal(
    mismatches.length,
    0,
    'target must not be sliced by measured-grid indexes when grids differ',
  );
});

test('target grid with different length does not throw', () => {
  const measuredFreqs = makeGrid(20, 500);
  const targetFreqs = makeGrid(15, 620);
  const measured = { freqs: measuredFreqs, magnitude: measuredFreqs.map(() => 80) };
  const target = { freqs: targetFreqs, magnitude: targetFreqs.map(f => 70 + f / 1000) };

  const ctx = GridCalculationContext.fromResponses(measured, target, config);
  ctx.validate();
  assert.equal(ctx.scanFreqs.length, ctx.measuredArr.length);
  assert.equal(ctx.scanFreqs.length, ctx.targetArr.length);
});
