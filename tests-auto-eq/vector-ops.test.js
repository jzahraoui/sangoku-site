import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dotProduct1Indexed,
  norm2Stable1Indexed,
  copySignedMagnitude,
  scaleVector,
  computeScaledStepNorm,
  computeMinimumAlpha,
  writeCandidatePoint,
} from '../src/optimization/vectorOps.js';

// ---------------------------------------------------------------------------
// dotProduct1Indexed
// ---------------------------------------------------------------------------

test('dotProduct1Indexed: basic dot product', () => {
  // 1-indexed: [_,1,2,3] · [_,4,5,6] = 4+10+18 = 32
  const left = [0, 1, 2, 3];
  const right = [0, 4, 5, 6];
  assert.equal(dotProduct1Indexed(3, left, right), 32);
});

test('dotProduct1Indexed: length 1', () => {
  assert.equal(dotProduct1Indexed(1, [0, 7], [0, 3]), 21);
});

test('dotProduct1Indexed: orthogonal vectors give 0', () => {
  const left = [0, 1, 0, 0];
  const right = [0, 0, 1, 0];
  assert.equal(dotProduct1Indexed(3, left, right), 0);
});

test('dotProduct1Indexed: 6 elements (exercises stride-5 + remainder)', () => {
  // [1..6] · [1..6] = 1+4+9+16+25+36 = 91
  const left = [0, 1, 2, 3, 4, 5, 6];
  const right = [0, 1, 2, 3, 4, 5, 6];
  assert.equal(dotProduct1Indexed(6, left, right), 91);
});

// ---------------------------------------------------------------------------
// norm2Stable1Indexed
// ---------------------------------------------------------------------------

test('norm2Stable1Indexed: Pythagorean triple (3,4) = 5', () => {
  const v = [0, 3, 4];
  assert.ok(Math.abs(norm2Stable1Indexed(2, v) - 5) < 1e-12);
});

test('norm2Stable1Indexed: length 1', () => {
  assert.ok(Math.abs(norm2Stable1Indexed(1, [0, -7]) - 7) < 1e-12);
});

test('norm2Stable1Indexed: length 0 returns 0', () => {
  assert.equal(norm2Stable1Indexed(0, []), 0);
});

test('norm2Stable1Indexed: large values do not overflow', () => {
  const big = 1e200;
  const v = [0, big, big, big, big];
  const expected = big * 2; // sqrt(4) * big
  assert.ok(Math.abs(norm2Stable1Indexed(4, v) - expected) / expected < 1e-12);
});

// ---------------------------------------------------------------------------
// copySignedMagnitude
// ---------------------------------------------------------------------------

test('copySignedMagnitude: positive signSource keeps magnitude positive', () => {
  assert.equal(copySignedMagnitude(5, 3), 5);
});

test('copySignedMagnitude: negative signSource makes magnitude negative', () => {
  assert.equal(copySignedMagnitude(5, -1), -5);
});

test('copySignedMagnitude: magnitude is already negative, positive signSource', () => {
  assert.equal(copySignedMagnitude(-5, 2), 5);
});

// ---------------------------------------------------------------------------
// scaleVector
// ---------------------------------------------------------------------------

test('scaleVector: multiplies each element by scalar', () => {
  const input = [0, 1, 2, 3];
  const output = [0, 0, 0, 0];
  scaleVector(3, 2, input, output);
  assert.deepEqual(output, [0, 2, 4, 6]);
});

test('scaleVector: scalar 0 produces zeros', () => {
  const input = [0, 7, 8, 9];
  const output = [0, 0, 0, 0];
  scaleVector(3, 0, input, output);
  assert.deepEqual(output, [0, 0, 0, 0]);
});

// ---------------------------------------------------------------------------
// computeScaledStepNorm
// ---------------------------------------------------------------------------

test('computeScaledStepNorm: unit inverseScale = norm2 of direction', () => {
  // inverseScale all 1, direction [3,4] → norm = 5
  const inverseScale = [0, 1, 1];
  const direction = [0, 3, 4];
  assert.ok(Math.abs(computeScaledStepNorm(2, inverseScale, direction) - 5) < 1e-12);
});

test('computeScaledStepNorm: non-unit scale factors', () => {
  // inverseScale=[2,3], direction=[1,1] → sqrt(4+9) = sqrt(13)
  const inverseScale = [0, 2, 3];
  const direction = [0, 1, 1];
  assert.ok(
    Math.abs(computeScaledStepNorm(2, inverseScale, direction) - Math.sqrt(13)) < 1e-12,
  );
});

// ---------------------------------------------------------------------------
// computeMinimumAlpha
// ---------------------------------------------------------------------------

test('computeMinimumAlpha: returns tolerance / maxRelativeStep', () => {
  // point=[0,1], inverseScale=[0,1,1], direction=[0,4,3]
  // relStep[1] = |4| / max(|0|, 1) = 4, relStep[2] = |3| / max(|1|, 1) = 3  → max = 4
  // stepTol = 0.1 → alpha = 0.1/4 = 0.025
  const currentPoint = [0, 0, 1];
  const inverseScale = [0, 1, 1];
  const searchDirection = [0, 4, 3];
  const stepToleranceRef = [null, 0.1];
  const alpha = computeMinimumAlpha(
    2,
    currentPoint,
    inverseScale,
    searchDirection,
    stepToleranceRef,
  );
  assert.ok(Math.abs(alpha - 0.025) < 1e-14);
});

// ---------------------------------------------------------------------------
// writeCandidatePoint
// ---------------------------------------------------------------------------

test('writeCandidatePoint: candidate = current + alpha * direction', () => {
  const currentPoint = [0, 1, 2];
  const searchDirection = [0, 3, 4];
  const candidate = [0, 0, 0];
  writeCandidatePoint(2, currentPoint, searchDirection, 2, candidate);
  assert.deepEqual(candidate, [0, 7, 10]);
});

test('writeCandidatePoint: alpha=0 leaves current unchanged', () => {
  const currentPoint = [0, 5, 6];
  const searchDirection = [0, 9, 9];
  const candidate = [0, 0, 0];
  writeCandidatePoint(2, currentPoint, searchDirection, 0, candidate);
  assert.deepEqual(candidate, [0, 5, 6]);
});
