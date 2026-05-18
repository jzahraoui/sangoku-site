/**
 * autoeq-characterization.test.js
 *
 * Golden-master test: verifies that the full AutoEQ pipeline produces stable
 * results on a known example across refactoring iterations.
 *
 * The assertions are intentionally loose (range checks, not exact snapshots)
 * so the test acts as a guardrail without becoming a refactoring blocker.
 * Tighten individual checks here when a specific output must be locked down.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AutoEQCalculator } from '../src/index.js';
import { loadTestExample, createConfig } from './test-config.js';

function roundFilter(filter) {
  return {
    fc: Number(filter.fc.toFixed(1)),
    Q: Number(filter.Q.toFixed(3)),
    gain: Number(filter.gain.toFixed(2)),
  };
}

test('AutoEQ characterization: exemple1 pipeline produces stable output', async () => {
  const { measuredResponse, targetResponse } = loadTestExample('exemple1');

  const calculator = new AutoEQCalculator(
    createConfig(
      {
        numFilters: 20,
        enableBeatRewOptimization: false,
        enableCandidatePlacement: false,
      },
      { silent: true },
    ),
  );

  const result = await calculator.calculate(measuredResponse, targetResponse);

  // --- Basic structure ---
  assert.ok(result, 'calculate() must return a result object');
  assert.ok(Array.isArray(result.filters), 'result.filters must be an array');
  assert.ok(result.filters.length > 0, 'At least one filter must be placed');
  assert.ok(result.filters.length <= 20, 'Filter count must not exceed numFilters');

  // --- MSE convergence ---
  assert.ok(Number.isFinite(result.initialMSE), 'initialMSE must be finite');
  assert.ok(Number.isFinite(result.finalMSE), 'finalMSE must be finite');
  assert.ok(result.finalMSE < result.initialMSE, 'Pipeline must improve MSE');

  // --- Sanity-check improvement magnitude ---
  const improvementPct = (1 - result.finalMSE / result.initialMSE) * 100;
  assert.ok(
    improvementPct >= 5,
    `Expected ≥5% MSE improvement, got ${improvementPct.toFixed(1)}%`,
  );

  // --- Quality report ---
  assert.ok(result.quality, 'result.quality must be present');
  assert.ok(
    Number.isFinite(result.quality.score),
    'quality.score must be a finite number',
  );
  assert.ok(result.quality.score >= 0, 'quality.score must be non-negative');

  // --- Filter parameter sanity ---
  const filters = result.filters.map(roundFilter);
  for (const f of filters) {
    assert.ok(f.fc > 0 && f.fc < 48000, `fc=${f.fc} out of range`);
    assert.ok(f.Q > 0 && f.Q <= 20, `Q=${f.Q} out of range`);
    assert.ok(Number.isFinite(f.gain), `gain=${f.gain} is not finite`);
    assert.ok(Math.abs(f.gain) <= 25, `|gain|=${Math.abs(f.gain)} unreasonably large`);
  }
});
