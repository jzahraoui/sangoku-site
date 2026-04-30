import { cloneParam } from './config.js';
import { getCacheStats } from './cache.js';

function applyLocalSearchIfNeeded(optimizer, ctx, generation, useLocalSearch) {
  if (!useLocalSearch || generation % 5 !== 0 || generation === 0) {
    return;
  }

  const { highest, evaluated, state, subToOptimize, previousValidSum, theo } = ctx;
  const improved = optimizer.localSearch(
    highest.param,
    subToOptimize,
    previousValidSum,
    theo,
    15,
  );

  if (improved.score <= highest.score) {
    return;
  }

  evaluated[0] = improved;
  state.previousBestScore = improved.score;
  const improvedClone = {
    ...improved,
    param: cloneParam(improved.param),
  };

  if (improved.hasAllPass && improved.score > state.bestWithAllPass.score) {
    state.bestWithAllPass = improvedClone;
  } else if (!improved.hasAllPass && improved.score > state.bestWithoutAllPass.score) {
    state.bestWithoutAllPass = improvedClone;
  }
}

function processGeneration(
  optimizer,
  ctx,
  population,
  options,
  generation,
  lastDiversity,
) {
  const { subToOptimize, previousValidSum, theo, state } = ctx;
  const { generations, mutationRate, mutationAmount } = options;

  const decaySpeed = optimizer.config.allPass.enabled ? 2 : 3;
  const mutationFloor = optimizer.config.allPass.enabled ? 0.2 : 0.1;
  const decayFactor = Math.exp((-decaySpeed * generation) / generations);
  const adaptiveMutation = mutationAmount * Math.max(mutationFloor, decayFactor);
  const adaptiveMutationRate = Math.min(
    1,
    mutationRate * (lastDiversity < 0.3 ? 1.5 : 1),
  );

  const evaluated = population.map(param => {
    subToOptimize.param = param;
    return optimizer.evaluateParametersCached(subToOptimize, previousValidSum, theo, {
      validate: false,
    });
  });
  evaluated.sort((a, b) => b.score - a.score);

  const best = optimizer._ga.updateBestSolutions(evaluated);
  if (best.bestWithAllPass.score > state.bestWithAllPass.score) {
    state.bestWithAllPass = best.bestWithAllPass;
  }
  if (best.bestWithoutAllPass.score > state.bestWithoutAllPass.score) {
    state.bestWithoutAllPass = best.bestWithoutAllPass;
  }

  return { evaluated, highest: evaluated[0], adaptiveMutation, adaptiveMutationRate };
}

function runGeneticLoop(
  optimizer,
  subToOptimize,
  previousValidSum,
  theo,
  population,
  options,
) {
  const {
    generations,
    populationSize,
    eliteCount,
    tournamentSize,
    maxNoImprovementGenerations,
    useLocalSearch = true,
  } = options;

  const state = {
    bestWithAllPass: { score: -Infinity },
    bestWithoutAllPass: { score: -Infinity },
    previousBestScore: -Infinity,
  };
  const ctx = { subToOptimize, previousValidSum, theo, state };
  let generationsWithoutImprovement = 0;
  let lastDiversity = 1;

  for (let generation = 0; generation < generations; generation++) {
    const { evaluated, highest, adaptiveMutation, adaptiveMutationRate } =
      processGeneration(optimizer, ctx, population, options, generation, lastDiversity);

    if (highest.score > state.previousBestScore) {
      state.previousBestScore = highest.score;
      generationsWithoutImprovement = 0;
      applyLocalSearchIfNeeded(
        optimizer,
        { highest, evaluated, state, subToOptimize, previousValidSum, theo },
        generation,
        useLocalSearch,
      );
    } else {
      generationsWithoutImprovement++;
      optimizer._ga._injectDiversityIfStuck(
        evaluated,
        generationsWithoutImprovement,
        populationSize,
        options.withAllPassProbability || 0.7,
      );
    }

    if (generation % 3 === 0) {
      lastDiversity = optimizer._ga.calculatePopulationDiversity(evaluated);
    }

    if (
      optimizer._ga._shouldEarlyStop(
        generationsWithoutImprovement,
        maxNoImprovementGenerations,
        generation,
      )
    ) {
      optimizer.lm.debug(
        `Early stopping at generation ${generation} - no improvement for ${maxNoImprovementGenerations} generations`,
      );
      break;
    }

    if (generation < generations - 1) {
      population = optimizer._ga.createNextGeneration(
        evaluated,
        populationSize,
        eliteCount,
        tournamentSize,
        adaptiveMutationRate,
        adaptiveMutation,
      );
    }
  }

  return {
    bestWithAllPass: state.bestWithAllPass,
    bestWithoutAllPass: state.bestWithoutAllPass,
  };
}

