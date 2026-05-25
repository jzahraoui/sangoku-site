import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ensureHFCoverage } from '../../src/autoeq/hfCoverage.js';

const SR = 48000;

function makeOptimizer() {
  return {
    initializeFromGrid() {},
    async optimizeGainAndQ() {},
  };
}

function makeConfig(overrides = {}) {
  return {
    sampleRate: SR,
    matchRangeStart: 20,
    matchRangeEnd: 20000,
    placementCandidateIterations: 50,
    ...overrides,
  };
}

function makeContext() {
  // scanFreqs with points above 8 kHz
  return {
    scanFreqs: Float64Array.from([100, 1000, 9000, 12000]),
    measuredArr: Float64Array.from([0, 0, 0, 0]),
    targetArr: Float64Array.from([0, 0, 0, 0]),
  };
}

test('ensureHFCoverage does nothing with fewer than 3 filters', async () => {
  const filters = [
    { fc: 100, Q: 1, gain: -2 },
    { fc: 500, Q: 1, gain: -2 },
  ];
  const logs = [];

  await ensureHFCoverage({
    filters,
    ...makeContext(),
    calculationContext: makeContext(),
    placementOptimizer: makeOptimizer(),
    config: makeConfig(),
    equalizerAdapter: { adaptFilters: () => {} },
    onLog: msg => logs.push(msg),
  });

  assert.equal(logs.length, 0);
  assert.equal(filters.length, 2);
});

test('ensureHFCoverage does nothing when HF error is below 3 dB', async () => {
  const filters = [
    { fc: 100, Q: 1, gain: -2 },
    { fc: 500, Q: 1, gain: -2 },
    { fc: 2000, Q: 1, gain: -1 },
  ];
  // residuals will be near 0 (no filters active, measured=target=0)
  const ctx = makeContext();
  const logs = [];

  await ensureHFCoverage({
    filters,
    scanFreqs: ctx.scanFreqs,
    measuredArr: ctx.measuredArr,
    targetArr: ctx.targetArr,
    calculationContext: ctx,
    placementOptimizer: makeOptimizer(),
    config: makeConfig(),
    equalizerAdapter: { adaptFilters: () => {} },
    onLog: msg => logs.push(msg),
  });

  assert.equal(logs.length, 0);
});

test('ensureHFCoverage does nothing when nearby HF filter already exists', async () => {
  const filters = [
    { fc: 100, Q: 1, gain: -2 },
    { fc: 500, Q: 1, gain: -2 },
    { fc: 9000, Q: 2, gain: -4 }, // nearby HF filter with significant gain
  ];
  // Large HF residual achieved by using measured > target
  const scanFreqs = Float64Array.from([100, 1000, 9000, 12000]);
  const measuredArr = Float64Array.from([0, 0, 10, 10]); // big HF error
  const targetArr = Float64Array.from([0, 0, 0, 0]);
  const logs = [];

  await ensureHFCoverage({
    filters,
    scanFreqs,
    measuredArr,
    targetArr,
    calculationContext: { scanFreqs, measuredArr, targetArr },
    placementOptimizer: makeOptimizer(),
    config: makeConfig(),
    equalizerAdapter: { adaptFilters: () => {} },
    onLog: msg => logs.push(msg),
  });

  assert.equal(logs.length, 0);
});

test('ensureHFCoverage replaces weakest filter and optimizes when HF error is large', async () => {
  const filters = [
    { fc: 100, Q: 1, gain: -5 },
    { fc: 500, Q: 1, gain: -6 },
    { fc: 2000, Q: 1, gain: 0.1 }, // weakest
  ];
  const scanFreqs = Float64Array.from([100, 1000, 9000, 12000]);
  const measuredArr = Float64Array.from([0, 0, 10, 10]); // large HF error
  const targetArr = Float64Array.from([0, 0, 0, 0]);
  const logs = [];
  let optimized = false;
  let adapted = false;

  const placementOptimizer = {
    initializeFromGrid() {},
    async optimizeGainAndQ() {
      optimized = true;
    },
  };
  const equalizerAdapter = {
    adaptFilters() {
      adapted = true;
    },
  };

  await ensureHFCoverage({
    filters,
    scanFreqs,
    measuredArr,
    targetArr,
    calculationContext: { scanFreqs, measuredArr, targetArr },
    placementOptimizer,
    config: makeConfig(),
    equalizerAdapter,
    onLog: msg => logs.push(msg),
  });

  assert.ok(logs.some(l => l.includes('HF: remplacement')));
  assert.ok(optimized);
  assert.ok(adapted);
});
