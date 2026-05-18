import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInitialMetrics } from '../src/autoeq/initialMetrics.js';

function makeConfig(overrides = {}) {
  return {
    matchRangeStart: 20,
    matchRangeEnd: 20000,
    flatnessTarget: 1,
    sampleRate: 48000,
    notchExclusionThreshold: 6,
    overallMaxBoostDb: 6,
    ...overrides,
  };
}

function makeContext() {
  const scanFreqs = Float64Array.from([20, 40, 80, 160, 320, 640, 1280]);
  const measuredArr = Float64Array.from([3, 2, 1, 0, -1, -2, -3]);
  const targetArr = Float64Array.from([0, 0, 0, 0, 0, 0, 0]);

  return {
    scanFreqs,
    measuredArr,
    targetArr,
  };
}

test('createInitialMetrics returns spanAnalyzer, fastMSE and finite initialMSE', () => {
  const result = createInitialMetrics(makeConfig(), makeContext());

  assert.ok(result.spanAnalyzer);
  assert.ok(result.fastMSE);
  assert.ok(Number.isFinite(result.initialMSE));
  assert.ok(result.initialMSE >= 0);
});

test('createInitialMetrics computes zero MSE when measured equals target', () => {
  const scanFreqs = Float64Array.from([20, 40, 80, 160, 320]);
  const measuredArr = Float64Array.from([0, 0, 0, 0, 0]);
  const targetArr = Float64Array.from([0, 0, 0, 0, 0]);

  const result = createInitialMetrics(makeConfig(), {
    scanFreqs,
    measuredArr,
    targetArr,
  });

  assert.equal(result.initialMSE, 0);
});

test('createInitialMetrics fastMSE can evaluate filters after initialization', () => {
  const result = createInitialMetrics(makeConfig(), makeContext());

  const mse = result.fastMSE.compute([{ fc: 100, Q: 1, gain: -1 }]);

  assert.ok(Number.isFinite(mse));
  assert.ok(mse >= 0);
});
