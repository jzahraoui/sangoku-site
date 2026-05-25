import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createUnityCoefficients,
  computePeakingCoefficients,
} from '../../src/dsp/biquadCoefficients.js';

test('unity coefficients are finite and form identity filter', () => {
  const c = createUnityCoefficients();
  assert.equal(c.a0, 1);
  assert.equal(c.b0, 1);
  assert.equal(c.a1, 0);
  assert.equal(c.b1, 0);
  assert.equal(c.a2, 0);
  assert.equal(c.b2, 0);
  for (const val of Object.values(c)) {
    assert.ok(Number.isFinite(val));
  }
});

test('peaking gain=0 produces coefficients close to unity', () => {
  const c = computePeakingCoefficients({ fc: 1000, Q: 2, gain: 0, sampleRate: 48000 });
  // When gain=0, A=1 so b0=a0, b2=a2 → ratio should be ~1
  assert.ok(Math.abs(c.b0 / c.a0 - 1) < 1e-9);
  assert.ok(
    Math.abs(c.b2 / c.a2 - 1) < 1e-9 ||
      (Math.abs(c.a2) < 1e-12 && Math.abs(c.b2) < 1e-12),
  );
});

test('all peaking coefficients are finite', () => {
  const c = computePeakingCoefficients({ fc: 500, Q: 1.5, gain: -6, sampleRate: 48000 });
  for (const [key, val] of Object.entries(c)) {
    assert.ok(Number.isFinite(val), `coefficient ${key} is not finite: ${val}`);
  }
});

test('throws RangeError when fc exceeds Nyquist', () => {
  assert.throws(
    () => computePeakingCoefficients({ fc: 25000, Q: 1, gain: 0, sampleRate: 48000 }),
    RangeError,
  );
});

test('throws RangeError when Q is too low', () => {
  assert.throws(
    () => computePeakingCoefficients({ fc: 1000, Q: 0.001, gain: -3, sampleRate: 48000 }),
    RangeError,
  );
});
