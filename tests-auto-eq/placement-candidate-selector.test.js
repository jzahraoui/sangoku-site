import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectPlacementCandidate } from '../src/autoeq/placementCandidateSelector.js';

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
    async optimizeGainAndQ() {},
  };
}

function makeSpanFinder(spans) {
  return {
    findCandidateSpans(_sf, _res, _filters, _limit) {
      return spans;
    },
  };
}

function makeQualityEvaluator(score) {
  return {
    evaluate() {
      return { score, fullRms: 1 };
    },
  };
}

const baseConfig = {
  sampleRate: 48000,
  matchRangeStart: 20,
  matchRangeEnd: 20000,
  varyQAbove200Hz: false,
  placementCandidateCount: 3,
  placementCandidatePriorityRatio: 0.5,
  placementCandidateIterations: 50,
};

const baseEqualizerAdapter = {
  quantizeFrequency: f => f,
  adaptFilters: () => {},
};

test('selectPlacementCandidate returns null when no spans found', async () => {
  const result = await selectPlacementCandidate({
    scanFreqs: makeContext().scanFreqs,
    residuals: Float64Array.from([0, 0, 0]),
    filters: [],
    calculationContext: makeContext(),
    placementOptimizer: makeOptimizer(),
    useCandidatePlacement: false,
    config: baseConfig,
    spanFinder: makeSpanFinder([]),
    qualityEvaluator: makeQualityEvaluator(1),
    equalizerAdapter: baseEqualizerAdapter,
  });

  assert.equal(result, null);
});

test('selectPlacementCandidate calls findCandidateSpans with limit=1 when disabled', async () => {
  let receivedLimit;
  const spanFinder = {
    findCandidateSpans(_sf, _res, _filters, limit) {
      receivedLimit = limit;
      return [];
    },
  };

  await selectPlacementCandidate({
    scanFreqs: makeContext().scanFreqs,
    residuals: Float64Array.from([0, 0, 0]),
    filters: [],
    calculationContext: makeContext(),
    placementOptimizer: makeOptimizer(),
    useCandidatePlacement: false,
    config: baseConfig,
    spanFinder,
    qualityEvaluator: makeQualityEvaluator(1),
    equalizerAdapter: baseEqualizerAdapter,
  });

  assert.equal(receivedLimit, 1);
});

test('selectPlacementCandidate returns best scoring candidate', async () => {
  const spans = [
    {
      spanStart: 900,
      spanEnd: 1100,
      peakFreq: 1000,
      peakVal: 3,
      sumDelta: 5,
      priority: 10,
    },
    { spanStart: 450, spanEnd: 550, peakFreq: 500, peakVal: 2, sumDelta: 3, priority: 5 },
  ];

  let callCount = 0;
  const qualityEvaluator = {
    evaluate() {
      callCount++;
      // First call returns score 2 (worse), second returns score 1 (better)
      return { score: callCount === 1 ? 2 : 1, fullRms: 1 };
    },
  };

  const result = await selectPlacementCandidate({
    scanFreqs: makeContext().scanFreqs,
    residuals: Float64Array.from([0, 3, 0]),
    filters: [],
    calculationContext: { ...makeContext(), measuredFn: () => 0 },
    placementOptimizer: makeOptimizer(),
    useCandidatePlacement: true,
    config: baseConfig,
    spanFinder: makeSpanFinder(spans),
    qualityEvaluator,
    equalizerAdapter: baseEqualizerAdapter,
  });

  assert.ok(result !== null);
  assert.equal(result.quality.score, 1);
});

test('selectPlacementCandidate calls equalizerAdapter.adaptFilters for each candidate', async () => {
  const spans = [
    {
      spanStart: 900,
      spanEnd: 1100,
      peakFreq: 1000,
      peakVal: 3,
      sumDelta: 5,
      priority: 10,
    },
    { spanStart: 450, spanEnd: 550, peakFreq: 500, peakVal: 2, sumDelta: 3, priority: 5 },
  ];

  let adaptCount = 0;
  const equalizerAdapter = {
    quantizeFrequency: f => f,
    adaptFilters() {
      adaptCount++;
    },
  };

  await selectPlacementCandidate({
    scanFreqs: makeContext().scanFreqs,
    residuals: Float64Array.from([0, 3, 0]),
    filters: [],
    calculationContext: { ...makeContext(), measuredFn: () => 0 },
    placementOptimizer: makeOptimizer(),
    useCandidatePlacement: true,
    config: baseConfig,
    spanFinder: makeSpanFinder(spans),
    qualityEvaluator: makeQualityEvaluator(1),
    equalizerAdapter,
  });

  assert.equal(adaptCount, 2);
});
