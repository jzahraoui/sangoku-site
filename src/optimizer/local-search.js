import { normalizeParam } from './config.js';

export function localSearch({
  config,
  param,
  subToOptimize,
  previousValidSum,
  theoreticalMax,
  maxIterations = 30,
  evaluateParametersCached,
}) {
  let currentParam = normalizeParam(param);
  subToOptimize.param = currentParam;
  let currentResult = evaluateParametersCached(
    subToOptimize,
    previousValidSum,
    theoreticalMax,
  );

  const scales = [4, 2, 1, 0.5, 0.25];
  const iterationsAtScale = Math.ceil(maxIterations / scales.length);
  const ctx = {
    config,
    subToOptimize,
    previousValidSum,
    theoreticalMax,
    evaluateParametersCached,
  };

  for (const stepMultiplier of scales) {
    const result = runLocalSearchAtScale(
      { ...ctx, currentParam, currentResult },
      stepMultiplier,
      iterationsAtScale,
    );
    currentParam = result.currentParam;
    currentResult = result.currentResult;
  }

  return currentResult;
}

function buildLocalSearchStepSizes(config, stepMultiplier) {
  return {
    delay: buildStepSpec(config.delay, stepMultiplier),
    gain: buildStepSpec(config.gain, stepMultiplier),
    allPassFreq: buildStepSpec(config.allPass?.frequency, stepMultiplier, 1),
    allPassQ: buildStepSpec(config.allPass?.q, stepMultiplier, 0.1),
  };
}

/**
 * Computes the perturbation delta and the quantization grid for a parameter:
 *  - `delta`   = step * stepMultiplier  (perturbation magnitude)
 *  - `quantum` = step                   at scales >= 1 (snap to coarse-search
 *                                       grid: improves cache reuse and produces
 *                                       DSP-realizable values)
 *              = step * stepMultiplier  at finer scales (so the quantization
 *                                       never erases the perturbation just
 *                                       applied at scales 0.5 / 0.25)
 */
function buildStepSpec(range, stepMultiplier, fallbackStep = 1) {
  const step = range?.step ?? fallbackStep;
  const delta = step * stepMultiplier;
  const quantum = stepMultiplier >= 1 ? step : delta;
  return { delta, quantum };
}

function buildLocalSearchPerturbations(stepSizes, hasAllPass) {
  const perturbations = [
    { key: 'delay', delta: stepSizes.delay.delta },
    { key: 'delay', delta: -stepSizes.delay.delta },
    { key: 'gain', delta: stepSizes.gain.delta },
    { key: 'gain', delta: -stepSizes.gain.delta },
  ];

  if (hasAllPass) {
    perturbations.push(
      { key: 'allPassFreq', delta: stepSizes.allPassFreq.delta },
      { key: 'allPassFreq', delta: -stepSizes.allPassFreq.delta },
      { key: 'allPassQ', delta: stepSizes.allPassQ.delta },
      { key: 'allPassQ', delta: -stepSizes.allPassQ.delta },
    );
  }

  return perturbations;
}

function clampToRange(value, range) {
  return Math.max(range.min, Math.min(range.max, value));
}

function quantizeToGrid(value, range, quantum) {
  if (!quantum || !Number.isFinite(quantum) || quantum <= 0) return value;
  const snapped = range.min + Math.round((value - range.min) / quantum) * quantum;
  // Limit float drift after the round-trip (e.g. delays in the 1e-5 s range).
  const decimalPlaces = Math.min(12, Math.max(0, Math.ceil(-Math.log10(quantum)) + 6));
  const normalized = Number(snapped.toFixed(decimalPlaces));
  return clampToRange(normalized, range);
}

function applyLocalSearchPerturbation(config, param, perturbation, stepSizes) {
  const testParam = cloneSearchParam(param);

  if (perturbation.key === 'delay') {
    testParam.delay = quantizeToGrid(
      clampToRange(testParam.delay + perturbation.delta, config.delay),
      config.delay,
      stepSizes.delay.quantum,
    );
  } else if (perturbation.key === 'gain') {
    testParam.gain = quantizeToGrid(
      clampToRange(testParam.gain + perturbation.delta, config.gain),
      config.gain,
      stepSizes.gain.quantum,
    );
  } else if (perturbation.key === 'allPassFreq') {
    testParam.allPass.frequency = quantizeToGrid(
      clampToRange(
        testParam.allPass.frequency + perturbation.delta,
        config.allPass.frequency,
      ),
      config.allPass.frequency,
      stepSizes.allPassFreq.quantum,
    );
  } else if (perturbation.key === 'allPassQ') {
    testParam.allPass.q = quantizeToGrid(
      clampToRange(testParam.allPass.q + perturbation.delta, config.allPass.q),
      config.allPass.q,
      stepSizes.allPassQ.quantum,
    );
  }

  return testParam;
}

function cloneSearchParam(param) {
  return {
    delay: param.delay,
    gain: param.gain,
    polarity: param.polarity,
    allPass: {
      frequency: param.allPass.frequency,
      q: param.allPass.q,
      enabled: param.allPass.enabled,
    },
  };
}

function findLocalSearchBestNeighbor(ctx, perturbations, stepSizes) {
  const {
    config,
    subToOptimize,
    previousValidSum,
    theoreticalMax,
    currentParam,
    currentScore,
    evaluateParametersCached,
  } = ctx;

  let bestNeighborResult = null;
  let bestNeighborScore = currentScore;

  for (const perturbation of perturbations) {
    const testParam = applyLocalSearchPerturbation(
      config,
      currentParam,
      perturbation,
      stepSizes,
    );

    subToOptimize.param = testParam;
    const testResult = evaluateParametersCached(
      subToOptimize,
      previousValidSum,
      theoreticalMax,
    );

    if (testResult.score > bestNeighborScore) {
      bestNeighborResult = testResult;
      bestNeighborScore = testResult.score;
    }
  }

  return bestNeighborResult;
}

function runLocalSearchAtScale(ctx, stepMultiplier, iterationsAtScale) {
  let { currentParam, currentResult } = ctx;
  const stepSizes = buildLocalSearchStepSizes(ctx.config, stepMultiplier);
  const perturbations = buildLocalSearchPerturbations(
    stepSizes,
    currentParam.allPass.enabled,
  );

  for (let iter = 0; iter < iterationsAtScale; iter++) {
    const betterResult = findLocalSearchBestNeighbor(
      { ...ctx, currentParam, currentScore: currentResult.score },
      perturbations,
      stepSizes,
    );

    if (!betterResult) {
      break;
    }

    currentParam = betterResult.param;
    currentResult = betterResult;
  }

  return { currentParam, currentResult };
}
