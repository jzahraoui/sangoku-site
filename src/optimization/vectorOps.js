/**
 * vectorOps.js
 *
 * Pure 1-indexed vector operations for the Newton-BFGS optimizer.
 * All arrays use a 1-based layout: element i is at array[i] (array[0] unused).
 */

/**
 * Dot product of two 1-indexed vectors.
 * Uses Duff's-device style unrolling (5 elements per stride) for performance.
 *
 * @param {number} length
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number}
 */
export function dotProduct1Indexed(length, left, right) {
  let sum = 0;
  const remainder = length % 5;
  for (let index = 1; index <= remainder; index++) {
    sum += left[index] * right[index];
  }
  for (let index = remainder + 1; index <= length; index += 5) {
    sum +=
      left[index] * right[index] +
      left[index + 1] * right[index + 1] +
      left[index + 2] * right[index + 2] +
      left[index + 3] * right[index + 3] +
      left[index + 4] * right[index + 4];
  }
  return sum;
}

/**
 * Numerically stable 2-norm of a 1-indexed vector.
 * Uses a running-scale algorithm to avoid overflow/underflow.
 *
 * @param {number} length
 * @param {number[]} vector
 * @returns {number}
 */
export function norm2Stable1Indexed(length, vector) {
  if (length < 1) return 0;
  if (length === 1) return Math.abs(vector[1]);

  let scale = 0;
  let sumSquares = 1;

  for (let index = 1; index <= length; index++) {
    if (vector[index] === 0) {
      continue;
    }
    const absoluteValue = Math.abs(vector[index]);
    if (scale < absoluteValue) {
      const ratio = scale / absoluteValue;
      sumSquares = 1 + sumSquares * ratio * ratio;
      scale = absoluteValue;
    } else {
      const ratio = absoluteValue / scale;
      sumSquares += ratio * ratio;
    }
  }

  return scale * Math.sqrt(sumSquares);
}

/**
 * Returns `|magnitude|` with the sign of `signSource`.
 *
 * @param {number} magnitude
 * @param {number} signSource
 * @returns {number}
 */
export function copySignedMagnitude(magnitude, signSource) {
  return signSource < 0 ? -Math.abs(magnitude) : Math.abs(magnitude);
}

/**
 * Scales a 1-indexed vector: outputVector[i] = scalar * inputVector[i].
 *
 * @param {number} length
 * @param {number} scalar
 * @param {number[]} inputVector
 * @param {number[]} outputVector
 */
export function scaleVector(length, scalar, inputVector, outputVector) {
  for (let index = 1; index <= length; index++) {
    outputVector[index] = scalar * inputVector[index];
  }
}

/**
 * Computes ‖inverseScale ⊙ searchDirection‖₂  (element-wise product then norm).
 *
 * @param {number} length
 * @param {number[]} inverseScale  - 1-indexed
 * @param {number[]} searchDirection - 1-indexed
 * @returns {number}
 */
export function computeScaledStepNorm(length, inverseScale, searchDirection) {
  let scaledStepNormSquared = 0;
  for (let index = 1; index <= length; index++) {
    scaledStepNormSquared +=
      inverseScale[index] *
      inverseScale[index] *
      searchDirection[index] *
      searchDirection[index];
  }
  return Math.sqrt(scaledStepNormSquared);
}

/**
 * Computes the minimum step factor α below which the step is considered negligible
 * (relative to the current point and tolerance).
 *
 * @param {number}   length
 * @param {number[]} currentPoint     - 1-indexed
 * @param {number[]} inverseScale     - 1-indexed
 * @param {number[]} searchDirection  - 1-indexed
 * @param {number[]} stepToleranceRef - 1-indexed ref-box: [unused, value]
 * @returns {number}
 */
export function computeMinimumAlpha(
  length,
  currentPoint,
  inverseScale,
  searchDirection,
  stepToleranceRef,
) {
  let maxRelativeStep = 0;
  for (let index = 1; index <= length; index++) {
    maxRelativeStep = Math.max(
      maxRelativeStep,
      Math.abs(searchDirection[index]) /
        Math.max(Math.abs(currentPoint[index]), 1 / inverseScale[index]),
    );
  }
  return stepToleranceRef[1] / maxRelativeStep;
}

/**
 * Writes a trial point: candidatePoint[i] = currentPoint[i] + alpha * searchDirection[i].
 *
 * @param {number}   length
 * @param {number[]} currentPoint    - 1-indexed, read-only
 * @param {number[]} searchDirection - 1-indexed
 * @param {number}   alpha
 * @param {number[]} candidatePoint  - 1-indexed, written in-place
 */
export function writeCandidatePoint(
  length,
  currentPoint,
  searchDirection,
  alpha,
  candidatePoint,
) {
  for (let index = 1; index <= length; index++) {
    candidatePoint[index] = currentPoint[index] + alpha * searchDirection[index];
  }
}
