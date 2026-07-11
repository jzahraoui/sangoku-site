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
    this.config = {
      ...config,
      allPass: { enabled: false, ...(config?.allPass ?? {}) },
    };
    this.validateConfig();
    // Owned by this class; MultiSubOptimizer proxies _random through get/set
    this._random = Math.random;
  }

  validateConfig() {
    if (!this.config || typeof this.config !== 'object') {
      throw new Error('GeneticAlgorithm config is required');
    }

    this._validateRange(this.config.delay, 'delay');
    this._validateRange(this.config.gain, 'gain');

    if (typeof this.config.allPass.enabled !== 'boolean') {
      throw new TypeError('allPass.enabled must be a boolean');
    }

    if (this.config.allPass.enabled) {
      this._validateRange(this.config.allPass.frequency, 'allPass.frequency');
      this._validateRange(this.config.allPass.q, 'allPass.q');
    }
  }

  _validateRange(range, name) {
    if (!range || typeof range !== 'object') {
      throw new Error(`${name} range is required`);
    }
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) {
      throw new TypeError(`${name} range must contain finite min and max values`);
    }
    if (range.min > range.max) {
      throw new Error(`${name} min must be less than or equal to max`);
    }
    if (!Number.isFinite(range.step) || range.step <= 0) {
      throw new Error(`${name} step must be a positive finite number`);
    }
  }

  // =========================================================
  // Random utilities
  // =========================================================

  /** @returns {number} Uniform random in [min, max) */
  randomInRange(min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new Error('randomInRange requires finite min <= max');
    }
    return min + this._randomUnit() * (max - min);
  }

  _randomUnit() {
    const value = this._random();
    if (!Number.isFinite(value)) {
      throw new TypeError('Random generator returned a non-finite value');
    }
    return Math.min(Math.max(value, 0), 1 - Number.EPSILON);
  }

  _chance(probability) {
    if (!Number.isFinite(probability)) {
      throw new TypeError('Probability must be a finite number');
    }
    const clamped = Math.min(1, Math.max(0, probability));
    return this._randomUnit() < clamped;
  }

  _normalizeProbability(probability, fallback = 0) {
    const value = probability ?? fallback;
    if (!Number.isFinite(value)) {
      throw new TypeError('Probability must be a finite number');
    }
    return Math.min(1, Math.max(0, value));
  }

  _assertInteger(value, name, { allowZero = false } = {}) {
    if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new Error(
        `${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer`,
      );
    }
  }

  _roundToRangeStep(value, range) {
    const rounded = range.min + Math.round((value - range.min) / range.step) * range.step;
    const decimalPlaces = Math.min(
      12,
      Math.max(0, Math.ceil(-Math.log10(range.step)) + 6),
    );
    const normalized = Number(rounded.toFixed(decimalPlaces));
    return Math.max(range.min, Math.min(range.max, normalized));
  }

  _randomIndex(length) {
    this._assertInteger(length, 'length');
    return Math.min(length - 1, Math.floor(this._randomUnit() * length));
  }

  _normalizeIndividual(individual) {
    if (!individual || typeof individual !== 'object') {
      throw new Error('Individual parameter object is required');
    }

    const readNumber = (value, fallback, name) => {
      if (value == null) return fallback;
      if (!Number.isFinite(value)) {
        throw new TypeError(`${name} must be a finite number`);
      }
      return value;
    };

    const polarity = individual.polarity ?? 1;
    if (polarity !== 1 && polarity !== -1) {
      throw new Error('polarity must be 1 or -1');
    }

    const allPass = individual.allPass ?? {};
    const enabled = this.config.allPass.enabled && allPass.enabled === true;
    const defaultFrequency = enabled ? this.config.allPass.frequency.min : 0;
    const defaultQ = enabled ? this.config.allPass.q.min : 0;

    return {
      delay: readNumber(individual.delay, 0, 'delay'),
      gain: readNumber(individual.gain, 0, 'gain'),
      polarity,
      allPass: {
        frequency: readNumber(allPass.frequency, defaultFrequency, 'allPass.frequency'),
        q: readNumber(allPass.q, defaultQ, 'allPass.q'),
        enabled,
      },
      // Per-sub filters are not part of the GA's search space, but individuals
      // seeded from a solution that carries them must not lose them.
      filters: Array.isArray(individual.filters)
        ? individual.filters.map(filter => ({ ...filter }))
        : [],
    };
  }

  _assignNormalizedIndividual(individual) {
    const normalized = this._normalizeIndividual(individual);
    individual.delay = normalized.delay;
    individual.gain = normalized.gain;
    individual.polarity = normalized.polarity;
    individual.allPass = normalized.allPass;
    return individual;
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
    this._assertInteger(size, 'size', { allowZero: true });
    const allPassProbability = this._normalizeProbability(withAllPassProbability, 0);
    const population = [];

    for (let i = 0; i < size; i++) {
      // Generate random parameters within the configured ranges
      const delay = this._roundToRangeStep(
        this.randomInRange(this.config.delay.min, this.config.delay.max),
        this.config.delay,
      );

      const gain = this._roundToRangeStep(
        this.randomInRange(this.config.gain.min, this.config.gain.max),
        this.config.gain,
      );

      const polarity = this._chance(0.5) ? 1 : -1;

      // Determine if this individual will have an all-pass filter
      const hasAllPass = this.config.allPass.enabled && this._chance(allPassProbability);

      let allPass = { frequency: 0, q: 0, enabled: false };

      if (hasAllPass) {
        allPass = {
          frequency: this._roundToRangeStep(
            this.randomInRange(
              this.config.allPass.frequency.min,
              this.config.allPass.frequency.max,
            ),
            this.config.allPass.frequency,
          ),
          q: this._roundToRangeStep(
            this.randomInRange(this.config.allPass.q.min, this.config.allPass.q.max),
            this.config.allPass.q,
          ),
          enabled: true,
        };
      }

      population.push({ delay, gain, polarity, allPass });
    }

    return population;
  }

  createHybridPopulation(coarseBest, populationSize, withAllPassProbability) {
    this._assertInteger(populationSize, 'populationSize');
    const coarseSeeds = Array.isArray(coarseBest) ? coarseBest : [coarseBest];
    if (coarseSeeds.length === 0) {
      throw new Error('At least one coarse seed is required');
    }
    const normalizedCoarseSeeds = coarseSeeds.map(seed =>
      this._normalizeIndividual(seed),
    );
    // Balance between exploitation (focused) and exploration (random)
    // 40% focused around best, 60% random for diversity
    const focusedCount = Math.max(1, Math.floor(populationSize * 0.4));
    const randomCount = populationSize - focusedCount;
    const population = [];

    // Add the strongest coarse seeds themselves (unmutated) as elites
    const eliteSeedCount = Math.min(normalizedCoarseSeeds.length, focusedCount);
    for (let i = 0; i < eliteSeedCount; i++) {
      population.push(structuredClone(normalizedCoarseSeeds[i]));
    }

    // Add focused mutations around the best coarse seeds
    for (let i = population.length; i < focusedCount; i++) {
      const seed = normalizedCoarseSeeds[i % normalizedCoarseSeeds.length];
      const individual = structuredClone(seed);
      // Use varying mutation amounts for different exploration radii
      const mutationAmount = 0.1 + this._randomUnit() * 0.3;
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
    if (!Array.isArray(evaluated) || evaluated.length === 0) {
      throw new Error('evaluated population cannot be empty');
    }
    this._assertInteger(populationSize, 'populationSize');
    this._assertInteger(eliteCount, 'eliteCount', { allowZero: true });
    this._assertInteger(tournamentSize, 'tournamentSize');
    const normalizedMutationRate = this._normalizeProbability(mutationRate, 0);
    if (!Number.isFinite(mutationAmount) || mutationAmount < 0) {
      throw new Error('mutationAmount must be a non-negative finite number');
    }

    const nextGeneration = [];
    const eliteLimit = Math.min(eliteCount, evaluated.length, populationSize);

    // Elitism - directly copy top performers (deep clone to prevent mutation issues)
    for (let i = 0; i < eliteLimit; i++) {
      nextGeneration.push(structuredClone(this._normalizeIndividual(evaluated[i].param)));
    }

    // Fill the rest through selection and mutation
    while (nextGeneration.length < populationSize) {
      // Tournament selection
      const parent1 = this.tournamentSelection(evaluated, tournamentSize);
      const parent2 = this.tournamentSelection(evaluated, tournamentSize);

      // Create child by copying parent
      let child;
      if (this._chance(0.5) && parent1 !== parent2) {
        child = this.crossover(parent1.param, parent2.param);
      } else {
        child = structuredClone(this._normalizeIndividual(parent1.param));
      }

      // Apply mutation
      if (this._chance(normalizedMutationRate)) {
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
    if (!Array.isArray(evaluated) || evaluated.length === 0) {
      throw new Error('evaluated population cannot be empty');
    }
    this._assertInteger(tournamentSize, 'tournamentSize');
    let best = evaluated[this._randomIndex(evaluated.length)];

    for (let i = 1; i < tournamentSize; i++) {
      const current = evaluated[this._randomIndex(evaluated.length)];
      if (current.score > best.score) {
        best = current;
      }
    }

    return best;
  }

  // =========================================================
  // Mutation
  // =========================================================

  mutate(individual, mutationAmount) {
    this._assignNormalizedIndividual(individual);
    if (!Number.isFinite(mutationAmount) || mutationAmount < 0) {
      throw new Error('mutationAmount must be a non-negative finite number');
    }

    this._mutateParameter(individual, 'delay', mutationAmount, this.config.delay, 0.3);
    this._mutateParameter(individual, 'gain', mutationAmount, this.config.gain, 0.3);

    if (this._chance(0.1)) {
      individual.polarity *= -1;
    }

    if (this.config.allPass.enabled) {
      this._mutateAllPass(individual, mutationAmount);
    }

    return individual;
  }

  _mutateParameter(individual, paramName, mutationAmount, config, probability) {
    if (this._chance(probability)) {
      const mutationRange = (config.max - config.min) * mutationAmount;
      const mutation = this.randomInRange(-mutationRange, mutationRange);
      individual[paramName] = this._roundToRangeStep(
        Math.max(config.min, Math.min(config.max, individual[paramName] + mutation)),
        config,
      );
    }
  }

  _mutateAllPass(individual, mutationAmount) {
    if (this._chance(0.1)) {
      individual.allPass.enabled = !individual.allPass.enabled;

      // If we just enabled the all-pass, initialize with random values
      if (individual.allPass.enabled) {
        individual.allPass.frequency = this._roundToRangeStep(
          this.randomInRange(
            this.config.allPass.frequency.min,
            this.config.allPass.frequency.max,
          ),
          this.config.allPass.frequency,
        );
        individual.allPass.q = this._roundToRangeStep(
          this.randomInRange(this.config.allPass.q.min, this.config.allPass.q.max),
          this.config.allPass.q,
        );
      }
    }

    // Only mutate all-pass parameters if it's enabled
    if (individual.allPass.enabled) {
      // Frequency mutation
      if (this._chance(0.3)) {
        const freqRange =
          (this.config.allPass.frequency.max - this.config.allPass.frequency.min) *
          mutationAmount;
        const freqMutation = this.randomInRange(-freqRange, freqRange);
        individual.allPass.frequency = this._roundToRangeStep(
          Math.max(
            this.config.allPass.frequency.min,
            Math.min(
              this.config.allPass.frequency.max,
              individual.allPass.frequency + freqMutation,
            ),
          ),
          this.config.allPass.frequency,
        );
      }

      // Q factor mutation
      if (this._chance(0.3)) {
        const qRange =
          (this.config.allPass.q.max - this.config.allPass.q.min) * mutationAmount;
        const qMutation = this.randomInRange(-qRange, qRange);
        individual.allPass.q = this._roundToRangeStep(
          Math.max(
            this.config.allPass.q.min,
            Math.min(this.config.allPass.q.max, individual.allPass.q + qMutation),
          ),
          this.config.allPass.q,
        );
      }
    }
  }

  // =========================================================
  // Crossover
  // =========================================================

  crossover(parent1, parent2) {
    const normalizedParent1 = this._normalizeIndividual(parent1);
    const normalizedParent2 = this._normalizeIndividual(parent2);
    const child = structuredClone(normalizedParent1);

    // 50% chance to inherit each parameter from either parent
    if (this._chance(0.5)) child.delay = normalizedParent2.delay;
    if (this._chance(0.5)) child.gain = normalizedParent2.gain;
    if (this._chance(0.5)) child.polarity = normalizedParent2.polarity;

    // Handle all-pass parameters
    if (this.config.allPass.enabled) {
      // 20% chance to swap entire all-pass configuration
      if (this._chance(0.2)) {
        child.allPass = structuredClone(normalizedParent2.allPass);
      }
      // Otherwise mix parameters if both have all-pass enabled
      else if (child.allPass.enabled && normalizedParent2.allPass.enabled) {
        if (this._chance(0.5)) {
          child.allPass.frequency = normalizedParent2.allPass.frequency;
        }
        if (this._chance(0.5)) child.allPass.q = normalizedParent2.allPass.q;
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

    let delaySum = 0;
    let delaySquareSum = 0;
    let polaritySum = 0;
    let enabledAllPassCount = 0;

    for (const individual of evaluated) {
      const param = this._normalizeIndividual(individual.param);
      delaySum += param.delay;
      delaySquareSum += param.delay * param.delay;
      polaritySum += param.polarity;
      if (param.allPass.enabled) {
        enabledAllPassCount++;
      }
    }

    const delayRange = this.config.delay.max - this.config.delay.min;
    const delayMean = delaySum / evaluated.length;
    const delayVariance = Math.max(
      0,
      delaySquareSum / evaluated.length - delayMean * delayMean,
    );
    const normalizedDelayVar =
      delayRange > 0 ? Math.min(1, Math.sqrt(delayVariance) / delayRange) : 0;

    const polarityDiversity = Math.abs(polaritySum / evaluated.length);
    const normalizedPolarityVar = 1 - polarityDiversity;

    let allPassDiversity = 0;
    if (this.config.allPass.enabled) {
      allPassDiversity =
        Math.min(enabledAllPassCount, evaluated.length - enabledAllPassCount) /
        (evaluated.length / 2);
    }

    const components = [normalizedDelayVar, normalizedPolarityVar];
    if (this.config.allPass.enabled) components.push(allPassDiversity);

    return components.reduce((sum, value) => sum + value, 0) / components.length;
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

  _sampleEvenly(items, count) {
    const sampleCount = Math.min(count, items.length);
    if (sampleCount <= 0) return [];
    if (sampleCount === items.length) return [...items];
    if (sampleCount === 1) return [items[0]];

    const lastIndex = items.length - 1;
    const sampled = new Array(sampleCount);
    for (let index = 0; index < sampleCount; index++) {
      const sourceIndex = Math.round((index * lastIndex) / (sampleCount - 1));
      sampled[index] = items[sourceIndex];
    }
    return sampled;
  }

  _splitAllPassStrata(params) {
    const noAllPass = [];
    const withAllPass = [];

    for (const param of params) {
      if (param.allPass?.enabled) {
        withAllPass.push(param);
      } else {
        noAllPass.push(param);
      }
    }

    return {
      noAllPass,
      withAllPass,
    };
  }

  _calculateStrataTargets(noAllPassCount, withAllPassCount, targetSize) {
    let noAllPassTarget = Math.min(
      noAllPassCount,
      Math.max(1, Math.round(targetSize * 0.3)),
    );
    let withAllPassTarget = Math.min(withAllPassCount, targetSize - noAllPassTarget);

    const remainingAfterInitialTargets = targetSize - noAllPassTarget - withAllPassTarget;
    const extraNoAllPass = Math.min(
      noAllPassCount - noAllPassTarget,
      Math.max(0, remainingAfterInitialTargets),
    );
    noAllPassTarget += extraNoAllPass;

    const remainingAfterNoAllPass = targetSize - noAllPassTarget - withAllPassTarget;
    const extraWithAllPass = Math.min(
      withAllPassCount - withAllPassTarget,
      Math.max(0, remainingAfterNoAllPass),
    );
    withAllPassTarget += extraWithAllPass;

    return { noAllPassTarget, withAllPassTarget };
  }

  _sampleAllPassStrata(noAllPass, withAllPass, targetSize) {
    const hasBothStrata = noAllPass.length > 0 && withAllPass.length > 0;
    if (!hasBothStrata) {
      const availableStratum = noAllPass.length > 0 ? noAllPass : withAllPass;
      return this._sampleEvenly(availableStratum, targetSize);
    }

    const { noAllPassTarget, withAllPassTarget } = this._calculateStrataTargets(
      noAllPass.length,
      withAllPass.length,
      targetSize,
    );

    return [
      ...this._sampleEvenly(noAllPass, noAllPassTarget),
      ...this._sampleEvenly(withAllPass, withAllPassTarget),
    ];
  }

  _fillSampleToTarget(sampled, params, targetSize) {
    if (sampled.length >= targetSize) {
      return sampled.slice(0, targetSize);
    }

    const result = [...sampled];
    const selected = new Set(result);
    for (const param of params) {
      if (selected.has(param)) continue;
      result.push(param);
      if (result.length === targetSize) break;
    }

    return result.slice(0, targetSize);
  }

  /**
   * Stratified sampling to cover parameter space evenly.
   * Ensures good coverage of delay range and AllPass combinations.
   */
  _stratifiedSample(params, targetSize) {
    if (!Array.isArray(params)) {
      throw new TypeError('params must be an array');
    }
    this._assertInteger(targetSize, 'targetSize');
    if (params?.length <= targetSize) return params;

    const { noAllPass, withAllPass } = this._splitAllPassStrata(params);
    const sampled = this._sampleAllPassStrata(noAllPass, withAllPass, targetSize);
    return this._fillSampleToTarget(sampled, params, targetSize);
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
      Math.max(1, Math.floor(populationSize * 0.1)),
      withAllPassProbability,
    );
    for (let i = 0; i < diversityInjection.length && i < evaluated.length; i++) {
      const target = evaluated[evaluated.length - 1 - i];
      target.param = diversityInjection[i];
      target.hasAllPass = diversityInjection[i].allPass.enabled;
    }
  }
}

export default GeneticAlgorithm;
