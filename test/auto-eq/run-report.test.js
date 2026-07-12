import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FilterQualityEvaluator } from '../../src/autoeq/FilterQualityEvaluator.js';
import {
  buildRunReport,
  computeMaxCombinedBoostDb,
} from '../../src/autoeq/runReport.js';
import { createAutoEQConfig } from '../../src/autoeq/AutoEQConfig.js';

const evaluator = new FilterQualityEvaluator(createAutoEQConfig({}));

// ─── Verdicts par filtre (FR-008a/FR-008b) ──────────────────────────────────

test('verdicts: PASS for reasonable filters', () => {
  const verdicts = evaluator.buildFilterVerdicts([
    { fc: 100, Q: 5, gain: -6 },
    { fc: 1000, Q: 4, gain: 3 },
  ]);
  assert.deepEqual(
    verdicts.map(v => v.verdict),
    ['PASS', 'PASS'],
  );
  assert.deepEqual(verdicts[0].warnings, []);
});

test('verdicts: below 300 Hz — WARN above Q=8, FAIL above Q=10', () => {
  const verdicts = evaluator.buildFilterVerdicts([
    { fc: 120, Q: 9, gain: -6 },
    { fc: 120, Q: 11, gain: -6 },
  ]);
  assert.equal(verdicts[0].verdict, 'WARN');
  assert.equal(verdicts[1].verdict, 'FAIL');
  assert.ok(verdicts[1].warnings[0].includes('plafond'));
});

test('verdicts: at or above 300 Hz — WARN above Q=10, FAIL above Q=12', () => {
  const verdicts = evaluator.buildFilterVerdicts([
    { fc: 300, Q: 10.5, gain: -3 },
    { fc: 5000, Q: 13, gain: -3 },
  ]);
  assert.equal(verdicts[0].verdict, 'WARN');
  assert.equal(verdicts[1].verdict, 'FAIL');
});

test('verdicts: boost above 3 kHz raises a WARN', () => {
  const [verdict] = evaluator.buildFilterVerdicts([{ fc: 6000, Q: 2, gain: 2 }]);
  assert.equal(verdict.verdict, 'WARN');
  assert.ok(verdict.warnings[0].includes('3 kHz'));
});

// ─── Boost combiné ───────────────────────────────────────────────────────────

test('computeMaxCombinedBoostDb reflects overlapping boosts', () => {
  const scanFreqs = [];
  for (let f = 20; f <= 2000; f *= 1.02) scanFreqs.push(f);
  const ctx = { scanFreqs };
  const single = computeMaxCombinedBoostDb([{ fc: 500, Q: 2, gain: 3 }], ctx, 48000);
  const double = computeMaxCombinedBoostDb(
    [
      { fc: 500, Q: 2, gain: 3 },
      { fc: 520, Q: 2, gain: 3 },
    ],
    ctx,
    48000,
  );
  assert.ok(Math.abs(single - 3) < 0.2, `single boost ≈ 3 dB, got ${single}`);
  assert.ok(double > 5, `overlapping boosts must accumulate, got ${double}`);
  assert.equal(computeMaxCombinedBoostDb([], ctx, 48000), 0);
});

// ─── Verdict global du run ───────────────────────────────────────────────────

const goodQuality = { fullRms: 1, criticalRms: 0.5, positiveRms: 0.3, maxOvershoot: 0.8 };
const beforeQuality = {
  fullRms: 4,
  criticalRms: 3,
  positiveRms: 2,
  maxOvershoot: 2,
};

function reportWith(overrides = {}) {
  return buildRunReport({
    filters: [{ fc: 100, Q: 2, gain: -4 }],
    beforeQuality,
    afterQuality: goodQuality,
    filterVerdicts: [{ fc: 100, Q: 2, gain: -4, verdict: 'PASS', warnings: [] }],
    maxCombinedBoostDb: 2,
    overallMaxBoostDb: 6,
    maxAllowedOvershoot: 1.5,
    ...overrides,
  });
}

test('run verdict PASS when everything is clean', () => {
  const report = reportWith();
  assert.equal(report.verdict, 'PASS');
  assert.deepEqual(report.warnings, []);
  assert.ok(report.improvementPct > 10);
  assert.equal(report.after.fullRms, 1);
});

test('run verdict FAIL when a filter fails or RMS degrades', () => {
  const failFilter = reportWith({
    filterVerdicts: [{ fc: 100, Q: 12, gain: -4, verdict: 'FAIL', warnings: ['Q'] }],
  });
  assert.equal(failFilter.verdict, 'FAIL');

  const degraded = reportWith({
    afterQuality: { ...goodQuality, fullRms: 5 },
  });
  assert.equal(degraded.verdict, 'FAIL');
});

test('run verdict WARN on residual overshoot, weak improvement or boost over limit', () => {
  const overshoot = reportWith({
    afterQuality: { ...goodQuality, maxOvershoot: 2.2 },
  });
  assert.equal(overshoot.verdict, 'WARN');

  const weak = reportWith({
    afterQuality: { ...goodQuality, fullRms: 3.8 },
  });
  assert.equal(weak.verdict, 'WARN');
  assert.ok(weak.warnings.some(w => w.includes('%')));

  const boost = reportWith({ maxCombinedBoostDb: 7 });
  assert.equal(boost.verdict, 'WARN');
});

test('empty run (0 filter) is PASS — measurement already on target', () => {
  const report = buildRunReport({
    filters: [],
    beforeQuality: goodQuality,
    afterQuality: goodQuality,
    filterVerdicts: [],
    maxCombinedBoostDb: 0,
    overallMaxBoostDb: 6,
    maxAllowedOvershoot: 1.5,
  });
  assert.equal(report.verdict, 'PASS');
});
