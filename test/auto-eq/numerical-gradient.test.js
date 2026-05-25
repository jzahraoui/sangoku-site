import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeForwardDifferenceGradient,
  computeCentralDifferenceGradient,
} from '../../src/optimization/numericalGradient.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** f(x,y) = x² + 3y²  →  ∇f = [2x, 6y] */
function quadratic(point1Indexed) {
  return point1Indexed[1] ** 2 + 3 * point1Indexed[2] ** 2;
}

// ---------------------------------------------------------------------------
// computeForwardDifferenceGradient
// ---------------------------------------------------------------------------

test('forward-difference gradient of x²+3y² at (2,1)', () => {
  const point = [0, 2, 1];
  const gradient = [0, 0, 0];
  const inverseScale = [0, 1, 1];
  const objectiveValueRef = [null, quadratic(point)]; // f(2,1) = 4+3 = 7

  computeForwardDifferenceGradient(
    2,
    point,
    quadratic,
    objectiveValueRef,
    gradient,
    inverseScale,
    1e-8,
  );

  // expected: [2*2, 6*1] = [4, 6]
  // forward-difference error is O(√noise) ≈ 1e-4 * |x|, so tolerance is 1e-3
  assert.ok(Math.abs(gradient[1] - 4) < 1e-3, `∂f/∂x ≈ 4, got ${gradient[1]}`);
  assert.ok(Math.abs(gradient[2] - 6) < 1e-3, `∂f/∂y ≈ 6, got ${gradient[2]}`);
});

test('forward-difference gradient restores point after computation', () => {
  const point = [0, 3, 2];
  const gradient = [0, 0, 0];
  const inverseScale = [0, 1, 1];
  const objectiveValueRef = [null, quadratic(point)];
  const before = [0, point[1], point[2]];

  computeForwardDifferenceGradient(
    2,
    point,
    quadratic,
    objectiveValueRef,
    gradient,
    inverseScale,
    1e-8,
  );

  assert.equal(point[1], before[1], 'point[1] must be restored');
  assert.equal(point[2], before[2], 'point[2] must be restored');
});

test('forward-difference gradient of f(x)=x² (1D)', () => {
  const point = [0, 5];
  const gradient = [0, 0];
  const inverseScale = [0, 1];
  const objectiveValueRef = [null, 25];

  computeForwardDifferenceGradient(
    1,
    point,
    p => p[1] ** 2,
    objectiveValueRef,
    gradient,
    inverseScale,
    1e-8,
  );

  // ∂f/∂x = 2x = 10
  assert.ok(Math.abs(gradient[1] - 10) < 1e-3, `expected ≈10, got ${gradient[1]}`);
});

// ---------------------------------------------------------------------------
// computeCentralDifferenceGradient
// ---------------------------------------------------------------------------

test('central-difference gradient of x²+3y² at (2,1)', () => {
  const point = [0, 2, 1];
  const gradient = [0, 0, 0];
  const inverseScale = [0, 1, 1];

  computeCentralDifferenceGradient(2, point, quadratic, inverseScale, 1e-8, gradient);

  // expected: [4, 6]
  assert.ok(Math.abs(gradient[1] - 4) < 1e-5, `∂f/∂x ≈ 4, got ${gradient[1]}`);
  assert.ok(Math.abs(gradient[2] - 6) < 1e-5, `∂f/∂y ≈ 6, got ${gradient[2]}`);
});

test('central-difference gradient restores point after computation', () => {
  const point = [0, 1, 2];
  const gradient = [0, 0, 0];
  const inverseScale = [0, 1, 1];
  const before = [0, point[1], point[2]];

  computeCentralDifferenceGradient(2, point, quadratic, inverseScale, 1e-8, gradient);

  assert.equal(point[1], before[1], 'point[1] must be restored');
  assert.equal(point[2], before[2], 'point[2] must be restored');
});

test('central-difference gradient: at origin gradient is near zero', () => {
  // f(x,y)=x²+3y²  →  ∇f(0,0) = [0,0]
  const point = [0, 0, 0];
  const gradient = [0, 0, 0];
  const inverseScale = [0, 1, 1];

  computeCentralDifferenceGradient(2, point, quadratic, inverseScale, 1e-8, gradient);

  assert.ok(Math.abs(gradient[1]) < 1e-6, `∂f/∂x should be 0, got ${gradient[1]}`);
  assert.ok(Math.abs(gradient[2]) < 1e-6, `∂f/∂y should be 0, got ${gradient[2]}`);
});

test('central-difference is more accurate than forward for cubic at non-zero', () => {
  // f(x) = x³  →  f'(x) = 3x²  →  f'(2) = 12
  const objectiveFn = p => p[1] ** 3;
  const point = [0, 2];
  const gradient_fwd = [0, 0];
  const gradient_cen = [0, 0];
  const inverseScale = [0, 1];
  const noise = 1e-8;

  computeForwardDifferenceGradient(
    1,
    point,
    objectiveFn,
    [null, 8],
    gradient_fwd,
    inverseScale,
    noise,
  );
  computeCentralDifferenceGradient(
    1,
    point,
    objectiveFn,
    inverseScale,
    noise,
    gradient_cen,
  );

  const errorFwd = Math.abs(gradient_fwd[1] - 12);
  const errorCen = Math.abs(gradient_cen[1] - 12);
  assert.ok(
    errorCen < errorFwd,
    `central (${errorCen}) should be more accurate than forward (${errorFwd})`,
  );
});
