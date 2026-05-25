import test from 'node:test';
import assert from 'node:assert/strict';

import { optimizeWithNewtonBfgs } from '../../src/optimization/NewtonBfgsOptimizer.js';

test('optimizeWithNewtonBfgs solves a 1D quadratic', async () => {
  const result = await optimizeWithNewtonBfgs(x => (x[0] - 3) ** 2, [0], {
    maxIterations: 100,
    ndigit: 8,
  });

  assert.equal(result.converged, true);
  assert.ok(Math.abs(result.x[0] - 3) < 1e-4, `expected x≈3, got ${result.x[0]}`);
  assert.ok(result.fval < 1e-8, `expected near-zero fval, got ${result.fval}`);
});

test('optimizeWithNewtonBfgs solves a 2D quadratic', async () => {
  const result = await optimizeWithNewtonBfgs(
    x => (x[0] - 2) ** 2 + (x[1] + 1) ** 2,
    [0, 0],
    {
      maxIterations: 100,
      ndigit: 8,
    },
  );

  assert.equal(result.converged, true);
  assert.ok(Math.abs(result.x[0] - 2) < 1e-4, `expected x≈2, got ${result.x[0]}`);
  assert.ok(Math.abs(result.x[1] + 1) < 1e-4, `expected y≈-1, got ${result.x[1]}`);
  assert.ok(result.fval < 1e-8, `expected near-zero fval, got ${result.fval}`);
});

test('optimizeWithNewtonBfgs reduces the Rosenbrock objective', async () => {
  const result = await optimizeWithNewtonBfgs(
    x => (1 - x[0]) ** 2 + 100 * (x[1] - x[0] ** 2) ** 2,
    [-1, 1],
    {
      maxIterations: 500,
      ndigit: 8,
    },
  );

  assert.ok(result.fval < 1e-4, `expected low Rosenbrock value, got ${result.fval}`);
  assert.ok(Math.abs(result.x[0] - 1) < 5e-3, `expected x≈1, got ${result.x[0]}`);
  assert.ok(Math.abs(result.x[1] - 1) < 5e-3, `expected y≈1, got ${result.x[1]}`);
});