export function runSingleGeneticRun(
  optimizer,
  subToOptimize,
  previousValidSum,
  theo,
  coarseBest,
  options,
) {
  const population = optimizer._ga.createHybridPopulation(
    coarseBest,
    options.populationSize,
    options.withAllPassProbability,
  );

  return runGeneticLoop(optimizer, subToOptimize, previousValidSum, theo, population, {
    ...options,
    eliteCount: Math.floor(options.eliteCount),
  });
}

export function runGeneticOptimization(
  optimizer,
  subToOptimize,
  previousValidSum,
  theo,
  testParamsList,
  options,
) {
  const {
    runs,
    useLocalSearch = true,
    coarseSeedCount = 1,
    minRunImprovement = 0,
  } = options;

  // Obs D: do not clear the cache here. The coarse search has just populated it
  // with up to ~2000 evaluations sharing the same `(subToOptimize, previousValidSum,
  // theo)` context as the upcoming GA runs. Keeping them lets the GA reuse the
  // seed evaluations (and any duplicate offspring) for free. The cache uses LRU
  // eviction at `maxEntries`, so memory stays bounded across successive subs.

  const coarseSeeds = optimizer.findTopCoarseParams(
    subToOptimize,
    previousValidSum,
    theo,
    testParamsList,
    coarseSeedCount,
  );

  let bestWithAllPass = { score: -Infinity };
  let bestWithoutAllPass = { score: -Infinity };
  let bestOverallScore = -Infinity;
  let runsCompleted = 0;

  for (let run = 0; run < runs; run++) {
    const result = optimizer._runSingleGeneticRun(
      subToOptimize,
      previousValidSum,
      theo,
      coarseSeeds,
      options,
    );
    if (result.bestWithAllPass.score > bestWithAllPass.score) {
      bestWithAllPass = result.bestWithAllPass;
    }
    if (result.bestWithoutAllPass.score > bestWithoutAllPass.score) {
      bestWithoutAllPass = result.bestWithoutAllPass;
    }

    runsCompleted++;
    const runBestScore = Math.max(
      result.bestWithAllPass.score,
      result.bestWithoutAllPass.score,
    );
    const runImprovement = runBestScore - bestOverallScore;
    bestOverallScore = Math.max(bestOverallScore, runBestScore);

    if (run > 0 && minRunImprovement > 0 && runImprovement < minRunImprovement) {
      optimizer.lm.debug(
        `Stopping genetic multi-start after ${runsCompleted}/${runs} runs: ` +
          `last run improved by ${runImprovement.toFixed(2)} score points`,
      );
      break;
    }
  }

  const cacheStats = getCacheStats(optimizer._evaluationCache);
  optimizer.lm.debug(
    `Evaluation cache: ${cacheStats.hits} hits, ${
      cacheStats.misses
    } misses (${cacheStats.ratio.toFixed(1)}% hit rate)`,
  );

  if (useLocalSearch) {
    bestWithoutAllPass = refineSolution(
      optimizer,
      bestWithoutAllPass,
      subToOptimize,
      previousValidSum,
      theo,
    );
    bestWithAllPass = refineSolution(
      optimizer,
      bestWithAllPass,
      subToOptimize,
      previousValidSum,
      theo,
    );
  }

  return {
    bestWithAllPass,
    bestWithoutAllPass,
    stats: {
      method: 'genetic',
      runsRequested: runs,
      runsCompleted,
      savedRuns: Math.max(0, runs - runsCompleted),
      coarseSeedCount: coarseSeeds.length,
      minRunImprovement,
    },
  };
}

function refineSolution(optimizer, solution, subToOptimize, previousValidSum, theo) {
  if (solution.score <= -Infinity) {
    return solution;
  }

  const refined = optimizer.localSearch(
    solution.param,
    subToOptimize,
    previousValidSum,
    theo,
    50,
  );

  return refined.score > solution.score ? refined : solution;
}
