import assert from 'node:assert/strict';
import { test } from 'node:test';

import { peakMagApprox, peakMagExact } from '../src/dsp/peakingMagnitude.js';

const SR = 48000;

test('peakMagApprox returns 0 when gain ≈ 0', () => {
  assert.equal(peakMagApprox(1000, 2, 0, 1000), 0);
  assert.equal(peakMagApprox(1000, 2, 0.005, 1000), 0);
});

test('peakMagExact returns 0 when gain ≈ 0', () => {
  assert.equal(peakMagExact(1000, 2, 0, 1000, SR), 0);
});

test('peakMagExact at fc with boost > 0 returns positive dB', () => {
  const result = peakMagExact(1000, 2, 6, 1000, SR);
  assert.ok(result > 0, `expected positive dB, got ${result}`);
});

test('peakMagExact at fc with cut < 0 returns negative dB', () => {
  const result = peakMagExact(1000, 2, -6, 1000, SR);
  assert.ok(result < 0, `expected negative dB, got ${result}`);
});

test('peakMagExact result is finite', () => {
  assert.ok(Number.isFinite(peakMagExact(500, 1.5, -3, 500, SR)));
  assert.ok(Number.isFinite(peakMagExact(500, 1.5, 3, 2000, SR)));
});
