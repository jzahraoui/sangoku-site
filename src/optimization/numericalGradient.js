/**
 * numericalGradient.js
 *
 * Numerical gradient approximations for the Newton-BFGS optimizer.
 * All arrays use a 1-based layout: element i is at array[i] (array[0] unused).
 * The point array is mutated during computation and fully restored afterward.
 */

/**
 * Forward-difference gradient approximation.
 * Step size: √(relativeNoiseFloor) × max(|xᵢ|, 1/inverseScale[i]).
 *
 * @param {number}   length
 * @param {number[]} point            - 1-indexed, mutated then restored
 * @param {Function} objectiveFn      - receives the 1-indexed point array
 * @param {number[]} objectiveValueRef - 1-indexed ref-box: [unused, f(point)]
 * @param {number[]} gradient          - 1-indexed output
 * @param {number[]} inverseScale      - 1-indexed
 * @param {number}   relativeNoiseFloor
 */
export function computeForwardDifferenceGradient(
  length,
  point,
  objectiveFn,
  objectiveValueRef,
  gradient,
  inverseScale,
  relativeNoiseFloor,
) {
  const stepScale = Math.sqrt(relativeNoiseFloor);
  for (let index = 1; index <= length; index++) {
    const stepSize =
      stepScale * Math.max(Math.abs(point[index]), 1 / inverseScale[index]);
    const originalValue = point[index];
    point[index] = originalValue + stepSize;
    const forwardValue = objectiveFn(point);
    point[index] = originalValue;
    gradient[index] = (forwardValue - objectiveValueRef[1]) / stepSize;
  }
}

/**
 * Central-difference gradient approximation.
 * Step size: relativeNoiseFloor^(1/3) × max(|xᵢ|, 1/inverseScale[i]).
 * More accurate than forward differences at higher cost (2× objective evaluations).
 *
 * @param {number}   length
 * @param {number[]} point            - 1-indexed, mutated then restored
 * @param {Function} objectiveFn      - receives the 1-indexed point array
 * @param {number[]} inverseScale     - 1-indexed
 * @param {number}   relativeNoiseFloor
 * @param {number[]} gradient         - 1-indexed output
 */
export function computeCentralDifferenceGradient(
  length,
  point,
  objectiveFn,
  inverseScale,
  relativeNoiseFloor,
  gradient,
) {
  const stepScale = Math.pow(relativeNoiseFloor, 1 / 3);
  for (let index = 1; index <= length; index++) {
    const stepSize =
      stepScale * Math.max(Math.abs(point[index]), 1 / inverseScale[index]);
    const originalValue = point[index];
    point[index] = originalValue + stepSize;
    const forwardValue = objectiveFn(point);
    point[index] = originalValue - stepSize;
    const backwardValue = objectiveFn(point);
    point[index] = originalValue;
    gradient[index] = (forwardValue - backwardValue) / (2 * stepSize);
  }
}
