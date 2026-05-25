import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectCandidatePlacementChallenger } from '../../src/autoeq/candidatePlacementChallenger.js';

function makeContext() {
  return {
    scanFreqs: Float64Array.from([100, 1000, 10000]),
    measuredArr: Float64Array.from([0, 0, 0]),
    targetArr: Float64Array.from([0, 0, 0]),
  };
}

function makeSpanAnalyzer() {
  return { calcSpansExclNotches: () => [] };
}

// Minimal optimizerConfig accepted by FilterParameterOptimizer constructor
const baseOptimizerConfig = {
  sampleRate: 48000,
  scanFreqs: Float64Array.from([100, 1000, 10000]),
  targetArr: Float64Array.from([0, 0, 0]),
  measuredArr: Float64Array.from([0, 0, 0]),
  equalizerAdapter: {
    quantizeFrequency: f => f,
    adaptFilters: () => {},
    getGainBounds: () => ({ min: -12, max: 6 }),
    getQBounds: () => ({ min: 0.5, max: 10 }),
  },
};

const baseConfig = {
  sampleRate: 48000,
  numFilters: 1,
  enableCandidatePlacement: true,
  challengerOptimizationIterations: 50,
  matchRangeStart: 20,
  matchRangeEnd: 20000,
  enableBeatRewOptimization: false,
  equalizerGainStep: 0.5,
  flatnessTarget: 0.2,
  enableReduceRepair: false,
  reduceRepairPasses: 0,
  reduceRepairCandidateLimit: 3,
  reduceRepairOptimizationLimit: 2,
  enableCriticalBandRefinement: false,
  varyQAbove200Hz: false,
  criticalBandStart: 200,
  criticalBandEnd: 2000,
  maxMidRmsRegression: 0.1,
  maxFullRmsRegression: 0.1,
  maxOvershootRegression: 0.1,
};

const baseEqualizerAdapter = {
  quantizeFrequency: f => f,
  adaptFilters: () => {},
  getGainBounds: () => ({ min: -12, max: 6 }),
  getQBounds: () => ({ min: 0.5, max: 10 }),
};

const emptySpanFinder = { findCandidateSpans: () => [] };

test('selectCandidatePlacementChallenger returns baseline when enableCandidatePlacement=false', async () => {
  const baseline = [{ fc: 1000, Q: 1, gain: -2 }];
  const result = await selectCandidatePlacementChallenger({
    baselineFilters: baseline,
    scanFreqs: Float64Array.from([100, 1000, 10000]),
    measuredArr: Float64Array.from([0, 0, 0]),
    targetArr: Float64Array.from([0, 0, 0]),
    calculationContext: makeContext(),
    spanAnalyzer: makeSpanAnalyzer(),
    optimizerConfig: baseOptimizerConfig,
    config: { ...baseConfig, enableCandidatePlacement: false },
    spanFinder: emptySpanFinder,
    qualityEvaluator: {
      evaluate: () => ({ score: 1, fullRms: 1, criticalRms: 1, positiveRms: 0.5 }),
      acceptCandidate: () => true,
      computeQRiskPenalty: () => 0,
    },
    equalizerAdapter: baseEqualizerAdapter,
    onLog: () => {},
    checkCancellation: () => {},
  });

  assert.equal(result, baseline);
});

test('selectCandidatePlacementChallenger rejects challenger when acceptCandidate=false', async () => {
  const baseline = [{ fc: 1000, Q: 1, gain: -2 }];
  const logs = [];

  const result = await selectCandidatePlacementChallenger({
    baselineFilters: baseline,
    scanFreqs: Float64Array.from([100, 1000, 10000]),
    measuredArr: Float64Array.from([0, 0, 0]),
    targetArr: Float64Array.from([0, 0, 0]),
    calculationContext: makeContext(),
    spanAnalyzer: makeSpanAnalyzer(),
    optimizerConfig: baseOptimizerConfig,
    config: baseConfig,
    spanFinder: emptySpanFinder,
    qualityEvaluator: {
      evaluate: () => ({ score: 1, fullRms: 1, criticalRms: 1, positiveRms: 0.5 }),
      acceptCandidate: () => false,
      computeQRiskPenalty: () => 0,
    },
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
    checkCancellation: () => {},
  });

  assert.equal(result, baseline);
  assert.ok(logs.some(l => l.includes('rejeté')));
});

