/**
 * Newton + BFGS optimizer with Cholesky-factor updates.
 *
 * Newton method with BFGS updates using a Cholesky-factored Hessian.
 * This module is the readable implementation entry point.
 *
 * Porting notes:
 * - Keeps the original 1-indexed work-array layout to stay faithful to the
 *   numerical structure of the REW optimizer port.
 * - Legacy decompilation names are intentionally removed from the public API.
 */
import {
  computeForwardDifferenceGradient,
  computeCentralDifferenceGradient,
} from './numericalGradient.js';
import { performLineSearch } from './lineSearch.js';
import { updateCholeskyBfgsFactor } from './bfgsUpdate.js';

const MACHINE_EPSILON = 1.12e-16;
const MAX_CONSECUTIVE_MAX_STEPS = 5;
const YIELD_EVERY_N_ITERATIONS = 100;

const OPTIMIZER_RESULT = {
  CONTINUE: 0,
  GRADIENT_SMALL: 1,
  STEP_SMALL: 2,
  CANNOT_FIND_LOWER_POINT: 3,
  MAX_ITERATIONS: 4,
  TOO_MANY_MAX_STEPS: 5,
};

const RESULT_MESSAGES = [
  '',
  'Gradient small',
  'Step small',
  'Cannot find lower point',
  'Max iterations',
  'Too many max steps',
];

function forwardSolveLowerTriangular(length, lowerFactor, solution, rhs) {
  solution[1] = rhs[1] / lowerFactor[1][1];
  for (let row = 2; row <= length; row++) {
    let sum = 0;
    for (let column = 1; column < row; column++) {
      sum += lowerFactor[row][column] * solution[column];
    }
    solution[row] = (rhs[row] - sum) / lowerFactor[row][row];
  }
}

function backSolveLowerTranspose(length, lowerFactor, solution, rhs) {
  solution[length] = rhs[length] / lowerFactor[length][length];
  for (let row = length - 1; row >= 1; row--) {
    let sum = 0;
    for (let column = row + 1; column <= length; column++) {
      sum += lowerFactor[column][row] * solution[column];
    }
    solution[row] = (rhs[row] - sum) / lowerFactor[row][row];
  }
}

function solveCholeskyFactoredSystem(length, lowerFactor, solution, rhs) {
  forwardSolveLowerTriangular(length, lowerFactor, solution, rhs);
  backSolveLowerTranspose(length, lowerFactor, solution, solution);
}

function checkConvergence(context) {
  const {
    length,
    candidatePoint,
    candidateValueRef,
    candidateGradient,
    previousPoint,
    iterationCountRef,
    maxStepCountRef,
    optimizerResultRef,
    gradientToleranceRef,
    stepToleranceRef,
    inverseScale,
    objectiveScaleRef,
    iterationLimitRef,
    lineSearchStatusRef,
    maxStepTakenRef,
  } = context;

  optimizerResultRef[1] = OPTIMIZER_RESULT.CONTINUE;

  if (lineSearchStatusRef[1] === 1) {
    optimizerResultRef[1] = OPTIMIZER_RESULT.CANNOT_FIND_LOWER_POINT;
    return;
  }

  const maxObjectiveScale = Math.max(
    Math.abs(candidateValueRef[1]),
    objectiveScaleRef[1],
  );
  let relativeGradient = 0;
  for (let index = 1; index <= length; index++) {
    relativeGradient = Math.max(
      relativeGradient,
      (Math.abs(candidateGradient[index]) *
        Math.max(Math.abs(candidatePoint[index]), 1 / inverseScale[index])) /
        maxObjectiveScale,
    );
  }
  if (relativeGradient <= gradientToleranceRef[1]) {
    optimizerResultRef[1] = OPTIMIZER_RESULT.GRADIENT_SMALL;
    return;
  }

  if (iterationCountRef[1] === 0) {
    return;
  }

  let relativeStep = 0;
  for (let index = 1; index <= length; index++) {
    relativeStep = Math.max(
      relativeStep,
      Math.abs(candidatePoint[index] - previousPoint[index]) /
        Math.max(Math.abs(candidatePoint[index]), 1 / inverseScale[index]),
    );
  }
  if (relativeStep <= stepToleranceRef[1]) {
    optimizerResultRef[1] = OPTIMIZER_RESULT.STEP_SMALL;
    return;
  }

  if (iterationCountRef[1] >= iterationLimitRef[1]) {
    optimizerResultRef[1] = OPTIMIZER_RESULT.MAX_ITERATIONS;
    return;
  }

  if (!maxStepTakenRef[1]) {
    maxStepCountRef[1] = 0;
    return;
  }

  maxStepCountRef[1]++;
  if (maxStepCountRef[1] >= MAX_CONSECUTIVE_MAX_STEPS) {
    optimizerResultRef[1] = OPTIMIZER_RESULT.TOO_MANY_MAX_STEPS;
  }
}

