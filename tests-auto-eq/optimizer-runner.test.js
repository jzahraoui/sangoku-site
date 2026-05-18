import assert from 'node:assert/strict';
import { test } from 'node:test';

import { initializeOptimizer, runAllIfNeeded } from '../src/autoeq/optimizerRunner.js';

function makeContext() {
  return {
    scanFreqs: Float64Array.from([100, 1000]),
    measuredArr: Float64Array.from([1, 2]),
    targetArr: Float64Array.from([0, 0]),
  };
}

test('initializeOptimizer forwards grid arrays to optimizer', () => {
  let received;
  const optimizer = {
    initializeFromGrid(...args) {
      received = args;
    },
  };

  const spans = [{ start: 20, end: 20000 }];
  const context = makeContext();

  initializeOptimizer(optimizer, context, spans);

  assert.deepEqual(received, [
    context.scanFreqs,
    context.measuredArr,
    context.targetArr,
    spans,
  ]);
});

test('runAllIfNeeded does nothing when filters is empty', async () => {
  let called = false;
  const optimizer = {
    optimizeAllParameters() {
      called = true;
    },
  };
  const spanAnalyzer = { calcSpansExclNotches: () => [] };
  const equalizerAdapter = { adaptFilters: () => {} };

  await runAllIfNeeded([], spanAnalyzer, optimizer, makeContext(), { equalizerAdapter });

  assert.equal(called, false);
});

test('runAllIfNeeded sorts filters by frequency', async () => {
  const filters = [
    { fc: 1000, Q: 1, gain: -1 },
    { fc: 200, Q: 1, gain: -1 },
  ];
  const optimizer = {
    initializeFromGrid() {},
    async optimizeAllParameters() {},
  };
  const spanAnalyzer = { calcSpansExclNotches: () => [] };
  const equalizerAdapter = { adaptFilters: () => {} };

  await runAllIfNeeded(filters, spanAnalyzer, optimizer, makeContext(), {
    equalizerAdapter,
  });

  assert.equal(filters[0].fc, 200);
});

test('runAllIfNeeded calls initializeFromGrid with spans from spanAnalyzer', async () => {
  const expectedSpans = [{ start: 100, end: 5000 }];
  let receivedSpans;
  const optimizer = {
    initializeFromGrid(_sf, _m, _t, spans) {
      receivedSpans = spans;
    },
    async optimizeAllParameters() {},
  };
  const spanAnalyzer = { calcSpansExclNotches: () => expectedSpans };
  const equalizerAdapter = { adaptFilters: () => {} };

  await runAllIfNeeded(
    [{ fc: 1000, Q: 1, gain: -1 }],
    spanAnalyzer,
    optimizer,
    makeContext(),
    { equalizerAdapter },
  );

  assert.deepEqual(receivedSpans, expectedSpans);
});

test('runAllIfNeeded calls optimizeAllParameters with provided options', async () => {
  let receivedArgs;
  const optimizer = {
    initializeFromGrid() {},
    async optimizeAllParameters(...args) {
      receivedArgs = args;
    },
  };
  const spanAnalyzer = { calcSpansExclNotches: () => [] };
  const equalizerAdapter = { adaptFilters: () => {} };
  const logOverride = () => {};

  await runAllIfNeeded(
    [{ fc: 500, Q: 1, gain: -1 }],
    spanAnalyzer,
    optimizer,
    makeContext(),
    {
      equalizerAdapter,
      maxIter: 200,
      logOverride,
      runAllOptions: { useDecimated: true },
    },
  );

  assert.equal(receivedArgs[1], logOverride);
  assert.equal(receivedArgs[2], 200);
  assert.deepEqual(receivedArgs[3], { useDecimated: true });
});

test('runAllIfNeeded calls equalizerAdapter.adaptFilters after optimization', async () => {
  let adapted = false;
  const optimizer = {
    initializeFromGrid() {},
    async optimizeAllParameters() {},
  };
  const spanAnalyzer = { calcSpansExclNotches: () => [] };
  const equalizerAdapter = {
    adaptFilters() {
      adapted = true;
    },
  };

  await runAllIfNeeded(
    [{ fc: 1000, Q: 1, gain: -1 }],
    spanAnalyzer,
    optimizer,
    makeContext(),
    { equalizerAdapter },
  );

  assert.equal(adapted, true);
});
