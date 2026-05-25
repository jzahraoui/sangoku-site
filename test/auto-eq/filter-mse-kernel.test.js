import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  prepareProfileCoefficients,
  computeBaseMSE,
  computeFilteredMSE,
} from '../../src/optimization/filterMseKernel.js';

const MAX_PROFILES = 30;

function makeArrays() {
  return {
    aC3: new Float64Array(MAX_PROFILES),
    aSum: new Float64Array(MAX_PROFILES),
    bC3: new Float64Array(MAX_PROFILES),
    bSum: new Float64Array(MAX_PROFILES),
    c2: new Float64Array(MAX_PROFILES),
  };
}

function makeGrid(n = 5) {
  const deltas = new Float32Array(n).fill(1); // +1 dB residual
  const weights = new Float32Array(n).fill(1);
  const sth = new Float64Array(n);
  const sth2 = new Float64Array(n);
  const freqNorm = (2 * Math.PI) / 48000;
  for (let i = 0; i < n; i++) {
    const freq = 200 * Math.pow(2, i);
    const omega = freq * freqNorm;
    const sinOmega = Math.sin(omega);
    sth[i] = 2 * sinOmega * sinOmega;
    const sinHalf = Math.sin(omega / 2);
    sth2[i] = 2 * sinHalf * sinHalf;
  }
  return { deltas, weights, sth, sth2, n };
}

test('prepareProfileCoefficients skips gain=0 filter', () => {
  const arrays = makeArrays();
  const n = prepareProfileCoefficients({
    filters: [{ fc: 1000, Q: 2, gain: 0 }],
    sampleRate: 48000,
    arrays,
  });
  assert.equal(n, 0);
});

test('prepareProfileCoefficients counts active filters', () => {
  const arrays = makeArrays();
  const n = prepareProfileCoefficients({
    filters: [
      { fc: 1000, Q: 2, gain: -3 },
      { fc: 500, Q: 1, gain: 0 }, // skipped
      { fc: 2000, Q: 3, gain: 2 },
    ],
    sampleRate: 48000,
    arrays,
  });
  assert.equal(n, 2);
});

test('computeBaseMSE returns sum(w*d)^2 / n', () => {
  const deltas = new Float32Array([2, 2, 2, 2]);
  const weights = new Float32Array([1, 1, 1, 1]);
  const mse = computeBaseMSE({ n: 4, deltas, weights });
  // Each term: (2*1)^2 = 4, sum = 16, /4 = 4
  assert.ok(Math.abs(mse - 4) < 1e-9);
});

test('computeFilteredMSE returns finite value with active filter', () => {
  const arrays = makeArrays();
  const grid = makeGrid(5);
  const numActive = prepareProfileCoefficients({
    filters: [{ fc: 1000, Q: 2, gain: -3 }],
    sampleRate: 48000,
    arrays,
  });
  const mse = computeFilteredMSE({
    n: grid.n,
    numActive,
    deltas: grid.deltas,
    weights: grid.weights,
    sth: grid.sth,
    sth2: grid.sth2,
    arrays,
    boostPenaltyThresholdDb: 6,
    penalizeTargetOvershoot: false,
  });
  assert.ok(Number.isFinite(mse));
  assert.ok(mse >= 0);
});

test('penalizeTargetOvershoot increases or maintains MSE vs no-penalty', () => {
  const arrays1 = makeArrays();
  const arrays2 = makeArrays();
  const grid = makeGrid(5);

  // Use a boost filter to create overshoot
  const filters = [{ fc: 800, Q: 2, gain: 4 }];
  // Make residuals negative so filter pushes above target
  const deltas = new Float32Array(grid.n).fill(-5);

  prepareProfileCoefficients({ filters, sampleRate: 48000, arrays: arrays1 });
  prepareProfileCoefficients({ filters, sampleRate: 48000, arrays: arrays2 });

  const mseNoPenalty = computeFilteredMSE({
    n: grid.n,
    numActive: 1,
    deltas,
    weights: grid.weights,
    sth: grid.sth,
    sth2: grid.sth2,
    arrays: arrays1,
    boostPenaltyThresholdDb: 6,
    penalizeTargetOvershoot: false,
  });
  const msePenalty = computeFilteredMSE({
    n: grid.n,
    numActive: 1,
    deltas,
    weights: grid.weights,
    sth: grid.sth,
    sth2: grid.sth2,
    arrays: arrays2,
    boostPenaltyThresholdDb: 6,
    penalizeTargetOvershoot: true,
  });

  assert.ok(
    msePenalty >= mseNoPenalty,
    `penalty should increase MSE: ${msePenalty} vs ${mseNoPenalty}`,
  );
});
