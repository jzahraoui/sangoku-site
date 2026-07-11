/**
 * Differential evolution (DE/rand/1/bin) — generic, engine-agnostic solver.
 *
 * Minimizes `cost(genome)` over a box-bounded continuous space. Used by the
 * joint (target-match) flow, where the search space mixes alignment
 * parameters and per-sub filter parameters; MSO solves the same class of
 * problem with the same family of algorithm.
 *
 * Async by design: the loop yields to the event loop periodically so a UI
 * can repaint its progress bar, and honours a cooperative cancel callback.
 */

const YIELD_EVERY_GENERATIONS = 10;

/**
 * @param {Object} options
 * @param {Array<[number, number]>} options.bounds - Per-dimension [min, max]
 * @param {(genome: Float64Array) => number} options.cost - To minimize
 * @param {Array<ArrayLike<number>>} [options.seeds] - Individuals injected
 *   into the initial population (clamped to bounds)
 * @param {number} [options.populationSize]
 * @param {number} [options.generations]
 * @param {number} [options.patience] - Generations without improvement
 *   before early stop
 * @param {number} [options.mutationFactor] - DE F
 * @param {number} [options.crossoverRate] - DE CR
 * @param {() => number} options.random - Uniform [0,1) source (seedable)
 * @param {(progress: {generation, generations, bestCost}) => void}
 *   [options.onGeneration] - Called every YIELD_EVERY_GENERATIONS
 * @param {() => boolean} [options.shouldCancel] - Cooperative cancellation
 * @returns {Promise<{best: Float64Array, bestCost: number, generationsRun:
 *   number, cancelled: boolean}>}
 */
export async function runDifferentialEvolution(options) {
  const state = createSolverState(options);
  const { generations, patience, onGeneration, shouldCancel } = state;

  for (let generation = 0; generation < generations; generation++) {
    runSingleGeneration(state);
    state.generationsRun = generation + 1;
    state.sinceImprovement++;

    if (generation % YIELD_EVERY_GENERATIONS === 0) {
      onGeneration?.({ generation, generations, bestCost: state.bestCost });
      if (shouldCancel?.()) {
        state.cancelled = true;
        break;
      }
      // Yield so a host UI can repaint between batches of generations.
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (state.sinceImprovement >= patience) {
      break;
    }
  }

  return {
    best: state.best,
    bestCost: state.bestCost,
    generationsRun: state.generationsRun,
    cancelled: state.cancelled,
  };
}

function createSolverState({
  bounds,
  cost,
  seeds = [],
  populationSize = 64,
  generations = 1000,
  patience = 300,
  mutationFactor = 0.7,
  crossoverRate = 0.9,
  random,
  onGeneration = null,
  shouldCancel = null,
}) {
  if (bounds.length === 0) {
    throw new Error('Differential evolution requires at least 1 dimension');
  }
  if (typeof random !== 'function') {
    throw new TypeError('Differential evolution requires a random source');
  }
  if (populationSize < 4) {
    // rand/1 mutation draws 3 distinct partners besides the current index.
    throw new Error('Differential evolution requires a population of at least 4');
  }

  const population = initializePopulation(bounds, seeds, populationSize, random);
  const fitness = population.map(genome => cost(genome));

  let bestCost = Infinity;
  let best = null;
  for (let i = 0; i < populationSize; i++) {
    if (fitness[i] < bestCost) {
      bestCost = fitness[i];
      best = Float64Array.from(population[i]);
    }
  }

  return {
    bounds,
    cost,
    populationSize,
    generations,
    patience,
    mutationFactor,
    crossoverRate,
    random,
    onGeneration,
    shouldCancel,
    population,
    fitness,
    best,
    bestCost,
    trial: new Float64Array(bounds.length),
    generationsRun: 0,
    sinceImprovement: 0,
    cancelled: false,
  };
}

function clampToBounds(value, range) {
  return Math.min(range[1], Math.max(range[0], value));
}

function initializePopulation(bounds, seeds, populationSize, random) {
  const dims = bounds.length;
  const population = [];

  for (const seed of seeds.slice(0, populationSize)) {
    if (seed.length !== dims) {
      throw new Error('Seed genome length must match the bounds dimensions');
    }
    const genome = new Float64Array(dims);
    for (let d = 0; d < dims; d++) genome[d] = clampToBounds(seed[d], bounds[d]);
    population.push(genome);
  }

  while (population.length < populationSize) {
    const genome = new Float64Array(dims);
    for (let d = 0; d < dims; d++) {
      genome[d] = bounds[d][0] + random() * (bounds[d][1] - bounds[d][0]);
    }
    population.push(genome);
  }

  return population;
}

function pickThreeDistinct(random, populationSize, excluded) {
  const picks = [];
  while (picks.length < 3) {
    const candidate = Math.floor(random() * populationSize);
    if (candidate !== excluded && !picks.includes(candidate)) {
      picks.push(candidate);
    }
  }
  return picks;
}

function buildTrialGenome(state, targetIndex) {
  const { bounds, population, random, mutationFactor, crossoverRate, trial } = state;
  const dims = bounds.length;
  const [r1, r2, r3] = pickThreeDistinct(random, state.populationSize, targetIndex);
  const forcedDim = Math.floor(random() * dims);

  for (let d = 0; d < dims; d++) {
    if (random() < crossoverRate || d === forcedDim) {
      trial[d] = clampToBounds(
        population[r1][d] + mutationFactor * (population[r2][d] - population[r3][d]),
        bounds[d],
      );
    } else {
      trial[d] = population[targetIndex][d];
    }
  }
  return trial;
}

function runSingleGeneration(state) {
  for (let i = 0; i < state.populationSize; i++) {
    const trial = buildTrialGenome(state, i);
    const trialCost = state.cost(trial);

    if (trialCost < state.fitness[i]) {
      state.population[i].set(trial);
      state.fitness[i] = trialCost;
      if (trialCost < state.bestCost) {
        state.bestCost = trialCost;
        state.best.set(trial);
        state.sinceImprovement = -1;
      }
    }
  }
}
