import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cosForward, cosInverse } from '../src/optimization/parameterTransform.js';

const PI = Math.PI;

test('cosInverse(cosForward(x)) round-trips within bounds', () => {
  const cases = [
    [50, 20, 100],
    [3, 1, 10],
    [0, -6, 6],
    [6, 0, 12],
  ];
  for (const [x, lo, hi] of cases) {
    const t = cosForward(x, lo, hi);
    const recovered = cosInverse(t, lo, hi);
    assert.ok(
      Math.abs(recovered - x) < 1e-10,
      `round-trip failed for x=${x} [${lo},${hi}]: got ${recovered}`,
    );
  }
});

test('cosForward clamps x below lo to lo', () => {
  const t = cosForward(-5, 0, 10);
  const recovered = cosInverse(t, 0, 10);
  assert.ok(Math.abs(recovered - 0) < 1e-10);
});

test('cosForward clamps x above hi to hi', () => {
  const t = cosForward(20, 0, 10);
  const recovered = cosInverse(t, 0, 10);
  assert.ok(Math.abs(recovered - 10) < 1e-10);
});

test('cosForward returns PI/2 when lo >= hi', () => {
  assert.equal(cosForward(5, 5, 5), PI / 2);
  assert.equal(cosForward(5, 6, 5), PI / 2);
});

test('cosInverse maps t=0 to hi and t=PI to lo', () => {
  const lo = 1;
  const hi = 10;
  assert.ok(Math.abs(cosInverse(0, lo, hi) - hi) < 1e-10);
  assert.ok(Math.abs(cosInverse(PI, lo, hi) - lo) < 1e-10);
});
