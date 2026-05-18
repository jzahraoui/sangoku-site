import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBeatRewEnhancements } from '../src/autoeq/beatRewEnhancements.js';

function makeContext() {
  return {
    scanFreqs: Float64Array.from([100, 1000, 10000]),
    measuredArr: Float64Array.from([0, 0, 0]),
    targetArr: Float64Array.from([0, 0, 0]),
  };
}

function makeOptimizer() {
  return {
    initializeFromGrid() {},
    async optimizeAllParameters() {},
    async optimizeGainAndQ() {},
  };
}

function makeSpanAnalyzer() {
  return { calcSpansExclNotches: () => [] };
}

function makeQualityEvaluator(score = 1) {
  return {
    evaluate() {
      return {
        score,
        fullRms: 1,
        criticalRms: 1,
        positiveRms: 0.5,
      };
    },
    acceptCandidate() {
      return false;
    },
    computeQRiskPenalty() {
      return 0;
    },
  };
}

const baseConfig = {
  sampleRate: 48000,
  enableBeatRewOptimization: true,
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

const baseEqualizerAdapter = {
  adaptFilters: () => {},
  quantizeFrequency: f => f,
};

test('runBeatRewEnhancements does nothing when enableBeatRewOptimization is false', async () => {
  const logs = [];
  await runBeatRewEnhancements({
    filters: [{ fc: 1000, Q: 1, gain: -2 }],
    spanAnalyzer: makeSpanAnalyzer(),
    finalOptimizer: makeOptimizer(),
    calculationContext: makeContext(),
    config: { ...baseConfig, enableBeatRewOptimization: false },
    qualityEvaluator: makeQualityEvaluator(),
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
    checkCancellation: () => {},
  });

  assert.equal(logs.length, 0);
});

test('runBeatRewEnhancements does nothing when filters is empty', async () => {
  const logs = [];
  await runBeatRewEnhancements({
    filters: [],
    spanAnalyzer: makeSpanAnalyzer(),
    finalOptimizer: makeOptimizer(),
    calculationContext: makeContext(),
    config: baseConfig,
    qualityEvaluator: makeQualityEvaluator(),
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
    checkCancellation: () => {},
  });

  assert.equal(logs.length, 0);
});

test('runBeatRewEnhancements logs initial and final score', async () => {
  const logs = [];
  await runBeatRewEnhancements({
    filters: [{ fc: 1000, Q: 1, gain: -2 }],
    spanAnalyzer: makeSpanAnalyzer(),
    finalOptimizer: makeOptimizer(),
    calculationContext: makeContext(),
    config: baseConfig,
    qualityEvaluator: makeQualityEvaluator(1.5),
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
    checkCancellation: () => {},
  });

  assert.ok(logs.some(l => l.includes('Score initial')));
  assert.ok(logs.some(l => l.includes('Score final')));
});

test('runBeatRewEnhancements calls checkCancellation during reduce/repair', async () => {
  let checkCount = 0;
  const qualityEvaluator = {
    ...makeQualityEvaluator(),
    acceptCandidate() {
      return true;
    },
  };

  await runBeatRewEnhancements({
    filters: [
      { fc: 200, Q: 1, gain: -2 },
      { fc: 1000, Q: 1, gain: -3 },
    ],
    spanAnalyzer: makeSpanAnalyzer(),
    finalOptimizer: makeOptimizer(),
    calculationContext: makeContext(),
    config: {
      ...baseConfig,
      enableReduceRepair: true,
      reduceRepairPasses: 2,
      reduceRepairCandidateLimit: 1,
      reduceRepairOptimizationLimit: 1,
    },
    qualityEvaluator,
    equalizerAdapter: baseEqualizerAdapter,
    onLog: () => {},
    checkCancellation: () => {
      checkCount++;
    },
  });

  assert.ok(checkCount > 0);
});

test('runBeatRewEnhancements accepts reduce/repair when qualityEvaluator approves', async () => {
  const logs = [];
  const qualityEvaluator = {
    evaluate() {
      return { score: 1, fullRms: 1, criticalRms: 1, positiveRms: 0.5 };
    },
    acceptCandidate() {
      return true;
    },
    computeQRiskPenalty() {
      return 0;
    },
  };

  const filters = [
    { fc: 200, Q: 1, gain: -2 },
    { fc: 1000, Q: 1, gain: -3 },
  ];

  await runBeatRewEnhancements({
    filters,
    spanAnalyzer: makeSpanAnalyzer(),
    finalOptimizer: makeOptimizer(),
    calculationContext: makeContext(),
    config: {
      ...baseConfig,
      enableReduceRepair: true,
      reduceRepairPasses: 1,
      reduceRepairCandidateLimit: 2,
      reduceRepairOptimizationLimit: 2,
    },
    qualityEvaluator,
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
    checkCancellation: () => {},
  });

  assert.ok(logs.some(l => l.includes('Reduce/repair: retrait')));
});