function createOptimizerState(dimension, maxIterations) {
  return {
    dimension,
    currentPoint: new Array(dimension + 1),
    candidatePoint: new Array(dimension + 1),
    currentGradient: new Array(dimension + 1),
    candidateGradient: new Array(dimension + 1),
    searchDirection: new Array(dimension + 1),
    scale: new Array(dimension + 1),
    inverseScale: new Array(dimension + 1),
    positionDelta: new Array(dimension + 1),
    gradientDelta: new Array(dimension + 1),
    projectedStep: new Array(dimension + 1),
    correctionVector: new Array(dimension + 1),
    currentValueRef: [0, 0],
    candidateValueRef: [0, 0],
    maxStepRef: [0, 0],
    stepToleranceRef: [0, 0],
    gradientToleranceRef: [0, 0],
    objectiveScaleRef: [0, 1],
    iterationLimitRef: [0, maxIterations],
    lineSearchStatusRef: [0, 0],
    maxStepTakenRef: [false, false],
    iterationCountRef: [0, 0],
    maxStepCountRef: [0, 0],
    optimizerResultRef: [0, 0],
    firstUpdateRef: [false, true],
    gradientModeRef: [0, 0],
  };
}

function initializeOptimizerState(state, initialPoint, objectiveFn, significantDigits) {
  const {
    dimension,
    scale,
    inverseScale,
    currentPoint,
    gradientToleranceRef,
    stepToleranceRef,
    maxStepRef,
    currentValueRef,
    currentGradient,
  } = state;

  for (let index = 1; index <= dimension; index++) {
    scale[index] = 1;
    inverseScale[index] = 1;
  }

  for (let index = 0; index < dimension; index++) {
    currentPoint[index + 1] = initialPoint[index];
  }

  const relativeNoiseFloor = Math.max(Math.pow(10, -significantDigits), MACHINE_EPSILON);
  gradientToleranceRef[1] = Math.pow(MACHINE_EPSILON, 1 / 3);
  stepToleranceRef[1] = Math.sqrt(MACHINE_EPSILON);

  let scaledPointNormSquared = 0;
  for (let index = 1; index <= dimension; index++) {
    scaledPointNormSquared +=
      currentPoint[index] *
      currentPoint[index] *
      inverseScale[index] *
      inverseScale[index];
  }
  maxStepRef[1] = Math.max(1000 * Math.sqrt(scaledPointNormSquared), 1000);

  currentValueRef[1] = objectiveFn(currentPoint);
  computeForwardDifferenceGradient(
    dimension,
    currentPoint,
    objectiveFn,
    currentValueRef,
    currentGradient,
    inverseScale,
    relativeNoiseFloor,
  );

  checkConvergence({
    length: dimension,
    candidatePoint: currentPoint,
    candidateValueRef: currentValueRef,
    candidateGradient: currentGradient,
    previousPoint: state.searchDirection,
    iterationCountRef: state.iterationCountRef,
    maxStepCountRef: state.maxStepCountRef,
    optimizerResultRef: state.optimizerResultRef,
    gradientToleranceRef,
    stepToleranceRef,
    inverseScale,
    objectiveScaleRef: state.objectiveScaleRef,
    iterationLimitRef: state.iterationLimitRef,
    lineSearchStatusRef: state.lineSearchStatusRef,
    maxStepTakenRef: state.maxStepTakenRef,
  });

  return relativeNoiseFloor;
}

function createIdentityCholeskyFactor(dimension, scale) {
  const lowerFactor = new Array(dimension + 1);
  for (let row = 0; row <= dimension; row++) {
    lowerFactor[row] = new Array(dimension + 1).fill(0);
  }
  for (let index = 1; index <= dimension; index++) {
    lowerFactor[index][index] = scale[index];
  }
  return lowerFactor;
}

