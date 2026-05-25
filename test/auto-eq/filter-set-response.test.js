import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getCumulativeResponse,
  getCumulativeComplexResponse,
  getCumulativeGroupDelay,
  getGroupDelayStats,
} from '../../src/dsp/filterSetResponse.js';
import { BiquadFilter } from '../../src/dsp/BiquadFilter.js';

const SR = 48000;

function makeFilter(fc, Q, gain, enabled = true) {
  const f = new BiquadFilter(SR);
  f.setPeaking(fc, Q, gain);
  f.enabled = enabled;
  return f;
}

function makeUnityFilter() {
  return new BiquadFilter(SR);
}

test('no active filters → cumulative response = 0 dB', () => {
  assert.equal(getCumulativeResponse([], 1000), 0);
  assert.equal(getCumulativeResponse([makeUnityFilter()], 1000), 0);
});

test('disabled filter is ignored', () => {
  const f = makeFilter(1000, 2, 6, false);
  assert.equal(getCumulativeResponse([f], 1000), 0);
});

test('boost filter at fc gives positive cumulative dB', () => {
  const f = makeFilter(1000, 2, 6);
  const result = getCumulativeResponse([f], 1000);
  assert.ok(result > 0, `expected > 0, got ${result}`);
});

test('cut filter at fc gives negative cumulative dB', () => {
  const f = makeFilter(1000, 2, -6);
  const result = getCumulativeResponse([f], 1000);
  assert.ok(result < 0, `expected < 0, got ${result}`);
});

test('unity complex response = { re≈1, im≈0 }', () => {
  const { re, im } = getCumulativeComplexResponse([], 1000);
  assert.ok(Math.abs(re - 1) < 1e-9);
  assert.ok(Math.abs(im) < 1e-9);
});

test('complex response is finite for active filter', () => {
  const f = makeFilter(1000, 2, -3);
  const { re, im, magnitude, magnitudeDB, phase } = getCumulativeComplexResponse(
    [f],
    1000,
  );
  assert.ok(Number.isFinite(re));
  assert.ok(Number.isFinite(im));
  assert.ok(Number.isFinite(magnitude));
  assert.ok(Number.isFinite(magnitudeDB));
  assert.ok(Number.isFinite(phase));
});

test('cumulative group delay is finite', () => {
  const f = makeFilter(1000, 2, -3);
  const delay = getCumulativeGroupDelay([f], 1000);
  assert.ok(Number.isFinite(delay));
});

test('group delay stats are finite', () => {
  const f = makeFilter(1000, 2, -3);
  const stats = getGroupDelayStats({
    filters: [f],
    startFreq: 20,
    endFreq: 20000,
    points: 50,
  });
  assert.ok(Number.isFinite(stats.min));
  assert.ok(Number.isFinite(stats.max));
  assert.ok(Number.isFinite(stats.maxFreq));
  assert.ok(Number.isFinite(stats.range));
  assert.ok(Number.isFinite(stats.avgAbsVariation));
  assert.ok(stats.range >= 0);
});
