/**
 * GeneticAlgorithm — GA population management, selection, mutation and crossover
 *
 * Handles all "genetics" operations: population creation, tournament selection,
 * mutation, crossover, diversity management, and parameter sampling.
 *
 * Does NOT depend on DSP, scoring, or caching — those stay in MultiSubOptimizer.
 * The optimizer calls this._ga.xxx() for all population-related work.
 */
class GeneticAlgorithm {
  /**
   * @param {Object} config - Optimizer config (delay, gain, allPass ranges)
   */
  constructor(config) {
    this.config = config;
    // Owned by this class; MultiSubOptimizer proxies _random through get/set
    this._random = Math.random;
  }

  // =========================================================
  // Random utilities
  // =========================================================

  /** @returns {number} Uniform random in [min, max) */
  randomInRange(min, max) {
    return min + this._random() * (max - min);
  }

  /**
   * Creates a deterministic pseudo-random function from a seed (xorshift32).
   * @param {number} seed - Positive non-zero integer
   * @returns {() => number} Function returning values in [0, 1)
   */
  _createSeededRandom(seed) {
    if (typeof seed !== 'number') {
      throw new TypeError('Seed must be a number');
    }
    if (seed % 1 !== 0) {
      throw new Error('Seed must be an integer');
    }
    // ensure non-zero state (zero produces only zeros)
    if (seed === 0) {
      throw new Error('Seed must be a non-zero integer');
    }
    if (seed < 0) {
      throw new Error('Seed must be a positive integer');
    }
    let state = seed;
    return () => {
      state = (state ^ (state << 13)) >>> 0;
      state = (state ^ (state >>> 17)) >>> 0;
      state = (state ^ (state << 5)) >>> 0;
      return (state >>> 0) / 4294967296;
    };
  }

  // =========================================================
  // Population creation
  // =========================================================

  createInitialPopulation(size, withAllPassProbability) {
    const population = [];
    const round = (value, step) => Math.round(value / step) * step;

    for (let i = 0; i < size; i++) {
      // Generate random parameters within the configured ranges
      const delay = round(
        this.randomInRange(this.config.delay.min, this.config.delay.max),
        this.config.delay.step,
      );

      const gain = round(
        this.randomInRange(this.config.gain.min, this.config.gain.max),
        this.config.gain.step,
      );

      const polarity = this._random() < 0.5 ? 1 : -1;

      // Determine if this individual will have an all-pass filter
      const hasAllPass =
        this.config.allPass.enabled && this._random() < withAllPassProbability;

      let allPass = { frequency: 0, q: 0, enabled: false };

      if (hasAllPass) {
        allPass = {
          frequency: round(
            this.randomInRange(
              this.config.allPass.frequency.min,
              this.config.allPass.frequency.max,
            ),
            this.config.allPass.frequency.step,
          ),
          q: round(
            this.randomInRange(this.config.allPass.q.min, this.config.allPass.q.max),
            this.config.allPass.q.step,
          ),
          enabled: true,
        };
      }

      population.push({ delay, gain, polarity, allPass });
    }

    return population;
  }

  createHybridPopulation(coarseBest, populationSize, withAllPassProbability) {
    // Balance between exploitation (focused) and exploration (random)
    // 40% focused around best, 60% random for diversity
    const focusedCount = Math.floor(populationSize * 0.4);
    // Ensure we account for the always-added unmutated best when focusedCount is 0
    const randomCount = populationSize - Math.max(1, focusedCount);
    const population = [];

    // Add the coarse best itself (unmutated) as elite
    population.push(structuredClone(coarseBest));

    // Add focused mutations around the best
    for (let i = 1; i < focusedCount; i++) {
      const individual = structuredClone(coarseBest);
      // Use varying mutation amounts for different exploration radii
      const mutationAmount = 0.1 + this._random() * 0.3;
      this.mutate(individual, mutationAmount);
      population.push(individual);
    }

    // Add random individuals for exploration
    population.push(...this.createInitialPopulation(randomCount, withAllPassProbability));
    return population;
  }

  // =========================================================
  // Next-generation creation
  // =========================================================

  createNextGeneration(
    evaluated,
    populationSize,
    eliteCount,
    tournamentSize,
    mutationRate,
    mutationAmount,
  ) {
    const nextGeneration = [];

    // Elitism - directly copy top performers (deep clone to prevent mutation issues)
    for (let i = 0; i < eliteCount && i < evaluated.length; i++) {
      nextGeneration.push(structuredClone(evaluated[i].param));
    }

    // Fill the rest through selection and mutation
    while (nextGeneration.length < populationSize) {
      // Tournament selection
      const parent1 = this.tournamentSelection(evaluated, tournamentSize);
      const parent2 = this.tournamentSelection(evaluated, tournamentSize);

      // Create child by copying parent
      let child;
      if (this._random() < 0.5 && parent1 !== parent2) {
        child = this.crossover(parent1.param, parent2.param);
      } else {
        child = structuredClone(parent1.param);
      }

      // Apply mutation
      if (this._random() < mutationRate) {
        this.mutate(child, mutationAmount);
      }

      nextGeneration.push(child);
    }

    return nextGeneration;
  }