function recomputeWithCentralDifferences(
  state,
  lowerFactor,
  objectiveFn,
  relativeNoiseFloor,
) {
  state.gradientModeRef[1] = -1;
  computeCentralDifferenceGradient(
    state.dimension,
    state.currentPoint,
    objectiveFn,
    state.inverseScale,
    relativeNoiseFloor,
    state.currentGradient,
  );

  for (let index = 1; index <= state.dimension; index++) {
    state.searchDirection[index] = -state.currentGradient[index];
  }
  solveCholeskyFactoredSystem(
    state.dimension,
    lowerFactor,
    state.searchDirection,
    state.searchDirection,
  );
  performLineSearch({
    length: state.dimension,
    currentPoint: state.currentPoint,
    currentValueRef: state.currentValueRef,
    currentGradient: state.currentGradient,
    searchDirection: state.searchDirection,
    candidatePoint: state.candidatePoint,
    candidateValueRef: state.candidateValueRef,
    objectiveFn,
    maxStepTakenRef: state.maxStepTakenRef,
    lineSearchStatusRef: state.lineSearchStatusRef,
    maxStepRef: state.maxStepRef,
    stepToleranceRef: state.stepToleranceRef,
    inverseScale: state.inverseScale,
  });
}

function computeCandidateGradient(
  state,
  objectiveFn,
  relativeNoiseFloor,
  useCentralDifferences,
) {
  if (useCentralDifferences) {
    computeCentralDifferenceGradient(
      state.dimension,
      state.candidatePoint,
      objectiveFn,
      state.inverseScale,
      relativeNoiseFloor,
      state.candidateGradient,
    );
    return;
  }

  computeForwardDifferenceGradient(
    state.dimension,
    state.candidatePoint,
    objectiveFn,
    state.candidateValueRef,
    state.candidateGradient,
    state.inverseScale,
    relativeNoiseFloor,
  );
}

function hasInvalidFactorDiagonal(length, lowerFactor) {
  for (let index = 1; index <= length; index++) {
    if (Number.isNaN(lowerFactor[index][index])) {
      return true;
    }
  }
  return false;
}

function copyCandidateToCurrentState(state) {
  state.currentValueRef[1] = state.candidateValueRef[1];
  for (let index = 1; index <= state.dimension; index++) {
    state.currentPoint[index] = state.candidatePoint[index];
    state.currentGradient[index] = state.candidateGradient[index];
  }
}

