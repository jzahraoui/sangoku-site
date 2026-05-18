import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  runFinalOptimizationStages,
  pruneCounterproductiveFilters,
} from '../src/autoeq/finalOptimizationStages.js';

function makeContext() {
  return {
    scanFreqs: Float64Array.from([100, 1000, 10000]),
    measuredArr: Float64Array.from([0, 0, 0]),
    targetArr: Float64Array.from([0, 0, 0]),
  };
}

function makeSpanAnalyzer() {
  return {
    calcSpansExclNotches: () => [{ start: 20, end: 20000 }],
  };
}

function makeOptimizer(mseValues = []) {
  let callIdx = 0;
  return {
    initializeFromGrid() {},
    async optimizeAllParameters() {},
    _computeMSE() {
      return mseValues[callIdx++] ?? 1;
    },
  };
}

const baseEqualizerAdapter = { adaptFilters: () => {} };

const baseConfig = {
  sampleRate: 48000,
  equalizerGainStep: 0.5,
  flatnessTarget: 0.2,
  enableBeatRewOptimization: false,
  enableReduceRepair: false,
  reduceRepairPasses: 0,
  reduceRepairCandidateLimit: 3,
  reduceRepairOptimizationLimit: 2,
  enableCriticalBandRefinement: false,
  varyQAbove200Hz: false,
  matchRangeStart: 20,
  matchRangeEnd: 20000,
  criticalBandStart: 200,
  criticalBandEnd: 2000,
  maxMidRmsRegression: 0.1,
  maxFullRmsRegression: 0.1,
  maxOvershootRegression: 0.1,
};

const baseQualityEvaluator = {
  evaluate: () => ({ score: 1, fullRms: 1, criticalRms: 1, positiveRms: 0.5 }),
  acceptCandidate: () => false,
  computeQRiskPenalty: () => 0,
};

// ── pruneCounterproductiveFilters ───────────────────────────────────────────

test('pruneCounterproductiveFilters does nothing with 0 filters', async () => {
  const logs = [];
  const filters = [];
  await pruneCounterproductiveFilters({
    filters,
    spanAnalyzer: makeSpanAnalyzer(),
    finalOptimizer: makeOptimizer(),
    calculationContext: makeContext(),
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
  });
  assert.equal(filters.length, 0);
  assert.equal(logs.length, 0);
});

test('pruneCounterproductiveFilters does nothing with 1 filter', async () => {
  const logs = [];
  const filters = [{ fc: 1000, Q: 1, gain: -3 }];
  await pruneCounterproductiveFilters({
    filters,
    spanAnalyzer: makeSpanAnalyzer(),
    finalOptimizer: makeOptimizer(),
    calculationContext: makeContext(),
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
  });
  assert.equal(filters.length, 1);
  assert.equal(logs.length, 0);
});

test('pruneCounterproductiveFilters logs "Aucun filtre contre-productif" when nothing to remove', async () => {
  const logs = [];
  // Both probes return >= baseMSE → nothing improves
  const optimizer = {
    initializeFromGrid() {},
    async optimizeAllParameters() {},
    _computeMSE: (() => {
      return () => {
        // First call: baseMSE=1. Probes for each filter also return 1 (no improvement).
        return 1;
      };
    })(),
  };
  await pruneCounterproductiveFilters({
    filters: [
      { fc: 200, Q: 1, gain: -2 },
      { fc: 1000, Q: 1, gain: -3 },
    ],
    spanAnalyzer: makeSpanAnalyzer(),
    finalOptimizer: optimizer,
    calculationContext: makeContext(),
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
  });
  assert.ok(logs.some(l => l.includes('Aucun filtre contre-productif')));
});

test('pruneCounterproductiveFilters prunes a filter when zeroing its gain lowers MSE', async () => {
  const logs = [];
  const filters = [
    { fc: 200, Q: 1, gain: -2 },
    { fc: 1000, Q: 1, gain: -3 },
  ];

  // Sequence: baseMSE, probe[0] (lower → prune idx 0), probe[1], then on next pass: baseMSE (1 filter left → stop)
  const mseSeq = [2, 0.5, 2];
  let seqIdx = 0;
  const optimizer = {
    initializeFromGrid() {},
    async optimizeAllParameters() {},
    _computeMSE: () => mseSeq[seqIdx++] ?? 1,
  };

  await pruneCounterproductiveFilters({
    filters,
    spanAnalyzer: makeSpanAnalyzer(),
    finalOptimizer: optimizer,
    calculationContext: makeContext(),
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
  });

  assert.equal(filters.length, 1);
  assert.ok(logs.some(l => l.includes('Élagué')));
  assert.ok(logs.some(l => l.includes('1 filtre(s) élagué(s)')));
});

// ── runFinalOptimizationStages ──────────────────────────────────────────────

test('runFinalOptimizationStages calls onProgress(55, ...)', async () => {
  const progressCalls = [];
  await runFinalOptimizationStages({
    filters: [{ fc: 1000, Q: 1, gain: -2 }],
    spanAnalyzer: makeSpanAnalyzer(),
    finalOptimizer: makeOptimizer(),
    calculationContext: makeContext(),
    config: baseConfig,
    qualityEvaluator: baseQualityEvaluator,
    equalizerAdapter: baseEqualizerAdapter,
    onLog: () => {},
    onProgress: (pct, msg) => progressCalls.push({ pct, msg }),
    checkCancellation: () => {},
    options: { runBeatEnhancements: false },
  });

  assert.ok(progressCalls.some(c => c.pct === 55));
});

test('runFinalOptimizationStages does not call Beat REW when runBeatEnhancements=false', async () => {
  const logs = [];
  await runFinalOptimizationStages({
    filters: [{ fc: 1000, Q: 1, gain: -2 }],
    spanAnalyzer: makeSpanAnalyzer(),
    finalOptimizer: makeOptimizer(),
    calculationContext: makeContext(),
    config: { ...baseConfig, enableBeatRewOptimization: true },
    qualityEvaluator: {
      ...baseQualityEvaluator,
      evaluate: () => ({ score: 1, fullRms: 1, criticalRms: 1, positiveRms: 0.5 }),
    },
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
    onProgress: () => {},
    checkCancellation: () => {},
    options: { runBeatEnhancements: false },
  });

  assert.ok(!logs.some(l => l.includes('Phase 6')));
});

test('runFinalOptimizationStages calls Beat REW when runBeatEnhancements=true and enabled', async () => {
  const logs = [];
  await runFinalOptimizationStages({
    filters: [{ fc: 1000, Q: 1, gain: -2 }],
    spanAnalyzer: makeSpanAnalyzer(),
    finalOptimizer: makeOptimizer(),
    calculationContext: makeContext(),
    config: { ...baseConfig, enableBeatRewOptimization: true },
    qualityEvaluator: {
      ...baseQualityEvaluator,
      evaluate: () => ({ score: 1, fullRms: 1, criticalRms: 1, positiveRms: 0.5 }),
    },
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
    onProgress: () => {},
    checkCancellation: () => {},
    options: { runBeatEnhancements: true },
  });

  assert.ok(logs.some(l => l.includes('Phase 6')));
});