  // =========================================================
  // Selection
  // =========================================================

  tournamentSelection(evaluated, tournamentSize) {
    const tournament = [];

    // Select random individuals for the tournament
    for (let i = 0; i < tournamentSize; i++) {
      const randomIndex = Math.floor(this._random() * evaluated.length);
      tournament.push(evaluated[randomIndex]);
    }

    // Select the best from tournament
    return tournament.reduce(
      (best, current) => (current.score > best.score ? current : best),
      tournament[0],
    );
  }

  // =========================================================
  // Mutation
  // =========================================================

  mutate(individual, mutationAmount) {
    const round = (value, step) => Math.round(value / step) * step;

    this._mutateParameter(
      individual,
      'delay',
      mutationAmount,
      this.config.delay,
      round,
      0.3,
    );
    this._mutateParameter(
      individual,
      'gain',
      mutationAmount,
      this.config.gain,
      round,
      0.3,
    );

    if (this._random() < 0.1) {
      individual.polarity *= -1;
    }

    if (this.config.allPass.enabled) {
      this._mutateAllPass(individual, mutationAmount, round);
    }

    return individual;
  }

  _mutateParameter(individual, paramName, mutationAmount, config, round, probability) {
    if (this._random() < probability) {
      const mutationRange = (config.max - config.min) * mutationAmount;
      const mutation = this.randomInRange(-mutationRange, mutationRange);
      individual[paramName] = round(
        Math.max(config.min, Math.min(config.max, individual[paramName] + mutation)),
        config.step,
      );
    }
  }

  _mutateAllPass(individual, mutationAmount, round) {
    if (this._random() < 0.1) {
      individual.allPass.enabled = !individual.allPass.enabled;

      // If we just enabled the all-pass, initialize with random values
      if (individual.allPass.enabled) {
        individual.allPass.frequency = round(
          this.randomInRange(
            this.config.allPass.frequency.min,
            this.config.allPass.frequency.max,
          ),
          this.config.allPass.frequency.step,
        );
        individual.allPass.q = round(
          this.randomInRange(this.config.allPass.q.min, this.config.allPass.q.max),
          this.config.allPass.q.step,
        );
      }
    }

    // Only mutate all-pass parameters if it's enabled
    if (individual.allPass.enabled) {
      // Frequency mutation
      if (this._random() < 0.3) {
        const freqRange =
          (this.config.allPass.frequency.max - this.config.allPass.frequency.min) *
          mutationAmount;
        const freqMutation = this.randomInRange(-freqRange, freqRange);
        individual.allPass.frequency = round(
          Math.max(
            this.config.allPass.frequency.min,
            Math.min(
              this.config.allPass.frequency.max,
              individual.allPass.frequency + freqMutation,
            ),
          ),
          this.config.allPass.frequency.step,
        );
      }

      // Q factor mutation
      if (this._random() < 0.3) {
        const qRange =
          (this.config.allPass.q.max - this.config.allPass.q.min) * mutationAmount;
        const qMutation = this.randomInRange(-qRange, qRange);
        individual.allPass.q = round(
          Math.max(
            this.config.allPass.q.min,
            Math.min(this.config.allPass.q.max, individual.allPass.q + qMutation),
          ),
          this.config.allPass.q.step,
        );
      }
    }
  }

  // =========================================================
  // Crossover
  // =========================================================

  crossover(parent1, parent2) {
    const child = structuredClone(parent1);

    // 50% chance to inherit each parameter from either parent
    if (this._random() < 0.5) child.delay = parent2.delay;
    if (this._random() < 0.5) child.gain = parent2.gain;
    if (this._random() < 0.5) child.polarity = parent2.polarity;

    // Handle all-pass parameters
    if (this.config.allPass.enabled) {
      // 20% chance to swap entire all-pass configuration
      if (this._random() < 0.2) {
        child.allPass = structuredClone(parent2.allPass);
      }
      // Otherwise mix parameters if both have all-pass enabled
      else if (child.allPass.enabled && parent2.allPass.enabled) {
        if (this._random() < 0.5) child.allPass.frequency = parent2.allPass.frequency;
        if (this._random() < 0.5) child.allPass.q = parent2.allPass.q;
      }
    }

    return child;
  }

