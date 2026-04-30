import { cloneParam } from './config.js';
import { hashParam } from './cache.js';
import { coarseDiversityKey } from './params.js';

export function runClassicOptimization(
  optimizer,
  subToOptimize,
  previousValidSum,
  theo,
  testParamsList,
) {
  let bestWithAllPass = { score: -Infinity };
  let bestWithoutAllPass = { score: -Infinity };

  for (const param of testParamsList) {
    subToOptimize.param = param;
    const individual = optimizer.evaluateParameters(
      subToOptimize,
      previousValidSum,
      theo,
      { validate: false },
    );

    if (individual.hasAllPass && individual.score > bestWithAllPass.score) {
      bestWithAllPass = individual;
    }
    if (!individual.hasAllPass && individual.score > bestWithoutAllPass.score) {
      bestWithoutAllPass = individual;
    }
  }

  return { bestWithAllPass, bestWithoutAllPass };
}

export function findTopCoarseParams(
  optimizer,
  subToOptimize,
  previousValidSum,
  theo,
  testParamsList,
  coarseSeedCount = 1,
) {
  if (!Number.isInteger(coarseSeedCount) || coarseSeedCount < 1) {
    throw new Error('coarseSeedCount must be a positive integer');
  }

  const maxSamples = 2000;
  const paramsToTest =
    testParamsList.length > maxSamples
      ? optimizer._ga._stratifiedSample(testParamsList, maxSamples)
      : testParamsList;

  if (paramsToTest.length === 0) {
    throw new Error('No valid parameters found in coarse search');
  }

  const evaluated = paramsToTest.map(param => {
    subToOptimize.param = param;
    return optimizer.evaluateParameters(subToOptimize, previousValidSum, theo, {
      validate: false,
    });
  });
  evaluated.sort((left, right) => right.score - left.score);

  const topParams = [];
  const seen = new Set();
  const diversityKeys = new Set();
  const addSeed = (individual, requireDiverse = false) => {
    if (!individual?.param || individual.score <= -Infinity) return false;

    const param = cloneParam(individual.param);
    const exactKey = hashParam(param);
    if (seen.has(exactKey)) return false;

    const diversityKey = coarseDiversityKey(optimizer.config, param);
    if (requireDiverse && diversityKeys.has(diversityKey)) return false;

    seen.add(exactKey);
    diversityKeys.add(diversityKey);
    topParams.push(param);
    return true;
  };

  addSeed(evaluated[0]);

  if (coarseSeedCount > 1) {
    addSeed(evaluated.find(individual => !individual.hasAllPass));
    addSeed(evaluated.find(individual => individual.hasAllPass));
  }

  for (const individual of evaluated) {
    addSeed(individual, true);
    if (topParams.length >= coarseSeedCount) break;
  }

  for (const individual of evaluated) {
    addSeed(individual);
    if (topParams.length >= coarseSeedCount) break;
  }

  if (topParams.length === 0) {
    throw new Error('No valid parameters found: all candidates scored -Infinity');
  }

  return topParams;
}
