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
// The setTimeout(0) yield is clamped to ~4 ms by browsers; gating it on
// wall-clock keeps the UI repaint guarantee while removing most of the
// ~410 forced pauses of a production run.
const YIELD_MIN_INTERVAL_MS = 50;

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
 * @param {number} [options.patienceEpsilon] - Minimum CUMULATIVE best-cost
 *   improvement (since the last rearm) for the patience counter to rearm.
 *   0 (default) keeps the historical behaviour where any strictly positive
 *   float improvement rearms it — including ~1e-9 numerical noise that can
 *   hold a plateaued phase alive until its full generation budget. The
 *   cumulative (watermark) semantics matter: real DE progress often flows as
 *   a stream of individually sub-epsilon improvements, and a per-improvement
 *   threshold would cut a phase that is still gaining whole points. The best
 *   itself always updates on a strict `<` so the final result of a given
 *   trajectory is unchanged.
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
  let lastYield = performance.now();

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
      const now = performance.now();
      if (now - lastYield >= YIELD_MIN_INTERVAL_MS) {
        await new Promise(resolve => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
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
  patienceEpsilon = 0,
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
    patienceEpsilon,
    mutationFactor,
    crossoverRate,
    random,
    onGeneration,
    shouldCancel,
    population,
    fitness,
    best,
    bestCost,
    patienceWatermark: bestCost,
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
        // Watermark semantics: rearm the patience only when the CUMULATIVE
        // improvement since the last rearm exceeds epsilon, so a stream of
        // individually tiny but real gains keeps the phase alive while pure
        // float noise does not. With the default epsilon of 0 the watermark
        // tracks every improvement — historical behaviour.
        if (state.patienceWatermark - trialCost > state.patienceEpsilon) {
          state.sinceImprovement = -1;
          state.patienceWatermark = trialCost;
        }
      }
    }
  }
}