async function runOptimizationLoop(state, objectiveFn, relativeNoiseFloor) {
  const lowerFactor = createIdentityCholeskyFactor(state.dimension, state.scale);
  let useCentralDifferences = false;

  while (state.optimizerResultRef[1] === OPTIMIZER_RESULT.CONTINUE) {
    state.iterationCountRef[1]++;

    for (let index = 1; index <= state.dimension; index++) {
      state.searchDirection[index] = -state.currentGradient[index];
    }
    solveCholeskyFactoredSystem(
      state.dimension,
      lowerFactor,
      state.searchDirection,
      state.searchDirection,
    );

    performLineSearch({
      length: state.dimension,
      currentPoint: state.currentPoint,
      currentValueRef: state.currentValueRef,
      currentGradient: state.currentGradient,
      searchDirection: state.searchDirection,
      candidatePoint: state.candidatePoint,
      candidateValueRef: state.candidateValueRef,
      objectiveFn,
      maxStepTakenRef: state.maxStepTakenRef,
      lineSearchStatusRef: state.lineSearchStatusRef,
      maxStepRef: state.maxStepRef,
      stepToleranceRef: state.stepToleranceRef,
      inverseScale: state.inverseScale,
    });

    if (state.lineSearchStatusRef[1] === 1 && !useCentralDifferences) {
      useCentralDifferences = true;
      recomputeWithCentralDifferences(
        state,
        lowerFactor,
        objectiveFn,
        relativeNoiseFloor,
      );
    }

    computeCandidateGradient(
      state,
      objectiveFn,
      relativeNoiseFloor,
      useCentralDifferences,
    );

    checkConvergence({
      length: state.dimension,
      candidatePoint: state.candidatePoint,
      candidateValueRef: state.candidateValueRef,
      candidateGradient: state.candidateGradient,
      previousPoint: state.currentPoint,
      iterationCountRef: state.iterationCountRef,
      maxStepCountRef: state.maxStepCountRef,
      optimizerResultRef: state.optimizerResultRef,
      gradientToleranceRef: state.gradientToleranceRef,
      stepToleranceRef: state.stepToleranceRef,
      inverseScale: state.inverseScale,
      objectiveScaleRef: state.objectiveScaleRef,
      iterationLimitRef: state.iterationLimitRef,
      lineSearchStatusRef: state.lineSearchStatusRef,
      maxStepTakenRef: state.maxStepTakenRef,
    });

    if (state.optimizerResultRef[1] === OPTIMIZER_RESULT.CONTINUE) {
      updateCholeskyBfgsFactor({
        length: state.dimension,
        previousPoint: state.currentPoint,
        previousGradient: state.currentGradient,
        lowerFactor,
        candidatePoint: state.candidatePoint,
        candidateGradient: state.candidateGradient,
        machineEpsilon: MACHINE_EPSILON,
        iterationCountRef: state.iterationCountRef,
        relativeNoiseFloor,
        gradientModeRef: state.gradientModeRef,
        firstUpdateRef: state.firstUpdateRef,
        positionDelta: state.positionDelta,
        gradientDelta: state.gradientDelta,
        projectedStep: state.projectedStep,
        correctionVector: state.correctionVector,
      });

      if (hasInvalidFactorDiagonal(state.dimension, lowerFactor)) {
        state.optimizerResultRef[1] = OPTIMIZER_RESULT.CANNOT_FIND_LOWER_POINT;
      }
    }

    if (state.optimizerResultRef[1] === OPTIMIZER_RESULT.CONTINUE) {
      copyCandidateToCurrentState(state);
    }

    if (state.iterationCountRef[1] % YIELD_EVERY_N_ITERATIONS === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}

function extractBestPoint(point1Indexed, dimension) {
  const point = new Array(dimension);
  for (let index = 0; index < dimension; index++) {
    point[index] = point1Indexed[index + 1];
  }
  return point;
}

function buildFinalResult(state) {
  const resultCode = state.optimizerResultRef[1];
  const useCurrentPoint = resultCode === OPTIMIZER_RESULT.CANNOT_FIND_LOWER_POINT;

  return {
    x: extractBestPoint(
      useCurrentPoint ? state.currentPoint : state.candidatePoint,
      state.dimension,
    ),
    fval: useCurrentPoint ? state.currentValueRef[1] : state.candidateValueRef[1],
    iterations: state.iterationCountRef[1],
    converged:
      resultCode === OPTIMIZER_RESULT.GRADIENT_SMALL ||
      resultCode === OPTIMIZER_RESULT.STEP_SMALL,
    result: resultCode,
    message: RESULT_MESSAGES[resultCode] || `Result ${resultCode}`,
  };
}

/**
 * Minimize an objective with the Newton+BFGS optimizer.
 *
 * @param {Function} objective - Objective receiving a 0-indexed JS array.
 * @param {number[]} initialPoint - Starting point as a 0-indexed JS array.
 * @param {Object} [options]
 * @param {number} [options.maxIterations=500]
 * @param {number} [options.ndigit=8]
 * @returns {Promise<{x: number[], fval: number, iterations: number, converged: boolean, result: number, message: string}>}
 */
export async function optimizeWithNewtonBfgs(objective, initialPoint, options = {}) {
  const maxIterations = options.maxIterations ?? 500;
  let significantDigits = options.ndigit ?? -1;
  if (significantDigits < 0) {
    significantDigits = Math.floor(-Math.log(MACHINE_EPSILON) / Math.log(10));
  }

  const state = createOptimizerState(initialPoint.length, maxIterations);
  const objectiveInputBuffer = new Array(state.dimension);
  const objectiveFn = point1Indexed => {
    for (let index = 0; index < state.dimension; index++) {
      objectiveInputBuffer[index] = point1Indexed[index + 1];
    }
    return objective(objectiveInputBuffer);
  };

  const relativeNoiseFloor = initializeOptimizerState(
    state,
    initialPoint,
    objectiveFn,
    significantDigits,
  );

  if (state.optimizerResultRef[1] === OPTIMIZER_RESULT.CONTINUE) {
    await runOptimizationLoop(state, objectiveFn, relativeNoiseFloor);
  }

  return buildFinalResult(state);
}
