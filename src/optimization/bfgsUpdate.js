/**
 * bfgsUpdate.js
 *
 * Cholesky-factor BFGS update for the Newton-BFGS optimizer.
 * All arrays use a 1-based layout: element i is at array[i] (array[0] unused).
 * The Cholesky factor is stored in lowerFactor[row][column] (row >= column for
 * the lower-triangular entries).
 */

import { dotProduct1Indexed, norm2Stable1Indexed } from './vectorOps.js';

function multiplyLowerTranspose(length, lowerFactor, vector, result) {
  for (let row = 1; row <= length; row++) {
    let sum = 0;
    for (let column = 1; column <= row; column++) {
      sum += lowerFactor[row][column] * vector[column];
    }
    result[row] = sum;
  }
}

function multiplyLower(length, lowerFactor, vector, result) {
  for (let row = 1; row <= length; row++) {
    let sum = 0;
    for (let column = row; column <= length; column++) {
      sum += lowerFactor[column][row] * vector[column];
    }
    result[row] = sum;
  }
}

function applyGivensRotation(length, lowerFactor, rowIndex, a, b) {
  const nextRowIndex = rowIndex + 1;
  const radius = Math.hypot(a, b);
  const cosine = a / radius;
  const sine = b / radius;

  for (let column = rowIndex; column <= length; column++) {
    const firstValue = lowerFactor[rowIndex][column];
    const secondValue = lowerFactor[nextRowIndex][column];
    lowerFactor[rowIndex][column] = cosine * firstValue - sine * secondValue;
    lowerFactor[nextRowIndex][column] = sine * firstValue + cosine * secondValue;
  }
}

function swapAdjacentFactorRows(length, lowerFactor, rowIndex) {
  const nextRowIndex = rowIndex + 1;
  for (let column = rowIndex; column <= length; column++) {
    const value = lowerFactor[rowIndex][column];
    lowerFactor[rowIndex][column] = lowerFactor[nextRowIndex][column];
    lowerFactor[nextRowIndex][column] = value;
  }
}

function applyRankOneQrUpdate(length, lowerFactor, directionVector, correctionVector) {
  let lastNonZeroIndex = length;
  while (directionVector[lastNonZeroIndex] === 0 && lastNonZeroIndex > 1) {
    lastNonZeroIndex--;
  }

  for (let offset = 1; offset <= lastNonZeroIndex - 1; offset++) {
    const rowIndex = lastNonZeroIndex - offset;
    if (directionVector[rowIndex] === 0) {
      swapAdjacentFactorRows(length, lowerFactor, rowIndex);
      directionVector[rowIndex] = directionVector[rowIndex + 1];
      continue;
    }
    applyGivensRotation(
      length,
      lowerFactor,
      rowIndex,
      directionVector[rowIndex],
      -directionVector[rowIndex + 1],
    );
    directionVector[rowIndex] = Math.sqrt(
      directionVector[rowIndex] * directionVector[rowIndex] +
        directionVector[rowIndex + 1] * directionVector[rowIndex + 1],
    );
  }

  for (let column = 1; column <= length; column++) {
    lowerFactor[1][column] += directionVector[1] * correctionVector[column];
  }

  for (let rowIndex = 1; rowIndex <= lastNonZeroIndex - 1; rowIndex++) {
    if (lowerFactor[rowIndex][rowIndex] === 0) {
      swapAdjacentFactorRows(length, lowerFactor, rowIndex);
      continue;
    }
    applyGivensRotation(
      length,
      lowerFactor,
      rowIndex,
      lowerFactor[rowIndex][rowIndex],
      -lowerFactor[rowIndex + 1][rowIndex],
    );
  }
}

function maybeScaleInitialFactor(
  length,
  lowerFactor,
  projectedStep,
  scalingFactor,
  firstUpdateRef,
) {
  if (!firstUpdateRef[1]) {
    return scalingFactor;
  }

  for (let row = 1; row <= length; row++) {
    projectedStep[row] *= scalingFactor;
    for (let column = row; column <= length; column++) {
      lowerFactor[column][row] *= scalingFactor;
    }
  }
  firstUpdateRef[1] = false;
  return 1;
}

