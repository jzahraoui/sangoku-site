import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FastMSE } from '../src/optimization/FastMSE.js';

// Grille de test simple : 5 fréquences, delta = 0 (mesure = cible)
const spans = [{ start: 20, end: 20000 }];
const freqs = [100, 500, 1000, 5000, 10000];
const flat = [0, 0, 0, 0, 0];

function makeFastMSE({
  measured = flat,
  target = flat,
  boostPenaltyThresholdDb = 6,
} = {}) {
  const mse = new FastMSE(boostPenaltyThresholdDb, 48000);
  mse.initFromGrid(spans, freqs, measured, target);
  return mse;
}

test('compute([]) returns base MSE (no filters)', () => {
  const measured = [1, 2, 3, 4, 5];
  const target = [1, 1, 1, 1, 1];
  const mse = makeFastMSE({ measured, target });
  const result = mse.compute([]);
  assert.ok(Number.isFinite(result));
  assert.ok(result > 0);
});

test('compute([]) with zero residual returns 0', () => {
  const mse = makeFastMSE();
  const result = mse.compute([]);
  assert.ok(Math.abs(result) < 1e-10);
});

test('rms(filters) === sqrt(compute(filters))', () => {
  const measured = [2, 3, 1, 4, 2];
  const target = [1, 1, 1, 1, 1];
  const mse = makeFastMSE({ measured, target });
  const filters = [{ fc: 1000, Q: 2, gain: -3 }];
  assert.ok(Math.abs(mse.rms(filters) - Math.sqrt(mse.compute(filters))) < 1e-10);
});

test('computeWithCandidate matches compute([...filters, candidate])', () => {
  const measured = [2, 3, 1, 4, 2];
  const target = [1, 1, 1, 1, 1];
  const mse = makeFastMSE({ measured, target });
  const filters = [{ fc: 500, Q: 2, gain: -3 }];
  const testFc = 2000;
  const testQ = 1.5;
  const testGain = -2;

  const withCandidate = mse.computeWithCandidate(filters, testFc, testQ, testGain);
  const combined = mse.compute([...filters, { fc: testFc, Q: testQ, gain: testGain }]);
  assert.ok(
    Math.abs(withCandidate - combined) < 1e-6,
    `computeWithCandidate=${withCandidate} !== compute=[...filters,candidate]=${combined}`,
  );
});

test('result is finite with an active filter', () => {
  const measured = [1, 2, 1, 3, 1];
  const target = [1, 1, 1, 1, 1];
  const mse = makeFastMSE({ measured, target });
  const result = mse.compute([{ fc: 1000, Q: 2, gain: -4 }]);
  assert.ok(Number.isFinite(result));
});

test('excessive boost increases MSE due to penalty', () => {
  // flat residual, so without penalty MSE=0; with a large-boost filter it increases
  const mse = makeFastMSE({ boostPenaltyThresholdDb: 3 });
  const noFilter = mse.compute([]);
  const bigBoost = mse.compute([{ fc: 1000, Q: 2, gain: 10 }]);
  assert.ok(
    bigBoost > noFilter,
    `expected penalty to increase MSE: ${bigBoost} vs ${noFilter}`,
  );
});