test('selectCandidatePlacementChallenger accepts challenger when acceptCandidate=true', async () => {
  const baseline = [{ fc: 1000, Q: 1, gain: -2 }];
  const logs = [];

  const result = await selectCandidatePlacementChallenger({
    baselineFilters: baseline,
    scanFreqs: Float64Array.from([100, 1000, 10000]),
    measuredArr: Float64Array.from([0, 0, 0]),
    targetArr: Float64Array.from([0, 0, 0]),
    calculationContext: makeContext(),
    spanAnalyzer: makeSpanAnalyzer(),
    optimizerConfig: baseOptimizerConfig,
    config: baseConfig,
    spanFinder: emptySpanFinder,
    qualityEvaluator: {
      evaluate: () => ({ score: 1, fullRms: 1, criticalRms: 1, positiveRms: 0.5 }),
      acceptCandidate: () => true,
      computeQRiskPenalty: () => 0,
    },
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
    checkCancellation: () => {},
  });

  // challenger is an empty array (no spans → no filters placed)
  assert.ok(Array.isArray(result));
  assert.ok(logs.some(l => l.includes('accepté')));
});

test('selectCandidatePlacementChallenger does not emit internal placement logs', async () => {
  const baseline = [{ fc: 1000, Q: 1, gain: -2 }];
  const logs = [];

  await selectCandidatePlacementChallenger({
    baselineFilters: baseline,
    scanFreqs: Float64Array.from([100, 1000, 10000]),
    measuredArr: Float64Array.from([0, 0, 0]),
    targetArr: Float64Array.from([0, 0, 0]),
    calculationContext: makeContext(),
    spanAnalyzer: makeSpanAnalyzer(),
    optimizerConfig: baseOptimizerConfig,
    config: baseConfig,
    spanFinder: emptySpanFinder,
    qualityEvaluator: {
      evaluate: () => ({ score: 1, fullRms: 1, criticalRms: 1, positiveRms: 0.5 }),
      acceptCandidate: () => false,
      computeQRiskPenalty: () => 0,
    },
    equalizerAdapter: baseEqualizerAdapter,
    onLog: msg => logs.push(msg),
    checkCancellation: () => {},
  });

  // Only the "rejeté" log should appear — no "Slot N:", "Phase 2:", etc.
  assert.ok(!logs.some(l => l.includes('Slot')));
  assert.ok(!logs.some(l => l.includes('Phase 2')));
});

test('selectCandidatePlacementChallenger logs both accepted and rejected messages correctly', async () => {
  const baseline = [{ fc: 1000, Q: 1, gain: -2 }];

  for (const accept of [true, false]) {
    const logs = [];
    await selectCandidatePlacementChallenger({
      baselineFilters: baseline,
      scanFreqs: Float64Array.from([100, 1000, 10000]),
      measuredArr: Float64Array.from([0, 0, 0]),
      targetArr: Float64Array.from([0, 0, 0]),
      calculationContext: makeContext(),
      spanAnalyzer: makeSpanAnalyzer(),
      optimizerConfig: baseOptimizerConfig,
      config: baseConfig,
      spanFinder: emptySpanFinder,
      qualityEvaluator: {
        evaluate: () => ({ score: 1, fullRms: 1, criticalRms: 1, positiveRms: 0.5 }),
        acceptCandidate: () => accept,
        computeQRiskPenalty: () => 0,
      },
      equalizerAdapter: baseEqualizerAdapter,
      onLog: msg => logs.push(msg),
      checkCancellation: () => {},
    });

    const keyword = accept ? 'accepté' : 'rejeté';
    assert.ok(
      logs.some(l => l.includes(keyword)),
      `expected "${keyword}" in logs`,
    );
  }
});
