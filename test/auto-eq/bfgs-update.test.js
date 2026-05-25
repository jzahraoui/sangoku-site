import test from 'node:test';
import assert from 'node:assert/strict';

import { updateCholeskyBfgsFactor } from '../../src/optimization/bfgsUpdate.js';

const MACHINE_EPSILON = 1.12e-16;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an identity Cholesky factor of size n×n (1-indexed 2D array).
 * lowerFactor[i][i] = 1, all off-diagonal entries 0.
 */
function identityFactor(n) {
  const L = new Array(n + 1);
  for (let row = 0; row <= n; row++) {
    L[row] = new Array(n + 1).fill(0);
  }
  for (let i = 1; i <= n; i++) {
    L[i][i] = 1;
  }
  return L;
}

/**
 * Build a full update context for n dimensions using the provided values.
 * Work arrays (positionDelta, gradientDelta, projectedStep, correctionVector)
 * are zeroed; they will be filled by updateCholeskyBfgsFactor.
 */
function makeContext(
  n,
  previousPoint,
  previousGradient,
  candidatePoint,
  candidateGradient,
  lowerFactor,
  overrides = {},
) {
  return {
    length: n,
    previousPoint,
    previousGradient,
    lowerFactor,
    candidatePoint,
    candidateGradient,
    machineEpsilon: MACHINE_EPSILON,
    iterationCountRef: [0, 1], // iteration 1 → triggers firstUpdate
    relativeNoiseFloor: 1e-8,
    gradientModeRef: [0, 0],
    firstUpdateRef: [false, true],
    positionDelta: new Array(n + 1).fill(0),
    gradientDelta: new Array(n + 1).fill(0),
    projectedStep: new Array(n + 1).fill(0),
    correctionVector: new Array(n + 1).fill(0),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Case 1 — update with positive curvature stays finite and positive
// ---------------------------------------------------------------------------

test('bfgs-update: 1D positive-curvature update yields finite positive factor', () => {
  // x: 0 → 1,  gradient: 0 → 2  (f(x) = x²  →  f'(x) = 2x)
  // curvature = (1-0)*(2-0) = 2 > 0
  const L = identityFactor(1);
  const ctx = makeContext(
    1,
    [0, 0],
    [0, 0], // previousPoint, previousGradient
    [0, 1],
    [0, 2], // candidatePoint, candidateGradient
    L,
  );

  updateCholeskyBfgsFactor(ctx);

  assert.ok(Number.isFinite(L[1][1]), `lowerFactor[1][1] must be finite, got ${L[1][1]}`);
  assert.ok(L[1][1] > 0, `lowerFactor[1][1] must be positive, got ${L[1][1]}`);
});

// ---------------------------------------------------------------------------
// Case 2 — update is skipped when curvature is negative
// ---------------------------------------------------------------------------

test('bfgs-update: skipped when curvature is negative (gradient delta opposes step)', () => {
  // positionDelta=[+1], gradientDelta=[-2] → curvature = -2 < threshold → skip
  const L = identityFactor(1);
  const diagonalBefore = L[1][1];

  const ctx = makeContext(
    1,
    [0, 0],
    [0, 3], // previousGradient = 3
    [0, 1],
    [0, 1], // candidateGradient = 1  →  delta = -2
    L,
  );

  updateCholeskyBfgsFactor(ctx);

  // maybeScaleInitialFactor is NOT reached because we return early on curvature check
  assert.equal(
    L[1][1],
    diagonalBefore,
    'lowerFactor must be unchanged when curvature < 0',
  );
});

// ---------------------------------------------------------------------------
// Case 3 — 2D update keeps the factor usable (all diagonal entries finite)
// ---------------------------------------------------------------------------

test('bfgs-update: 2D update produces a factor with finite diagonal entries', () => {
  // f(x,y) = x² + y²  →  gradient at (1,1) = (2,2), at (0,0) = (0,0)
  const L = identityFactor(2);
  const ctx = makeContext(
    2,
    [0, 0, 0],
    [0, 0, 0], // previousPoint, previousGradient
    [0, 1, 1],
    [0, 2, 2], // candidatePoint, candidateGradient
    L,
  );

  updateCholeskyBfgsFactor(ctx);

  assert.ok(Number.isFinite(L[1][1]), `L[1][1] must be finite, got ${L[1][1]}`);
  assert.ok(Number.isFinite(L[2][2]), `L[2][2] must be finite, got ${L[2][2]}`);
  assert.ok(Number.isFinite(L[2][1]), `L[2][1] must be finite, got ${L[2][1]}`);
});

// ---------------------------------------------------------------------------
// Case 4 — second call (firstUpdateRef already false) also stays finite
// ---------------------------------------------------------------------------

test('bfgs-update: subsequent update (firstUpdateRef=false) stays finite', () => {
  const L = identityFactor(1);

  // First update
  const ctx1 = makeContext(1, [0, 0], [0, 0], [0, 1], [0, 2], L, {
    iterationCountRef: [0, 1],
  });
  updateCholeskyBfgsFactor(ctx1);

  // Second update — firstUpdateRef is now false (set by the first call)
  const ctx2 = makeContext(1, [0, 1], [0, 2], [0, 2], [0, 4], L, {
    iterationCountRef: [0, 2], // iteration 2 → no forced firstUpdate
    firstUpdateRef: ctx1.firstUpdateRef, // share the ref-box
  });
  updateCholeskyBfgsFactor(ctx2);

  assert.ok(
    Number.isFinite(L[1][1]),
    `L[1][1] must be finite after second update, got ${L[1][1]}`,
  );
  assert.ok(L[1][1] > 0, `L[1][1] must remain positive after second update`);
});

// ---------------------------------------------------------------------------
// Case 5 — no NaN in factor after update
// ---------------------------------------------------------------------------

test('bfgs-update: no NaN in factor after update', () => {
  const L = identityFactor(2);
  const ctx = makeContext(2, [0, 0, 0], [0, 0, 0], [0, 1, 2], [0, 2, 4], L);

  updateCholeskyBfgsFactor(ctx);

  for (let row = 1; row <= 2; row++) {
    for (let col = 1; col <= 2; col++) {
      assert.ok(!Number.isNaN(L[row][col]), `L[${row}][${col}] must not be NaN`);
    }
  }
});
