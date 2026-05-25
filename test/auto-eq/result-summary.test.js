import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCalculationResult,
  logCalculationResult,
} from '../../src/autoeq/resultSummary.js';

test('buildCalculationResult computes improvement percentage', () => {
  const result = buildCalculationResult({
    filters: [],
    initialMSE: 10,
    finalMSE: 7,
    elapsed: 1234,
    quality: { score: 1 },
  });

  assert.equal(result.improvement, 30);
  assert.equal(result.initialMSE, 10);
  assert.equal(result.finalMSE, 7);
  assert.equal(result.elapsed, 1234);
  assert.deepEqual(result.quality, { score: 1 });
});

test('buildCalculationResult handles zero initialMSE', () => {
  const result = buildCalculationResult({
    filters: [],
    initialMSE: 0,
    finalMSE: 0,
    elapsed: 1,
    quality: null,
  });

  assert.equal(result.improvement, 0);
});

test('logCalculationResult logs final summary and sorts filters by frequency', () => {
  const filters = [
    { fc: 1000, Q: 1, gain: -3 },
    { fc: 100, Q: 2, gain: 2 },
  ];

  const logs = [];
  logCalculationResult(
    {
      filters,
      initialMSE: 5,
      finalMSE: 2.5,
      improvement: 50,
      elapsed: 1000,
      quality: null,
    },
    msg => logs.push(msg),
  );

  assert.equal(filters[0].fc, 100);
  assert.ok(logs.some(line => line.includes('Résultat Final')));
  assert.ok(logs.some(line => line.includes('MSE: 5.000 → 2.500')));
});
