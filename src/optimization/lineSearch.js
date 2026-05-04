/**
 * lineSearch.js
 *
 * Armijo backtracking line search for the Newton-BFGS optimizer.
 * All arrays use a 1-based layout: element i is at array[i] (array[0] unused).
 */

import {
  dotProduct1Indexed,
  copySignedMagnitude,
  scaleVector,
  computeScaledStepNorm,
  computeMinimumAlpha,
  writeCandidatePoint,
} from './vectorOps.js';

const ARMIJO_FACTOR = 1e-4;
const LINE_SEARCH_MAX_ITERATIONS = 20;

/**
 * Computes the next trial alpha via quadratic (first call) or cubic interpolation.
 *
 * @param {Object} params
 * @param {number} params.alpha
 * @param {number} params.previousAlpha
 * @param {number} params.previousValue
 * @param {number[]} params.candidateValueRef  - 1-indexed ref-box
 * @param {number[]} params.currentValueRef    - 1-indexed ref-box
 * @param {number}   params.directionalSlope
 * @returns {number}
 */
function computeBacktrackAlpha({
  alpha,
  previousAlpha,
  previousValue,
  candidateValueRef,
  currentValueRef,
  directionalSlope,
}) {
  if (alpha === 1) {
    return (
      -directionalSlope /
      (2 * (candidateValueRef[1] - currentValueRef[1] - directionalSlope))
    );
  }

  const currentResidual =
    candidateValueRef[1] - currentValueRef[1] - alpha * directionalSlope;
  const previousResidual =
    previousValue - currentValueRef[1] - previousAlpha * directionalSlope;
  const inverseAlphaDelta = 1 / (alpha - previousAlpha);
  const cubicA =
    inverseAlphaDelta *
    (currentResidual / (alpha * alpha) -
      previousResidual / (previousAlpha * previousAlpha));
  const cubicB =
    inverseAlphaDelta *
    ((previousResidual * alpha) / (previousAlpha * previousAlpha) -
      (currentResidual * previousAlpha) / (alpha * alpha));
  const discriminant = cubicB * cubicB - 3 * cubicA * directionalSlope;

  let nextAlpha;
  if (discriminant <= cubicB * cubicB) {
    nextAlpha =
      (-cubicB - copySignedMagnitude(1, cubicA) * Math.sqrt(discriminant)) / (3 * cubicA);
  } else {
    nextAlpha =
      (-cubicB + copySignedMagnitude(1, cubicA) * Math.sqrt(discriminant)) / (3 * cubicA);
  }

  return Math.min(nextAlpha, 0.5 * alpha);
}

/**
 * Armijo backtracking line search.
 *
 * Modifies `context.searchDirection` in-place if the scaled step norm exceeds
 * `context.maxStepRef[1]`. Writes the accepted trial point into
 * `context.candidatePoint` and its value into `context.candidateValueRef[1]`.
 *
 * On exit `context.lineSearchStatusRef[1]` is:
 *   0 – step accepted (Armijo satisfied)
 *   1 – step too small (alpha dropped below minimumAlpha)
 *   2 – max iterations reached without acceptance
 *
 * @param {Object} context
 * @param {number}   context.length
 * @param {number[]} context.currentPoint       - 1-indexed
 * @param {number[]} context.currentValueRef    - 1-indexed ref-box
 * @param {number[]} context.currentGradient    - 1-indexed
 * @param {number[]} context.searchDirection    - 1-indexed, modified in-place when clipped
 * @param {number[]} context.candidatePoint     - 1-indexed, written
 * @param {number[]} context.candidateValueRef  - 1-indexed ref-box, written
 * @param {Function} context.objectiveFn        - receives 1-indexed point, returns scalar
 * @param {boolean[]} context.maxStepTakenRef   - 1-indexed ref-box, written
 * @param {number[]} context.lineSearchStatusRef - 1-indexed ref-box, written
 * @param {number[]} context.maxStepRef         - 1-indexed ref-box
 * @param {number[]} context.stepToleranceRef   - 1-indexed ref-box
 * @param {number[]} context.inverseScale       - 1-indexed
 */
export function performLineSearch(context) {
  const {
    length,
    currentPoint,
    currentValueRef,
    currentGradient,
    searchDirection,
    candidatePoint,
    candidateValueRef,
    objectiveFn,
    maxStepTakenRef,
    lineSearchStatusRef,
    maxStepRef,
    stepToleranceRef,
    inverseScale,
  } = context;

  maxStepTakenRef[1] = false;
  lineSearchStatusRef[1] = 2;

  let scaledStepNorm = computeScaledStepNorm(length, inverseScale, searchDirection);

  if (scaledStepNorm > maxStepRef[1]) {
    scaleVector(length, maxStepRef[1] / scaledStepNorm, searchDirection, searchDirection);
    scaledStepNorm = maxStepRef[1];
  }

  const directionalSlope = dotProduct1Indexed(length, currentGradient, searchDirection);
  const minimumAlpha = computeMinimumAlpha(
    length,
    currentPoint,
    inverseScale,
    searchDirection,
    stepToleranceRef,
  );

  let alpha = 1;
  let previousAlpha = 0;
  let previousValue = 0;
  let iteration = 0;

  while (lineSearchStatusRef[1] >= 2 && iteration < LINE_SEARCH_MAX_ITERATIONS) {
    iteration++;
    writeCandidatePoint(length, currentPoint, searchDirection, alpha, candidatePoint);
    candidateValueRef[1] = objectiveFn(candidatePoint);

    if (
      candidateValueRef[1] <=
      currentValueRef[1] + directionalSlope * ARMIJO_FACTOR * alpha
    ) {
      lineSearchStatusRef[1] = 0;
      if (alpha === 1 && scaledStepNorm > 0.99 * maxStepRef[1]) {
        maxStepTakenRef[1] = true;
      }
      continue;
    }

    if (alpha < minimumAlpha) {
      lineSearchStatusRef[1] = 1;
      continue;
    }

    const nextAlpha = computeBacktrackAlpha({
      alpha,
      previousAlpha,
      previousValue,
      candidateValueRef,
      currentValueRef,
      directionalSlope,
    });

    previousAlpha = alpha;
    previousValue = candidateValueRef[1];
    alpha = nextAlpha < alpha / 10 ? alpha * 0.1 : nextAlpha;
  }
}