  // =========================================================
  // Diversity & best-solution tracking
  // =========================================================

  /**
   * Calculates population diversity based on parameter variance.
   * Returns value between 0 (no diversity) and 1 (high diversity).
   */
  calculatePopulationDiversity(evaluated) {
    if (evaluated.length < 2) return 1;

    const params = evaluated.map(e => e.param);

    // Calculate variance for delay (normalized)
    const delays = params.map(p => p.delay);
    const delayRange = this.config.delay.max - this.config.delay.min;
    const delayMean = delays.reduce((a, b) => a + b, 0) / delays.length;
    const delayVariance =
      delays.reduce((sum, d) => sum + Math.pow(d - delayMean, 2), 0) / delays.length;
    const normalizedDelayVar = delayRange > 0 ? Math.sqrt(delayVariance) / delayRange : 0;

    // Calculate polarity diversity
    const polarities = params.map(p => p.polarity);
    const polarityDiversity = Math.abs(
      polarities.reduce((a, b) => a + b, 0) / polarities.length,
    );
    const normalizedPolarityVar = 1 - Math.abs(polarityDiversity);

    // Calculate all-pass diversity
    let allPassDiversity = 0;
    if (this.config.allPass.enabled) {
      const enabledCount = params.filter(p => p.allPass.enabled).length;
      allPassDiversity =
        Math.min(enabledCount, params.length - enabledCount) / (params.length / 2);
    }

    // Combine diversities
    return (normalizedDelayVar + normalizedPolarityVar + allPassDiversity) / 3;
  }

  updateBestSolutions(evaluated) {
    // Note: evaluated is assumed to be already sorted by score descending
    let bestWithAllPass = { score: -Infinity };
    let bestWithoutAllPass = { score: -Infinity };

    // Single pass through sorted array to find best of each type
    for (const individual of evaluated) {
      if (individual.hasAllPass && bestWithAllPass.score === -Infinity) {
        // Deep clone to prevent mutation by _injectDiversityIfStuck or createNextGeneration
        bestWithAllPass = { ...individual, param: structuredClone(individual.param) };
      } else if (!individual.hasAllPass && bestWithoutAllPass.score === -Infinity) {
        bestWithoutAllPass = { ...individual, param: structuredClone(individual.param) };
      }

      // Early exit when both found
      if (bestWithAllPass.score !== -Infinity && bestWithoutAllPass.score !== -Infinity) {
        break;
      }
    }

    return { bestWithAllPass, bestWithoutAllPass };
  }

  // =========================================================
  // Early stopping & stratified sampling
  // =========================================================

  _shouldEarlyStop(
    generationsWithoutImprovement,
    maxNoImprovementGenerations,
    generation,
  ) {
    return (
      generationsWithoutImprovement >= maxNoImprovementGenerations && generation >= 20
    );
  }

  /**
   * Stratified sampling to cover parameter space evenly.
   * Ensures good coverage of delay range and AllPass combinations.
   */
  _stratifiedSample(params, targetSize) {
    if (params?.length <= targetSize) return params;

    const result = [];

    // First, add samples without AllPass (important for baseline)
    const noAllPass = params.filter(p => !p.allPass.enabled);
    if (noAllPass.length > 0) {
      const noAllPassStep = Math.max(
        1,
        Math.floor(noAllPass.length / (targetSize * 0.3)),
      );
      for (let i = 0; i < noAllPass.length; i += noAllPassStep) {
        result.push(noAllPass[i]);
      }
    }

    // Then, add stratified samples with AllPass
    const withAllPass = params.filter(p => p.allPass.enabled);
    if (withAllPass.length > 0) {
      const remaining = targetSize - result.length;
      // Early exit if we've already reached target size
      if (remaining <= 0) return result;
      const allPassStep = Math.max(1, Math.floor(withAllPass.length / remaining));
      for (
        let i = 0;
        i < withAllPass.length && result.length < targetSize;
        i += allPassStep
      ) {
        result.push(withAllPass[i]);
      }
    }

    return result;
  }

  _injectDiversityIfStuck(
    evaluated,
    generationsWithoutImprovement,
    populationSize,
    withAllPassProbability,
  ) {
    const shouldInject =
      generationsWithoutImprovement >= 8 && generationsWithoutImprovement % 8 === 0;
    if (!shouldInject) {
      return;
    }
    const diversityInjection = this.createInitialPopulation(
      Math.floor(populationSize * 0.1),
      withAllPassProbability,
    );
    for (let i = 0; i < diversityInjection.length && i < evaluated.length; i++) {
      evaluated[evaluated.length - 1 - i].param = diversityInjection[i];
    }
  }
}

export default GeneticAlgorithm;