function satisfiesSecantEquation(
  length,
  previousGradient,
  candidateGradient,
  gradientDelta,
  correctionVector,
  relativeNoiseFloor,
  gradientModeRef,
) {
  const adjustedNoiseFloor =
    gradientModeRef[1] === 0 ? Math.sqrt(relativeNoiseFloor) : relativeNoiseFloor;

  for (let index = 1; index <= length; index++) {
    const tolerance =
      adjustedNoiseFloor *
      Math.max(Math.abs(previousGradient[index]), Math.abs(candidateGradient[index]));
    if (Math.abs(gradientDelta[index] - correctionVector[index]) >= tolerance) {
      return false;
    }
  }
  return true;
}

function prepareUpperStorageView(length, lowerFactor) {
  for (let row = 2; row <= length; row++) {
    for (let column = 1; column < row; column++) {
      lowerFactor[column][row] = lowerFactor[row][column];
      lowerFactor[row][column] = 0;
    }
  }
}

function restoreLowerStorageView(length, lowerFactor) {
  for (let row = 2; row <= length; row++) {
    for (let column = 1; column < row; column++) {
      lowerFactor[row][column] = lowerFactor[column][row];
    }
  }
}

/**
 * Updates the Cholesky factor of the approximate Hessian using the BFGS formula.
 * The update is skipped when the curvature condition is not satisfied or when
 * the secant equation is already fulfilled.
 *
 * @param {Object} context
 * @param {number}    context.length
 * @param {number[]}  context.previousPoint      - 1-indexed
 * @param {number[]}  context.previousGradient   - 1-indexed
 * @param {number[][]} context.lowerFactor        - 1-indexed 2D, modified in-place
 * @param {number[]}  context.candidatePoint     - 1-indexed
 * @param {number[]}  context.candidateGradient  - 1-indexed
 * @param {number}    context.machineEpsilon
 * @param {number[]}  context.iterationCountRef  - 1-indexed ref-box
 * @param {number}    context.relativeNoiseFloor
 * @param {number[]}  context.gradientModeRef    - 1-indexed ref-box
 * @param {boolean[]} context.firstUpdateRef     - 1-indexed ref-box
 * @param {number[]}  context.positionDelta      - 1-indexed work array
 * @param {number[]}  context.gradientDelta      - 1-indexed work array
 * @param {number[]}  context.projectedStep      - 1-indexed work array
 * @param {number[]}  context.correctionVector   - 1-indexed work array
 */
export function updateCholeskyBfgsFactor(context) {
  const {
    length,
    previousPoint,
    previousGradient,
    lowerFactor,
    candidatePoint,
    candidateGradient,
    machineEpsilon,
    iterationCountRef,
    relativeNoiseFloor,
    gradientModeRef,
    firstUpdateRef,
    positionDelta,
    gradientDelta,
    projectedStep,
    correctionVector,
  } = context;

  if (iterationCountRef[1] === 1) {
    firstUpdateRef[1] = true;
  }

  for (let index = 1; index <= length; index++) {
    positionDelta[index] = candidatePoint[index] - previousPoint[index];
    gradientDelta[index] = candidateGradient[index] - previousGradient[index];
  }

  const curvature = dotProduct1Indexed(length, positionDelta, gradientDelta);
  const stepNorm = norm2Stable1Indexed(length, positionDelta);
  const gradientDiffNorm = norm2Stable1Indexed(length, gradientDelta);

  if (curvature < Math.sqrt(machineEpsilon) * stepNorm * gradientDiffNorm) {
    return;
  }

  multiplyLower(length, lowerFactor, positionDelta, projectedStep);

  const projectedStepNormSquared = dotProduct1Indexed(
    length,
    projectedStep,
    projectedStep,
  );
  let scalingFactor = Math.sqrt(curvature / projectedStepNormSquared);
  scalingFactor = maybeScaleInitialFactor(
    length,
    lowerFactor,
    projectedStep,
    scalingFactor,
    firstUpdateRef,
  );

  multiplyLowerTranspose(length, lowerFactor, projectedStep, correctionVector);

  if (
    satisfiesSecantEquation(
      length,
      previousGradient,
      candidateGradient,
      gradientDelta,
      correctionVector,
      relativeNoiseFloor,
      gradientModeRef,
    )
  ) {
    return;
  }

  for (let index = 1; index <= length; index++) {
    correctionVector[index] =
      gradientDelta[index] - scalingFactor * correctionVector[index];
  }

  const projectedStepScale = scalingFactor / curvature;
  for (let index = 1; index <= length; index++) {
    projectedStep[index] *= projectedStepScale;
  }

  prepareUpperStorageView(length, lowerFactor);
  applyRankOneQrUpdate(length, lowerFactor, projectedStep, correctionVector);
  restoreLowerStorageView(length, lowerFactor);
}
