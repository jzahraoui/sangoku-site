import assert from 'node:assert/strict';
import { test } from 'node:test';

import { removeFinalDeadFilters } from '../../src/autoeq/filterCleanup.js';

function makeAdapter() {
  return {
    isUpperEdgeBoost(filter, maxAllowedFc) {
      return filter.gain > 0 && filter.fc >= maxAllowedFc;
    },
  };
}

test('removeFinalDeadFilters removes near-zero gain filters', () => {
  const filters = [
    { fc: 100, Q: 1, gain: 0.05 },
    { fc: 200, Q: 1, gain: -0.09 },
    { fc: 300, Q: 1, gain: 1 },
  ];

  const result = removeFinalDeadFilters(filters, {
    equalizerAdapter: makeAdapter(),
    matchRangeEnd: 20000,
  });

  assert.deepEqual(result, { removedCount: 2 });
  assert.deepEqual(filters, [{ fc: 300, Q: 1, gain: 1 }]);
});

test('removeFinalDeadFilters keeps gains with abs(gain) >= 0.1', () => {
  const filters = [
    { fc: 100, Q: 1, gain: 0.1 },
    { fc: 200, Q: 1, gain: -0.1 },
  ];

  const result = removeFinalDeadFilters(filters, {
    equalizerAdapter: makeAdapter(),
    matchRangeEnd: 20000,
  });

  assert.deepEqual(result, { removedCount: 0 });
  assert.equal(filters.length, 2);
});

test('removeFinalDeadFilters removes upper-edge boost filters', () => {
  const filters = [
    { fc: 1000, Q: 1, gain: 3 },
    { fc: 19800, Q: 1, gain: 3 },
  ];

  const result = removeFinalDeadFilters(filters, {
    equalizerAdapter: makeAdapter(),
    matchRangeEnd: 20000,
  });

  assert.deepEqual(result, { removedCount: 1 });
  assert.deepEqual(filters, [{ fc: 1000, Q: 1, gain: 3 }]);
});

test('removeFinalDeadFilters keeps upper-edge cuts', () => {
  const filters = [{ fc: 19800, Q: 1, gain: -3 }];

  const result = removeFinalDeadFilters(filters, {
    equalizerAdapter: makeAdapter(),
    matchRangeEnd: 20000,
  });

  assert.deepEqual(result, { removedCount: 0 });
  assert.equal(filters.length, 1);
});

test('removeFinalDeadFilters handles empty filter arrays', () => {
  const filters = [];

  const result = removeFinalDeadFilters(filters, {
    equalizerAdapter: makeAdapter(),
    matchRangeEnd: 20000,
  });

  assert.deepEqual(result, { removedCount: 0 });
  assert.deepEqual(filters, []);
});
