import test from 'node:test';
import assert from 'node:assert/strict';

import { performLineSearch } from '../../src/optimization/lineSearch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal line-search context for a 1D problem.
 * All ref-boxes and work arrays are 1-indexed.
 *
 * @param {Object} overrides - Any fields to override on the default context.
 */
function makeContext(overrides = {}) {
  const ctx = {
    length: 1,
    currentPoint: [0, 0], // x0 = 0
    currentValueRef: [0, 1], // f(0) = (0-1)^2 = 1
    currentGradient: [0, -2], // f'(0) = 2(0-1) = -2
    searchDirection: [0, 1], // descent (slope = dot([-2],[+1]) = -2 < 0)
    candidatePoint: [0, 0],
    candidateValueRef: [0, 0],
    // f(x) = (x-1)^2 — receives 1-indexed array
    objectiveFn: p => (p[1] - 1) ** 2,
    maxStepTakenRef: [false, false],
    lineSearchStatusRef: [0, 2],
    maxStepRef: [0, 1000],
    stepToleranceRef: [0, Math.sqrt(1.12e-16)], // ≈ 1.06e-8
    inverseScale: [0, 1],
    ...overrides,
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Test 1 — accepts step at alpha=1 on a parabola
// ---------------------------------------------------------------------------

test('line-search: accepts step at alpha=1 on (x-1)^2 from x=0', () => {
  const ctx = makeContext();
  performLineSearch(ctx);

  assert.equal(ctx.lineSearchStatusRef[1], 0, 'should succeed (status 0)');
  // f(1) = 0 < f(0) = 1
  assert.ok(
    ctx.candidateValueRef[1] < ctx.currentValueRef[1],
    `candidateValue ${ctx.candidateValueRef[1]} should be < currentValue ${ctx.currentValueRef[1]}`,
  );
  assert.ok(Number.isFinite(ctx.candidateValueRef[1]), 'candidateValue must be finite');
});

// ---------------------------------------------------------------------------
// Test 2 — backtracks when alpha=1 overshoots, still finds a lower point
// ---------------------------------------------------------------------------

test('line-search: backtracks with large direction and still finds lower point', () => {
  // direction=[100] forces a huge step (x → 100); must be reduced
  const ctx = makeContext({
    searchDirection: [0, 100],
    // keep a large maxStepRef so no clipping happens and the backtrack exercises
    // computeBacktrackAlpha
    maxStepRef: [0, 1000],
  });
  performLineSearch(ctx);

  assert.equal(ctx.lineSearchStatusRef[1], 0, 'should eventually succeed (status 0)');
  assert.ok(
    ctx.candidateValueRef[1] < ctx.currentValueRef[1],
    `candidateValue ${ctx.candidateValueRef[1]} should be < currentValue ${ctx.currentValueRef[1]}`,
  );
});

// ---------------------------------------------------------------------------
// Test 3 — status=1 when alpha drops below minimumAlpha
// ---------------------------------------------------------------------------

test('line-search: sets status=1 when step becomes too small', () => {
  // stepToleranceRef = 2 → minimumAlpha = 2 / (|1|/max(|0|,1)) = 2
  // At iteration 1, alpha=1 < minimumAlpha=2 after Armijo fails → status=1
  const ctx = makeContext({
    // f(x) = x^2 + 1 — increases from x=0 going right; Armijo will fail
    objectiveFn: p => p[1] ** 2 + 1,
    // gradient is arbitrary but must give directionalSlope < 0
    currentValueRef: [0, 1], // f(0) = 1
    currentGradient: [0, -1], // slope = dot([-1],[+1]) = -1 < 0
    stepToleranceRef: [0, 2], // minimumAlpha = 2 > initial alpha=1
    maxStepRef: [0, 1000],
  });
  performLineSearch(ctx);

  assert.equal(
    ctx.lineSearchStatusRef[1],
    1,
    'should fail with status=1 (step too small)',
  );
});

// ---------------------------------------------------------------------------
// Test 4 — maxStepTakenRef=true when the full max step is used
// ---------------------------------------------------------------------------

test('line-search: sets maxStepTakenRef=true when max step is taken', () => {
  // direction=[100] is large → clipped to maxStepRef=1, scaledStepNorm=1=maxStep
  // Armijo check at alpha=1 passes (f(1)=0 < f(0)=1), scaledStepNorm > 0.99*maxStep → flag set
  const ctx = makeContext({
    searchDirection: [0, 100],
    maxStepRef: [0, 1], // clip will set direction to [0, 1], scaledStepNorm = 1
  });
  performLineSearch(ctx);

  assert.equal(ctx.lineSearchStatusRef[1], 0, 'should succeed (status 0)');
  assert.equal(ctx.maxStepTakenRef[1], true, 'maxStepTakenRef should be true');
});

// ---------------------------------------------------------------------------
// Test 5 — all output values are finite after a successful search
// ---------------------------------------------------------------------------

test('line-search: all output values are finite after successful search', () => {
  const ctx = makeContext();
  performLineSearch(ctx);

  assert.ok(Number.isFinite(ctx.candidateValueRef[1]), 'candidateValue must be finite');
  for (let i = 1; i <= ctx.length; i++) {
    assert.ok(
      Number.isFinite(ctx.candidatePoint[i]),
      `candidatePoint[${i}] must be finite`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 6 — does not modify currentPoint or currentValueRef
// ---------------------------------------------------------------------------

test('line-search: does not modify currentPoint or currentValueRef', () => {
  const ctx = makeContext();
  const originalPoint = ctx.currentPoint[1];
  const originalValue = ctx.currentValueRef[1];

  performLineSearch(ctx);

  assert.equal(ctx.currentPoint[1], originalPoint, 'currentPoint must be unchanged');
  assert.equal(
    ctx.currentValueRef[1],
    originalValue,
    'currentValueRef must be unchanged',
  );
});
