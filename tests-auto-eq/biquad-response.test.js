import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getMagnitudeSquaredFromCoefficients,
  getComplexResponseFromCoefficients,
  getPhaseFromCoefficients,
} from '../src/dsp/biquadResponse.js';
import {
  createUnityCoefficients,
  computePeakingCoefficients,
} from '../src/dsp/biquadCoefficients.js';

const SR = 48000;

test('unity magnitude squared = 1', () => {
  const c = createUnityCoefficients();
  const mag = getMagnitudeSquaredFromCoefficients(c, 1000, SR);
  assert.ok(Math.abs(mag - 1) < 1e-9);
});

test('unity magnitude dB = 0', () => {
  const c = createUnityCoefficients();
  const mag = getMagnitudeSquaredFromCoefficients(c, 1000, SR);
  assert.ok(Math.abs(10 * Math.log10(mag)) < 1e-9);
});

test('unity complex response = { re: 1, im: 0 }', () => {
  const c = createUnityCoefficients();
  const { re, im } = getComplexResponseFromCoefficients(c, 1000, SR);
  assert.ok(Math.abs(re - 1) < 1e-9);
  assert.ok(Math.abs(im) < 1e-9);
});

test('peaking boost at fc gives magnitude > 1', () => {
  const fc = 1000;
  const c = computePeakingCoefficients({ fc, Q: 2, gain: 6, sampleRate: SR });
  const mag = getMagnitudeSquaredFromCoefficients(c, fc, SR);
  assert.ok(mag > 1, `expected mag > 1, got ${mag}`);
});

test('peaking cut at fc gives magnitude < 1', () => {
  const fc = 1000;
  const c = computePeakingCoefficients({ fc, Q: 2, gain: -6, sampleRate: SR });
  const mag = getMagnitudeSquaredFromCoefficients(c, fc, SR);
  assert.ok(mag < 1, `expected mag < 1, got ${mag}`);
});

test('phase of unity coefficients = 0', () => {
  const c = createUnityCoefficients();
  const phase = getPhaseFromCoefficients(c, 1000, SR);
  assert.ok(Math.abs(phase) < 1e-9);
});
