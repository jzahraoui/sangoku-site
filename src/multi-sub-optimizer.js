import Polar from './Polar.js';
import FrequencyResponseProcessor from './frequency-response-processor.js';

class MultiSubOptimizer {
  // Define constant configurations as static properties
  static DEFAULT_CONFIG = {
    frequency: {
      min: 20, // Hz
      max: 200, // Hz
    },
    gain: {
      min: 0, // dB
      max: 0, // dB
      step: 0.1, // dB
    },
    delay: {
      min: -0.005, // seconds
      max: 0.005, // seconds
      step: 0.00001, // seconds
    },
    allPass: {
      enabled: false,
      frequency: {
        min: 10, // Hz
        max: 100, // Hz
        step: 1, // Hz
      },
      q: {
        min: 0.1,
        max: 0.5,
        step: 0.1,
      },
    },
  };

  static EMPTY_CONFIG = Object.freeze({
    delay: 0,
    gain: 0,
    polarity: 1,
    allPass: {
      frequency: 0,
      q: 0,
      enabled: false,
    },
  });

  /**
   * @param {Array} subMeasurements - Array of subwoofer frequency response measurements
   * @param {Object} config - Configuration object for optimization parameters
   */
  constructor(subMeasurements, config = MultiSubOptimizer.DEFAULT_CONFIG, lm = console) {
    this.validateMeasurements(subMeasurements);
    this.subMeasurements = subMeasurements;
    this.optimizedSubs = [];
    this.config = config;
    this.frequencyWeights = null;
    this.theoreticalMaxResponse = null;

    this.lm = lm;

    // Evaluation cache for performance optimization
    this._evaluationCache = new Map();
    this._cacheHits = 0;
    this._cacheMisses = 0;

    // Default random function (can be overridden for reproducible results)
    this._random = Math.random;

    // Validate delay range parameters
    if (this.config.delay.min > this.config.delay.max || this.config.delay.step <= 0) {
      throw new Error('Invalid delay range parameters');
    }
  }

  validateMeasurements(subMeasurements) {
    if (!subMeasurements || subMeasurements.length < 2) {
      throw new Error('At least 2 subwoofer measurements required');
    }
    // Check if all measurements have the same frequency points

    for (const frequencyResponse of subMeasurements) {
      if (frequencyResponse.freqs.length !== frequencyResponse.magnitude.length) {
        throw new Error('Frequency and magnitude arrays must have the same length');
      }
      if (!frequencyResponse.measurement) {
        throw new Error('Measurement UUID is required');
      }
    }
  }

  generateTestParams(stepFactor = 1) {
    // Pre-calculate parameter ranges using more efficient methods
    const round = (value, resolution = 0.0001) => {
      const decimalPlaces = -Math.floor(Math.log10(resolution));
      const multiplier = 10 ** decimalPlaces;
      return Math.round(value * multiplier) / multiplier;
    };

    // Pre-calculate arrays using more efficient array generation
    const generateRange = (min, max, step) => {
      const stepAdjusted = step * stepFactor;
      const count = Math.floor((max - min) / stepAdjusted + 0.5) + 1;
      return Array.from({ length: count }, (_, i) => {
        const value = round(min + i * stepAdjusted, stepAdjusted);
        return Math.min(value, max);
      });
    };

    // Generate delay and gain arrays
    const delays = generateRange(
      this.config.delay.min,
      this.config.delay.max,
      this.config.delay.step
    );

    const gains = generateRange(
      this.config.gain.min,
      this.config.gain.max,
      this.config.gain.step
    );

    // Initialize allPassParamsList with disabled filter
    const allPassParamsList = [{ frequency: 0, q: 0, enabled: false }];

    // Generate all-pass filter parameters if enabled
    if (this.config.allPass.enabled) {
      const frequencies = generateRange(
        this.config.allPass.frequency.min,
        this.config.allPass.frequency.max,
        this.config.allPass.frequency.step
      );

      const qValues = generateRange(
        this.config.allPass.q.min,
        this.config.allPass.q.max,
        this.config.allPass.q.step
      );

      // Use flatMap for more efficient array generation
      allPassParamsList.push(
        ...frequencies.flatMap(freq =>
          qValues.map(q => ({
            frequency: freq,
            q: q,
            enabled: true,
          }))
        )
      );
    }

    return this._generateParameterCombinations(delays, gains, allPassParamsList);
  }

  _generateParameterCombinations(delays, gains, allPassParamsList) {
    const combinations = [];
    for (const polarity of [-1, 1]) {
      for (const delay of delays) {
        for (const gain of gains) {
          for (const allPass of allPassParamsList) {
            combinations.push({ delay, gain, polarity, allPass });
          }
        }
      }
    }
    return combinations;
  }

  optimizeSubwoofers() {
    // 1. Initial measurements preparation
    const preparedSubs = this.prepareMeasurements();

    // Calculate theoretical maximum response
    this.theoreticalMaxResponse = this.calculateCombinedResponse(preparedSubs, true);

    // 2. Calculate initial response
    // const initialResponse = this.calculateCombinedResponse(preparedSubs);

    // 3. Optimize parameters for each sub
    const start = performance.now();
    const optimizedParams = this.findOptimalParameters(preparedSubs);
    const end = performance.now();
    const executionTime = end - start;

    this.generatesLogResults(
      executionTime,
      optimizedParams.optimizedSubs,
      optimizedParams.bestSum.score
    );

    return optimizedParams;
  }

  generatesLogResults(executionTime, optimizedSubs, bestScore) {
    this.lm.info('Optimized parameters:');
    for (const sub of optimizedSubs) {
      const delayMs = (sub.param.delay * 1000).toFixed(2);
      this.lm.info(`${sub.name}:`);
      if (sub.param.polarity === 1) {
        this.lm.info(` - polarity: normal`);
      } else {
        this.lm.warn(` - polarity: inverted`);
      }
      this.lm.info(` - delay: ${delayMs}ms`);
      if (sub.param.allPass?.enabled) {
        this.lm.success(
          ` - allpass: freq: ${sub.param.allPass.frequency}Hz Q: ${sub.param.allPass.q}`
        );
      } else {
        this.lm.info(` - allpass: disabled`);
      }
    }

    // convert execution time to human readable format - FIX: properly format duration in ms
    const seconds = Math.floor((executionTime % 60000) / 1000);
    const milliseconds = Math.floor(executionTime % 1000);

    // Format as HH:MM:SS.mmm
    const humanReadableTime = `${seconds}.${milliseconds.toString().padStart(3, '0')}s`;

    this.lm.info(`Execution time: ${humanReadableTime}`);
    this.lm.info(`Best score: ${bestScore.toFixed(2)}`);
  }

  prepareMeasurements() {
    const freqRangeStart = this.config.frequency.min;
    const freqRangeEnd = this.config.frequency.max;

    const preparedSubs = this.subMeasurements.map(frequencyResponse => {
      const freqs = frequencyResponse.freqs;
      const len = freqs.length;

      // Binary search for start index (first freq >= freqRangeStart)
      let startIdx = 0;
      let lo = 0,
        hi = len;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (freqs[mid] < freqRangeStart) lo = mid + 1;
        else hi = mid;
      }
      startIdx = lo;

      // Binary search for end index (last freq <= freqRangeEnd)
      let endIdx = len;
      lo = startIdx;
      hi = len;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (freqs[mid] <= freqRangeEnd) lo = mid + 1;
        else hi = mid;
      }
      endIdx = lo;

      // Slice typed arrays directly (O(n) copy but no branching)
      const validCount = endIdx - startIdx;
      const filteredFreqs = freqs.slice(startIdx, endIdx);
      const filteredMagnitude = frequencyResponse.magnitude.slice(startIdx, endIdx);
      const filteredPhase = frequencyResponse.phase.slice(startIdx, endIdx);

      // copy frequencyResponse object with filtered data
      const copiedFrequencyResponse = { ...frequencyResponse };
      copiedFrequencyResponse.freqs = filteredFreqs;
      copiedFrequencyResponse.magnitude = filteredMagnitude;
      copiedFrequencyResponse.phase = filteredPhase;
      copiedFrequencyResponse.startFreq = filteredFreqs[0];
      copiedFrequencyResponse.endFreq = filteredFreqs[validCount - 1];
      copiedFrequencyResponse.param = MultiSubOptimizer.EMPTY_CONFIG;

      return copiedFrequencyResponse;
    });

    // Validate all measurements have identical frequency points
    const firstFreqs = preparedSubs[0].freqs;
    const firstLen = firstFreqs.length;
    const tolerance = 1e-3; // Tolerance for floating-point comparison

    for (let subIdx = 1; subIdx < preparedSubs.length; subIdx++) {
      const subFreqs = preparedSubs[subIdx].freqs;
      if (subFreqs.length !== firstLen) {
        throw new Error(
          `Sub ${subIdx} has a different number of frequency points than the first sub`
        );
      }
      // Compare frequencies using tolerance (faster than rounding)
      for (let i = 0; i < firstLen; i++) {
        if (Math.abs(subFreqs[i] - firstFreqs[i]) > tolerance) {
          throw new Error(
            `Sub ${subIdx} has a different frequency point at index ${i} than the first sub`
          );
        }
      }
    }

    this.frequencyWeights = this.calculateFrequencyWeights(firstFreqs);

    return preparedSubs;
  }

  // method to count all possible parameter combinations from config
  countAllPossibleCombinations() {
    const { allPass } = this.config;
    const delayCount = Math.floor(
      (this.config.delay.max - this.config.delay.min) / this.config.delay.step + 1
    );
    const gainCount = Math.floor(
      (this.config.gain.max - this.config.gain.min) / this.config.gain.step + 1
    );
    const polarityCount = 2; // 1 or -1
    const allPassCount = allPass.enabled
      ? Math.floor(
          ((allPass.frequency.max - allPass.frequency.min) / allPass.frequency.step + 1) *
            ((allPass.q.max - allPass.q.min) / allPass.q.step + 1)
        ) + 1 // +1 for disabled all-pass
      : 1;

    const singleSubCombinations = delayCount * gainCount * polarityCount * allPassCount;
    //
    return singleSubCombinations + 1; // +1 for the reference sub
  }

  findOptimalParameters(preparedSubs) {
    // Early validation
    if (!preparedSubs?.length) {
      throw new Error('No subwoofer measurements provided for optimization');
    }

    if (preparedSubs?.length < 2) {
      throw new Error('At least 2 subwoofers are required for optimization');
    }

    // Initialize reference sub
    const referenceSub = preparedSubs[0];
    referenceSub.param = MultiSubOptimizer.EMPTY_CONFIG;

    const subsWithoutFirst = preparedSubs.slice(1);
    const paramCount = this.countAllPossibleCombinations();
    // Choose optimization method based on parameter count - use genetic for large spaces

    let method = 'classic';
    // Adaptive method selection based on parameter count
    if (paramCount > 1000) {
      method = 'genetic'; // For larger spaces, use genetic search
    }

    this.lm.info(
      `Optimizing with ${method} method: ${paramCount} test parameters per sub`
    );

    // Pre-calculate the reference response once
    let previousValidSum = referenceSub;

    this.optimizedSubs = [];
    const comparativeAnalysis = [];
    const options = { method }; // use defaults for genetic
    if (method === 'classic') {
      options.testParamsList = Object.freeze(this.generateTestParams());
    } else if (method === 'genetic') {
      // Use adaptive step factor based on AllPass complexity
      // With AllPass enabled, use larger steps (10x) for faster coarse search
      // The genetic algorithm will refine the solution
      const stepFactor = this.config.allPass.enabled ? 10 : 2;
      options.testParamsList = Object.freeze(this.generateTestParams(stepFactor));

      // Speed-optimized parameters for AllPass case
      // Population 45 and 32 generations balance speed and quality
      if (this.config.allPass.enabled) {
        options.runs = 1; // Single run with better initialization
        options.populationSize = 45;
        options.generations = 32;
        options.maxNoImprovementGenerations = 8;
        options.withAllPassProbability = 0.8; // Favor AllPass exploration
      }
    }

    // Iterate through each sub to optimize
    for (const subToOptimize of subsWithoutFirst) {
      const { finalResponse, comparative } = this.optimizeSingleSub(
        subToOptimize,
        previousValidSum,
        options
      );

      // Update for next iteration
      previousValidSum = finalResponse;
      subToOptimize.param = finalResponse.param;

      // Store optimization results
      this.optimizedSubs.push(subToOptimize);

      this.checkDelayBoundaries(subToOptimize);

      comparativeAnalysis.push({
        analysis: comparative.improvementPercentage,
        recommended: finalResponse.hasAllPass ? 'with-allpass' : 'without-allpass',
      });
    }

    const result = {
      optimizedSubs: this.optimizedSubs,
      bestSum: previousValidSum,
      comparativeAnalysis,
    };

    return result;
  }

  /**
   * Calculates weighted efficiency ratio between actual and theoretical responses.
   * Measures how close the actual response is to the theoretical maximum.
   *
   * @param {Object} actualResponse - Current combined response
   * @param {Object} theoreticalResponse - Theoretical maximum (minimum phase)
   * @returns {number} Weighted efficiency percentage (0-100+%)
   */
  calculateEfficiencyRatio(actualResponse, theoreticalResponse) {
    if (!actualResponse?.magnitude?.length || !theoreticalResponse?.magnitude?.length) {
      return 0;
    }

    let efficiencySum = 0;
    let weightSum = 0;

    for (let i = 0; i < actualResponse.magnitude.length; i++) {
      const actualLinear = Polar.DbToLinearGain(actualResponse.magnitude[i]);
      const theoreticalLinear = Polar.DbToLinearGain(theoreticalResponse.magnitude[i]);

      if (theoreticalLinear > 0) {
        const pointEfficiency = (actualLinear / theoreticalLinear) * 100;
        const weight = this.frequencyWeights[i];
        efficiencySum += pointEfficiency * weight;
        weightSum += weight;
      }
    }

    return weightSum > 0 ? efficiencySum / weightSum : 0;
  }

  updateBestSolutions(evaluated) {
    // Note: evaluated is assumed to be already sorted by score descending
    let bestWithAllPass = { score: -Infinity };
    let bestWithoutAllPass = { score: -Infinity };

    // Single pass through sorted array to find best of each type
    for (const individual of evaluated) {
      if (individual.hasAllPass && bestWithAllPass.score === -Infinity) {
        bestWithAllPass = individual;
      } else if (!individual.hasAllPass && bestWithoutAllPass.score === -Infinity) {
        bestWithoutAllPass = individual;
      }

      // Early exit when both found
      if (bestWithAllPass.score !== -Infinity && bestWithoutAllPass.score !== -Infinity) {
        break;
      }
    }

    return { bestWithAllPass, bestWithoutAllPass };
  }

  runGeneticLoop(subToOptimize, previousValidSum, theo, population, options) {
    const {
      generations,
      populationSize,
      eliteCount,
      tournamentSize,
      mutationRate,
      mutationAmount,
      maxNoImprovementGenerations,
      useLocalSearch = true,
    } = options;

    let bestWithAllPass = { score: -Infinity };
    let bestWithoutAllPass = { score: -Infinity };
    let generationsWithoutImprovement = 0;
    let previousBestScore = -Infinity;

    // Track population diversity for adaptive parameters
    let lastDiversity = 1;

    for (let generation = 0; generation < generations; generation++) {
      // Exponential decay with floor for adaptive mutation (better than linear)
      const decayFactor = Math.exp((-3 * generation) / generations);
      const adaptiveMutation = mutationAmount * Math.max(0.1, decayFactor);

      // Adaptive mutation rate based on diversity
      const adaptiveMutationRate = mutationRate * (lastDiversity < 0.3 ? 1.5 : 1);

      const evaluated = population.map(param => {
        subToOptimize.param = param;
        return this.evaluateParametersCached(subToOptimize, previousValidSum, theo);
      });

      // Sort evaluated array (CRITICAL FIX: was missing before accessing evaluated[0])
      evaluated.sort((a, b) => b.score - a.score);

      const best = this.updateBestSolutions(evaluated);
      if (best.bestWithAllPass.score > bestWithAllPass.score)
        bestWithAllPass = best.bestWithAllPass;
      if (best.bestWithoutAllPass.score > bestWithoutAllPass.score)
        bestWithoutAllPass = best.bestWithoutAllPass;

      // Now evaluated[0] is correctly the highest scorer
      const highest = evaluated[0];

      if (highest.score > previousBestScore) {
        previousBestScore = highest.score;
        generationsWithoutImprovement = 0;

        // Apply local search on the best solution periodically (less frequently for speed)
        if (useLocalSearch && generation % 5 === 0 && generation > 0) {
          const improved = this.localSearch(
            highest.param,
            subToOptimize,
            previousValidSum,
            theo,
            15 // Quick local search during evolution
          );
          if (improved.score > highest.score) {
            evaluated[0] = improved;
            previousBestScore = improved.score;
            // Update best tracking
            if (improved.hasAllPass && improved.score > bestWithAllPass.score) {
              bestWithAllPass = improved;
            } else if (
              !improved.hasAllPass &&
              improved.score > bestWithoutAllPass.score
            ) {
              bestWithoutAllPass = improved;
            }
          }
        }
      } else {
        generationsWithoutImprovement++;

        // Inject diversity when stuck (less frequently for speed)
        if (
          generationsWithoutImprovement >= 8 &&
          generationsWithoutImprovement % 8 === 0
        ) {
          const diversityInjection = this.createInitialPopulation(
            Math.floor(populationSize * 0.1),
            options.withAllPassProbability || 0.7
          );
          // Replace worst individuals with fresh random ones
          for (let i = 0; i < diversityInjection.length && i < evaluated.length; i++) {
            evaluated[evaluated.length - 1 - i].param = diversityInjection[i];
          }
        }
      }

      // Calculate population diversity (less frequently for speed)
      if (generation % 3 === 0) {
        lastDiversity = this.calculatePopulationDiversity(evaluated);
      }

      if (
        generationsWithoutImprovement >= maxNoImprovementGenerations &&
        generation >= 20
      ) {
        this.lm.debug(
          `Early stopping at generation ${generation} - no improvement for ${maxNoImprovementGenerations} generations`
        );
        break;
      }

      if (generation < generations - 1) {
        population = this.createNextGeneration(
          evaluated,
          populationSize,
          Math.floor(eliteCount), // Ensure integer
          tournamentSize,
          adaptiveMutationRate,
          adaptiveMutation
        );
      }
    }

    return { bestWithAllPass, bestWithoutAllPass };
  }

  runGeneticOptimization(subToOptimize, previousValidSum, theo, testParamsList, options) {
    const {
      runs,
      populationSize,
      withAllPassProbability,
      generations,
      eliteCount,
      tournamentSize,
      mutationRate,
      mutationAmount,
      maxNoImprovementGenerations,
      useLocalSearch = true,
    } = options;

    // Clear cache at start of optimization
    this.clearEvaluationCache();

    const coarseBest = this.findBestCoarseParam(
      subToOptimize,
      previousValidSum,
      theo,
      testParamsList
    );

    let bestWithAllPass = { score: -Infinity };
    let bestWithoutAllPass = { score: -Infinity };

    for (let run = 0; run < runs; run++) {
      const population = this.createHybridPopulation(
        coarseBest,
        populationSize,
        withAllPassProbability
      );

      const result = this.runGeneticLoop(
        subToOptimize,
        previousValidSum,
        theo,
        population,
        {
          generations,
          populationSize,
          eliteCount: Math.floor(eliteCount), // Ensure integer
          tournamentSize,
          mutationRate,
          mutationAmount,
          maxNoImprovementGenerations,
          withAllPassProbability,
          useLocalSearch,
        }
      );

      if (result.bestWithAllPass.score > bestWithAllPass.score)
        bestWithAllPass = result.bestWithAllPass;
      if (result.bestWithoutAllPass.score > bestWithoutAllPass.score)
        bestWithoutAllPass = result.bestWithoutAllPass;
    }

    // Log cache statistics
    const cacheRatio = (this._cacheHits / (this._cacheHits + this._cacheMisses)) * 100;
    this.lm.debug(
      `Evaluation cache: ${this._cacheHits} hits, ${
        this._cacheMisses
      } misses (${cacheRatio.toFixed(1)}% hit rate)`
    );

    // Final intensive local search on best solutions
    if (useLocalSearch) {
      if (bestWithoutAllPass.score > -Infinity) {
        const refinedWithout = this.localSearch(
          bestWithoutAllPass.param,
          subToOptimize,
          previousValidSum,
          theo,
          50 // Reduced iterations - most improvement happens early
        );
        if (refinedWithout.score > bestWithoutAllPass.score) {
          bestWithoutAllPass = refinedWithout;
        }
      }
      if (bestWithAllPass.score > -Infinity) {
        const refinedWith = this.localSearch(
          bestWithAllPass.param,
          subToOptimize,
          previousValidSum,
          theo,
          50
        );
        if (refinedWith.score > bestWithAllPass.score) {
          bestWithAllPass = refinedWith;
        }
      }
    }

    return { bestWithAllPass, bestWithoutAllPass };
  }

  runClassicOptimization(subToOptimize, previousValidSum, theo, testParamsList) {
    let bestWithAllPass = { score: -Infinity };
    let bestWithoutAllPass = { score: -Infinity };

    for (const param of testParamsList) {
      subToOptimize.param = param;
      const individual = this.evaluateParameters(subToOptimize, previousValidSum, theo);

      if (individual.hasAllPass && individual.score > bestWithAllPass.score) {
        bestWithAllPass = individual;
      }
      if (!individual.hasAllPass && individual.score > bestWithoutAllPass.score) {
        bestWithoutAllPass = individual;
      }
    }

    return { bestWithAllPass, bestWithoutAllPass };
  }

  findBestCoarseParam(subToOptimize, previousValidSum, theo, testParamsList) {
    // For large parameter spaces, use stratified sampling for speed
    const maxSamples = 2000; // Maximum coarse evaluations

    let paramsToTest = testParamsList;
    if (testParamsList.length > maxSamples) {
      // Use stratified sampling: ensure we cover the parameter space evenly
      paramsToTest = this._stratifiedSample(testParamsList, maxSamples);
    }

    let bestCoarse = null;
    for (const param of paramsToTest) {
      subToOptimize.param = param;
      const individual = this.evaluateParameters(subToOptimize, previousValidSum, theo);
      if (!bestCoarse || individual.score > bestCoarse.score) bestCoarse = individual;
    }
    return bestCoarse.param;
  }

  /**
   * Stratified sampling to cover parameter space evenly.
   * Ensures good coverage of delay range and AllPass combinations.
   */
  _stratifiedSample(params, targetSize) {
    if (params.length <= targetSize) return params;

    const result = [];

    // First, add samples without AllPass (important for baseline)
    const noAllPass = params.filter(p => !p.allPass.enabled);
    const noAllPassStep = Math.max(1, Math.floor(noAllPass.length / (targetSize * 0.3)));
    for (let i = 0; i < noAllPass.length; i += noAllPassStep) {
      result.push(noAllPass[i]);
    }

    // Then, add stratified samples with AllPass
    const withAllPass = params.filter(p => p.allPass.enabled);
    if (withAllPass.length > 0) {
      const remaining = targetSize - result.length;
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

  createHybridPopulation(coarseBest, populationSize, withAllPassProbability) {
    // Balance between exploitation (focused) and exploration (random)
    // 40% focused around best, 60% random for diversity
    const focusedCount = Math.floor(populationSize * 0.4);
    const randomCount = populationSize - focusedCount;
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

  // Helper method to optimize a single sub
  optimizeSingleSub(subToOptimize, previousValidSum, options = {}) {
    // Set defaults with the genetic algorithm as the default approach
    // Aggressive defaults for speed - genetic algorithm is efficient
    const {
      method = 'genetic',
      testParamsList = null,
      populationSize = 80,
      generations = 50,
      eliteCount = Math.max(2, Math.floor(0.15 * populationSize)), // 15% elitism for stability
      mutationRate = 0.25,
      mutationAmount = 0.2,
      tournamentSize = 5,
      withAllPassProbability = 0.7,
      seed = null,
      runs = 1, // Single run with good initialization
      maxNoImprovementGenerations = 15,
      useLocalSearch = true,
    } = options;

    if (!testParamsList) {
      throw new Error('coarseParams is required for genetic optimization');
    }

    // Set random seed if provided
    if (seed !== null) {
      this._random = this._createSeededRandom(seed);
    }

    // Calculate theoretical maximum response once
    const theo = this.calculateCombinedResponse(
      [subToOptimize, previousValidSum],
      false,
      true
    );

    const result =
      method === 'genetic'
        ? this.runGeneticOptimization(
            subToOptimize,
            previousValidSum,
            theo,
            testParamsList,
            {
              runs,
              populationSize,
              withAllPassProbability,
              generations,
              eliteCount,
              tournamentSize,
              mutationRate,
              mutationAmount,
              maxNoImprovementGenerations,
              useLocalSearch,
            }
          )
        : this.runClassicOptimization(
            subToOptimize,
            previousValidSum,
            theo,
            testParamsList
          );

    // Compare all-pass vs non-all-pass solutions
    const improvementPercentage = this.calculateImprovementPercentage(
      result.bestWithAllPass.score,
      result.bestWithoutAllPass.score
    );

    // Log the comparison results
    this.logComparisonResults(
      subToOptimize,
      result.bestWithAllPass,
      result.bestWithoutAllPass,
      improvementPercentage,
      method
    );

    const finalResponse = this.chooseBestSolution(
      result.bestWithAllPass,
      result.bestWithoutAllPass
    );

    return {
      finalResponse,
      comparative: {
        improvementPercentage,
      },
    };
  }

  getFinalSubSum() {
    const [firstSub, ...subsWithoutFirst] = this.subMeasurements;
    const optimizedSubArray = [firstSub];

    // Process each remaining sub with its optimized parameters
    for (const originalSub of subsWithoutFirst) {
      // Find the matching optimized sub by measurement ID
      const found = this.optimizedSubs.find(
        sub => sub.measurement === originalSub.measurement
      );

      if (!found) throw new Error('Sub not found in optimized subs');

      // Apply optimized parameters
      const subCopy = { ...originalSub, param: found.param };

      // Calculate the response with the parameters and add to array
      const response = this.calculateResponseWithParams(subCopy);
      optimizedSubArray.push(response);
    }

    const optimizedSubsSum = this.calculateCombinedResponse(optimizedSubArray);

    return optimizedSubsSum;
  }

  // Helper method to check delay boundaries
  checkDelayBoundaries(sub) {
    if (
      sub.param.delay >= this.config.delay.max ||
      sub.param.delay <= this.config.delay.min
    ) {
      const delayMs = (sub.param.delay * 1000).toFixed(2);
      this.lm.warn(`WARNING: Optimal delay for ${sub.name} is at the edge: ${delayMs}ms.
       This may indicate that the delay range is too narrow.`);
    }
  }

  /**
   * !!! WARNING !!! when the sub is delayed, the phase shift and this method provdings wrong results
   * a better approach would be to calculate the phase alignment between the two responses
   *
   * Calculates a score representing the phase alignment of the response,
   * weighted by frequency importance and linear magnitude.
   * A score closer to 100% indicates better phase alignment (closer to 0° or 180°),
   * especially at frequencies with higher magnitude and importance.
   * @param {object} response - The frequency response object { freqs, magnitude, phase }.
   * @returns {number} The normalized alignment score (0 to 1).
   */
  calculateAlignmentScore(response) {
    // Input validation
    if (!response?.magnitude?.length || !response?.phase?.length || !response?.freqs) {
      this.lm.warn('Invalid response data for alignment score');
      return 0;
    }
    if (
      !this.frequencyWeights ||
      this.frequencyWeights.length !== response.freqs.length
    ) {
      this.lm.warn('Frequency weights not available or mismatched for alignment score');
      return 0; // Cannot calculate without proper weights
    }

    let weightedCoherenceSum = 0;
    let totalWeightingFactor = 0;
    const weights = this.frequencyWeights; // Use pre-calculated frequency weights

    for (let i = 0; i < response.magnitude.length; i++) {
      // Phase coherence factor (0 to 1): 1 for 0°/180°, 0 for +/-90°
      const phaseRadians = Polar.degreesToRadians(response.phase[i]);
      // Math.abs(Math.cos(phase)) maps phase alignment to a 0-1 scale.
      const phaseCoherenceFactor = Math.abs(Math.cos(phaseRadians));

      // Convert magnitude from dB to linear scale.
      // This represents acoustic power more directly for weighting.
      const linearMagnitude = Polar.DbToLinearGain(response.magnitude[i]);

      // Calculate the weighting for this frequency point.
      // Combines frequency importance and acoustic power (linear magnitude).
      const currentWeight = linearMagnitude * weights[i];

      // Add the coherence contribution for this frequency, weighted appropriately.
      weightedCoherenceSum += phaseCoherenceFactor * currentWeight;

      // Sum the total weight applied for normalization.
      totalWeightingFactor += currentWeight;
    }

    // Normalize the final score by the total weighting factor.
    // Avoid division by zero if the total weight is negligible.
    if (totalWeightingFactor < 1e-9) {
      return 0;
    }

    // The score represents the average phase coherence, weighted by frequency importance and linear magnitude.
    return (weightedCoherenceSum / totalWeightingFactor) * 100; // Scale to percentage
  }

  calculateFrequencyWeights(frequencies) {
    const weights = new Float32Array(frequencies.length);
    for (let i = 0; i < frequencies.length; i++) {
      weights[i] = this.computeFrequencyWeight(frequencies[i]);
    }
    return weights;
  }

  /**
   * Computes perceptual frequency weight based on ISO 226 and room acoustics.
   * Uses a smooth continuous function for stable optimization.
   * Emphasizes critical subwoofer frequencies where room modes are most problematic.
   *
   * Based on research:
   * - Room modes are most problematic 20-80Hz
   * - Equal loudness contours show reduced sensitivity below 40Hz
   * - Subwoofer-to-main crossover region (80-120Hz) needs attention
   *
   * @param {number} freq - Frequency in Hz
   * @returns {number} Weight between 0.1 and 1
   */
  computeFrequencyWeight(freq) {
    // Combination of room mode importance and psychoacoustic sensitivity
    // Peak importance around 50-60Hz where room modes are most audible

    if (freq < 15) return 0.1; // Infrasonic - minimal weight

    // Bell curve centered at 55Hz (primary modal region)
    // with secondary emphasis at crossover region
    const modalWeight = Math.exp(-Math.pow((freq - 55) / 35, 2));

    // Crossover region weight (80-120Hz)
    const crossoverWeight = 0.3 * Math.exp(-Math.pow((freq - 100) / 30, 2));

    // Low frequency rolloff (below 25Hz, reduced audibility)
    const lowFreqFactor = freq < 25 ? Math.pow(freq / 25, 1.5) : 1;

    // High frequency rolloff (above 150Hz, less critical for subs)
    const highFreqFactor = freq > 150 ? Math.exp(-(freq - 150) / 100) : 1;

    const baseWeight = Math.max(modalWeight, crossoverWeight);
    return Math.max(0.1, Math.min(1, baseWeight * lowFreqFactor * highFreqFactor));
  }

  /**
   * Displays the frequency response in a formatted string.
   * Each line contains frequency, magnitude, and phase values.
   * @param {Object} response - The response object containing freqs, magnitude, and phase arrays.
   * @returns {string} - The formatted string representation of the response.
   */
  displayResponse(response) {
    // Early validation
    if (!response?.freqs?.length) {
      return '';
    }
    // Pre-allocate the string with an estimated size to improve performance
    const size = response.freqs.length;
    const lines = new Array(size);

    // Use a single loop to build all lines
    for (let i = 0; i < response.freqs.length; i++) {
      lines[i] = `${response.freqs[i].toFixed(6)}  ${response.magnitude[i].toFixed(
        3
      )} ${response.phase[i].toFixed(4)}`;
    }

    // Join all lines at once instead of concatenating strings
    return lines.join('\n');
  }

  // function to calculate combined response resulting of arithmetic sum operation on magnitude and phase of two responses
  calculateCombinedResponse(
    subs,
    theoreticalResponse = false,
    realisticTheoreticalResponse = false
  ) {
    if (!subs?.length) throw new Error('No measurements provided');
    if (theoreticalResponse && realisticTheoreticalResponse) {
      throw new Error(
        'Cannot calculate both theoretical and realistic theoretical response simultaneously'
      );
    }

    const freqs = subs[0].freqs;
    const freqStep = subs[0].freqStep;
    const ppo = subs[0].ppo;
    const magnitude = new Float32Array(freqs.length);
    const phase = new Float32Array(freqs.length);

    // Pre-calculate phases for all subs based on calculation mode
    const subPhases = subs.map(sub => {
      if (theoreticalResponse) {
        return new Float32Array(sub.magnitude.length).fill(0);
      } else if (realisticTheoreticalResponse) {
        return FrequencyResponseProcessor.calculateMinimumPhase(sub.magnitude);
      } else {
        return sub.phase;
      }
    });

    // For each frequency point
    for (let freqIndex = 0; freqIndex < freqs.length; freqIndex++) {
      // Process each subwoofer's response
      let polarSum = null;
      for (let subIndex = 0; subIndex < subs.length; subIndex++) {
        // Convert magnitude from dB to linear voltage
        const subPolar = Polar.fromDb(
          subs[subIndex].magnitude[freqIndex],
          subPhases[subIndex][freqIndex]
        );
        polarSum = polarSum ? polarSum.add(subPolar) : subPolar;
      }

      magnitude[freqIndex] = polarSum.magnitudeDb;
      phase[freqIndex] = polarSum.phaseDegrees;
    }

    return { freqs, magnitude, phase, freqStep, ppo };
  }

  calculateResponseWithParams(sub) {
    const size = sub.freqs.length;
    const response = {
      measurement: sub.measurement,
      name: sub.name,
      freqs: sub.freqs,
      magnitude: new Float32Array(size),
      phase: new Float32Array(size),
      freqStep: sub.freqStep,
      param: sub.param,
      ppo: sub.ppo,
    };
    const { gain, delay, polarity, allPass } = sub.param || {};

    // Pre-calculate all-pass filter response if enabled
    let allPassPhaseShift = null;
    if (allPass?.enabled) {
      allPassPhaseShift = this.calculateAllPassResponse(allPass.frequency, allPass.q);
    }

    for (let freqIndex = 0; freqIndex < size; freqIndex++) {
      // Calculate magnitude
      let polar = Polar.fromDb(sub.magnitude[freqIndex], sub.phase[freqIndex])
        .addGainDb(gain)
        .delay(delay, sub.freqs[freqIndex]);

      // Apply all-pass filter phase shift if enabled
      if (allPass?.enabled) {
        const additionalPhase = allPassPhaseShift(sub.freqs[freqIndex]);
        polar = polar.addPhaseDegrees(additionalPhase);
      }

      if (polarity === -1) {
        polar = polar.invertPolarity();
      }

      // Store results
      response.magnitude[freqIndex] = polar.magnitudeDb;
      response.phase[freqIndex] = polar.phaseDegrees;
    }

    return response;
  }

  /**
   * Detects modal nulls (destructive interference from phase cancellation).
   *
   * Modal nulls characteristics:
   * - Deep narrow dips (>10dB)
   * - Steep slopes (>20dB/octave)
   * - Occur in critical bass frequencies (20-80Hz weighted heavily)
   *
   * Uses overlapping 1/3 octave analysis to prevent missing nulls at band edges.
   * Slopes calculated in dB/octave (frequency-independent, works with any spacing).
   *
   * @param {Object} response - Frequency response {freqs, magnitude}
   * @returns {number} Penalty score (higher = more problematic nulls)
   */
  dipPenaltyScore(response) {
    if (!response?.freqs?.length || response.freqs.length !== response.magnitude.length) {
      return 0;
    }

    if (!this.frequencyWeights) {
      this.lm.warn('Frequency weights unavailable, recalculating for dip penalty');
      this.frequencyWeights = this.calculateFrequencyWeights(response.freqs);
    }

    const freqs = response.freqs;
    const magnitude = response.magnitude;
    const len = freqs.length;
    let penalty = 0;

    // Pre-calculate constants
    const sqrtBandWidth = Math.pow(2, 1 / 6); // sqrt(2^(1/3))
    const stepRatio = Math.pow(2, 1 / 6);
    const bandLowRatio = 1 / sqrtBandWidth;
    const bandHighRatio = sqrtBandWidth;

    let centerFreq = freqs[0] * sqrtBandWidth;
    const maxCenterFreq = freqs[len - 1] * bandLowRatio;

    while (centerFreq < maxCenterFreq) {
      const bandLow = centerFreq * bandLowRatio;
      const bandHigh = centerFreq * bandHighRatio;

      // Find band range using binary-like search
      let startIdx = 0;
      let endIdx = len - 1;

      while (startIdx < len && freqs[startIdx] < bandLow) startIdx++;
      while (endIdx > startIdx && freqs[endIdx] > bandHigh) endIdx--;

      if (endIdx - startIdx > 1) {
        penalty += this._detectNullInBand(freqs, magnitude, startIdx, endIdx);
      }

      centerFreq *= stepRatio;
    }

    return penalty;
  }

  _detectNullInBand(freqs, magnitude, startIdx, endIdx) {
    // Find minimum in range
    let minIdx = startIdx;
    let minMag = magnitude[startIdx];
    let sum = 0;

    for (let i = startIdx; i <= endIdx; i++) {
      const mag = magnitude[i];
      sum += mag;
      if (mag < minMag) {
        minMag = mag;
        minIdx = i;
      }
    }

    // Skip if at edges
    if (minIdx === startIdx || minIdx === endIdx) return 0;

    // Calculate depth
    const count = endIdx - startIdx + 1;
    const depth = (sum - minMag) / (count - 1) - minMag;

    if (depth < 10) return 0;

    // Calculate slopes in dB/octave
    const leftOctaves = Math.log2(freqs[minIdx] / freqs[minIdx - 1]);
    const rightOctaves = Math.log2(freqs[minIdx + 1] / freqs[minIdx]);

    const avgSlope =
      (Math.abs(minMag - magnitude[minIdx - 1]) / leftOctaves +
        Math.abs(magnitude[minIdx + 1] - minMag) / rightOctaves) /
      2;

    if (avgSlope < 20) return 0;

    // Calculate penalty
    const depthFactor = Math.pow(depth / 10, 1.5);
    const steepnessFactor = Math.min(avgSlope / 20, 2);

    return depthFactor * steepnessFactor * this.frequencyWeights[minIdx];
  }

  /**
   * Calculates a comprehensive quality score for frequency response.
   *
   * Based on industry-standard metrics used by:
   * - MSO (Multi-Sub Optimizer): Peak-to-valley minimization
   * - Dirac Live: Weighted RMS error to target
   * - Audyssey: Frequency-weighted smoothness
   * - Harman/JBL: Preference-based curves
   *
   * Key principles:
   * 1. DIPS ARE WORSE THAN PEAKS (asymmetric penalty)
   *    - Dips cannot be corrected by EQ without massive amplification
   *    - Peaks can be easily reduced with EQ
   * 2. Narrowband nulls are especially problematic (phase cancellation)
   * 3. Overall level (efficiency) matters for headroom
   * 4. Smoothness in critical listening region (30-80Hz)
   *
   * @param {Object} response - Combined frequency response
   * @param {Object} theoreticalMax - Theoretical maximum response
   * @returns {number} Quality score (higher is better)
   */
  calculateQualityScore(response, theoreticalMax) {
    const freqs = response.freqs;
    const magnitude = response.magnitude;
    const theoMagnitude = theoreticalMax.magnitude;
    const len = freqs.length;

    if (len === 0) return 0;

    // ========================================
    // 1. EFFICIENCY SCORE (0-100)
    // ========================================
    // Measures how much of the theoretical maximum we achieve
    let efficiencySum = 0;
    let efficiencyWeightSum = 0;

    for (let i = 0; i < len; i++) {
      const actualLinear = Polar.DbToLinearGain(magnitude[i]);
      const theoLinear = Polar.DbToLinearGain(theoMagnitude[i]);
      const weight = this.frequencyWeights[i];

      if (theoLinear > 0) {
        // Ratio of actual to theoretical (capped at 100%)
        const ratio = Math.min(actualLinear / theoLinear, 1);
        efficiencySum += ratio * weight;
        efficiencyWeightSum += weight;
      }
    }

    const efficiency =
      efficiencyWeightSum > 0 ? (efficiencySum / efficiencyWeightSum) * 100 : 0;

    // ========================================
    // 2. DIP PENALTY (asymmetric - dips are worse than peaks)
    // ========================================
    // Based on MSO methodology: penalize deviations below target more heavily

    // Calculate weighted mean as reference level
    let levelSum = 0;
    let levelWeightSum = 0;
    for (let i = 0; i < len; i++) {
      levelSum += magnitude[i] * this.frequencyWeights[i];
      levelWeightSum += this.frequencyWeights[i];
    }
    const referenceLevel = levelSum / levelWeightSum;

    let dipPenalty = 0;
    let peakPenalty = 0;

    for (let i = 0; i < len; i++) {
      const deviation = magnitude[i] - referenceLevel;
      const weight = this.frequencyWeights[i];

      if (deviation < 0) {
        // DIP: Exponential penalty - small dips are OK, deep dips are catastrophic
        // A 3dB dip is acceptable, 6dB is noticeable, 12dB+ is very bad
        const dipDepth = -deviation;

        if (dipDepth > 3) {
          // Quadratic penalty above 3dB threshold
          const excessDip = dipDepth - 3;
          dipPenalty += Math.pow(excessDip, 1.8) * weight;
        }
      } else {
        // PEAK: Linear penalty - peaks are less problematic (can be EQ'd)
        const peakHeight = deviation;
        if (peakHeight > 3) {
          peakPenalty += (peakHeight - 3) * 0.3 * weight;
        }
      }
    }

    // Normalize by weight sum
    dipPenalty = dipPenalty / levelWeightSum;
    peakPenalty = peakPenalty / levelWeightSum;

    // ========================================
    // 3. NARROWBAND NULL DETECTION
    // ========================================
    // Detect sharp nulls (phase cancellation) - these are unfixable
    let nullPenalty = 0;

    for (let i = 2; i < len - 2; i++) {
      const mag = magnitude[i];

      // Local context (2 points on each side)
      const localAvg =
        (magnitude[i - 2] + magnitude[i - 1] + magnitude[i + 1] + magnitude[i + 2]) / 4;

      const localDip = localAvg - mag;

      // Detect sharp nulls (>6dB drop from local average)
      if (localDip > 6) {
        // Calculate Q factor of the null (narrower = worse)
        // Find -3dB points
        let leftIdx = i,
          rightIdx = i;
        const halfDepth = mag + localDip / 2;

        while (leftIdx > 0 && magnitude[leftIdx] < halfDepth) leftIdx--;
        while (rightIdx < len - 1 && magnitude[rightIdx] < halfDepth) rightIdx++;

        // Narrower null = higher Q = worse (harder to fix)
        const nullWidth = freqs[rightIdx] - freqs[leftIdx];
        const nullQ = freqs[i] / Math.max(nullWidth, 1);

        // High Q nulls in critical bass frequencies are catastrophic
        const qFactor = Math.min(nullQ / 5, 3); // Cap at Q=15
        const depthFactor = Math.pow(localDip / 6, 1.5);

        nullPenalty += depthFactor * qFactor * this.frequencyWeights[i];
      }
    }

    nullPenalty = nullPenalty / levelWeightSum;

    // ========================================
    // 4. SMOOTHNESS SCORE (Spectral Flatness)
    // ========================================
    // Penalize rapid fluctuations (ringing, comb filtering)
    let smoothnessPenalty = 0;

    for (let i = 1; i < len; i++) {
      // Calculate slope in dB/octave
      const octaveSpan = Math.log2(freqs[i] / freqs[i - 1]);
      if (octaveSpan > 0) {
        const slope = Math.abs(magnitude[i] - magnitude[i - 1]) / octaveSpan;

        // Penalize slopes > 12dB/octave (natural rolloff is ~12dB/oct for subs)
        if (slope > 12) {
          const excessSlope = slope - 12;
          smoothnessPenalty += excessSlope * 0.05 * this.frequencyWeights[i];
        }
      }
    }

    smoothnessPenalty = smoothnessPenalty / levelWeightSum;

    // ========================================
    // FINAL SCORE CALCULATION
    // ========================================
    // Weights determined by psychoacoustic importance:
    // - Efficiency: Base score (we want maximum output)
    // - Dips: Very bad (2x weight) - cannot be fixed
    // - Nulls: Catastrophic (3x weight) - phase cancellation
    // - Peaks: Minor issue (0.5x weight) - can be EQ'd
    // - Smoothness: Quality factor (1x weight)

    const score =
      efficiency -
      dipPenalty * 2 -
      nullPenalty * 3 -
      peakPenalty * 0.5 -
      smoothnessPenalty * 1;

    return score;
  }

  // Helper method to evaluate parameters
  evaluateParameters(subToOptimize, previousValidSum, theoreticalMax) {
    const subModified = this.calculateResponseWithParams(subToOptimize);

    const response = this.calculateCombinedResponse([subModified, previousValidSum]);

    // Use the comprehensive quality score
    let score = this.calculateQualityScore(response, theoreticalMax);

    // ========================================
    // DELAY REGULARIZATION (Occam's Razor)
    // ========================================
    // Add a penalty for large absolute delays.
    // This breaks ties between acoustically similar solutions,
    // preferring solutions with smaller delays which are:
    // 1. Easier to implement physically
    // 2. Less prone to temporal smearing
    // 3. More likely to be the "correct" physical alignment
    //
    // The penalty is strong enough to guide the optimizer toward
    // solutions with minimal delays, but not so strong as to
    // override significant acoustic quality differences.
    //
    // At typical delay ranges (±17ms), this adds up to ~2 point penalty
    const maxDelay = Math.max(
      Math.abs(this.config.delay.max),
      Math.abs(this.config.delay.min)
    );
    if (maxDelay > 0) {
      const normalizedDelay = Math.abs(subToOptimize.param.delay) / maxDelay;
      // Quadratic penalty: small delays are almost free, large delays get penalized
      const delayPenalty = Math.pow(normalizedDelay, 2) * 2;
      score -= delayPenalty;
    }

    response.score = score;
    // CRITICAL: Store a deep copy of params to prevent mutation issues with cache
    response.param = structuredClone(subToOptimize.param);
    response.hasAllPass = subToOptimize.param.allPass.enabled;

    return response;
  }

  /**
   * Cached version of evaluateParameters for performance optimization.
   * Uses a hash of the parameters to avoid redundant calculations.
   */
  evaluateParametersCached(subToOptimize, previousValidSum, theoreticalMax) {
    const cacheKey = this._hashParam(subToOptimize.param);

    if (this._evaluationCache.has(cacheKey)) {
      this._cacheHits++;
      const cached = this._evaluationCache.get(cacheKey);
      // Return a shallow copy with deep-cloned param to prevent mutation issues
      return {
        ...cached,
        param: structuredClone(cached.param),
      };
    }

    this._cacheMisses++;
    const result = this.evaluateParameters(
      subToOptimize,
      previousValidSum,
      theoreticalMax
    );

    // Limit cache size to prevent memory issues
    if (this._evaluationCache.size > 10000) {
      // Clear oldest entries (simple strategy: clear half)
      const keysToDelete = Array.from(this._evaluationCache.keys()).slice(0, 5000);
      keysToDelete.forEach(key => this._evaluationCache.delete(key));
    }

    this._evaluationCache.set(cacheKey, result);
    return result;
  }

  /**
   * Creates a hash key for parameter caching.
   */
  _hashParam(param) {
    const precision = 1e6;
    const d = Math.round(param.delay * precision);
    const g = Math.round(param.gain * precision);
    const p = param.polarity;
    const af = param.allPass.enabled ? Math.round(param.allPass.frequency * 100) : 0;
    const aq = param.allPass.enabled ? Math.round(param.allPass.q * 1000) : 0;
    const ae = param.allPass.enabled ? 1 : 0;
    return `${d}|${g}|${p}|${ae}|${af}|${aq}`;
  }

  /**
   * Clears the evaluation cache. Call when starting optimization for a new sub.
   */
  clearEvaluationCache() {
    this._evaluationCache.clear();
    this._cacheHits = 0;
    this._cacheMisses = 0;
  }

  /**
   * Local search (hill climbing) to refine a solution.
   * Uses best-improvement strategy with adaptive step sizes.
   */
  localSearch(
    param,
    subToOptimize,
    previousValidSum,
    theoreticalMax,
    maxIterations = 30
  ) {
    let currentParam = structuredClone(param);
    subToOptimize.param = currentParam;
    let currentResult = this.evaluateParametersCached(
      subToOptimize,
      previousValidSum,
      theoreticalMax
    );

    // Multi-scale search: start coarse, then refine
    const scales = [4, 2, 1, 0.5, 0.25];

    for (const stepMultiplier of scales) {
      let iterationsAtScale = Math.ceil(maxIterations / scales.length);

      for (let iter = 0; iter < iterationsAtScale; iter++) {
        const stepSizes = {
          delay: this.config.delay.step * stepMultiplier,
          gain: this.config.gain.step * stepMultiplier,
          allPassFreq: this.config.allPass?.frequency?.step
            ? this.config.allPass.frequency.step * stepMultiplier
            : 1,
          allPassQ: this.config.allPass?.q?.step
            ? this.config.allPass.q.step * stepMultiplier
            : 0.1,
        };

        const perturbations = [
          { key: 'delay', delta: stepSizes.delay },
          { key: 'delay', delta: -stepSizes.delay },
          { key: 'gain', delta: stepSizes.gain },
          { key: 'gain', delta: -stepSizes.gain },
        ];

        if (currentParam.allPass.enabled) {
          perturbations.push(
            { key: 'allPassFreq', delta: stepSizes.allPassFreq },
            { key: 'allPassFreq', delta: -stepSizes.allPassFreq },
            { key: 'allPassQ', delta: stepSizes.allPassQ },
            { key: 'allPassQ', delta: -stepSizes.allPassQ }
          );
        }

        // Best-improvement strategy: evaluate all neighbors, pick the best
        let bestNeighbor = null;
        let bestNeighborScore = currentResult.score;

        for (const pert of perturbations) {
          const testParam = structuredClone(currentParam);

          if (pert.key === 'delay') {
            testParam.delay = Math.max(
              this.config.delay.min,
              Math.min(this.config.delay.max, testParam.delay + pert.delta)
            );
          } else if (pert.key === 'gain') {
            testParam.gain = Math.max(
              this.config.gain.min,
              Math.min(this.config.gain.max, testParam.gain + pert.delta)
            );
          } else if (pert.key === 'allPassFreq') {
            testParam.allPass.frequency = Math.max(
              this.config.allPass.frequency.min,
              Math.min(
                this.config.allPass.frequency.max,
                testParam.allPass.frequency + pert.delta
              )
            );
          } else if (pert.key === 'allPassQ') {
            testParam.allPass.q = Math.max(
              this.config.allPass.q.min,
              Math.min(this.config.allPass.q.max, testParam.allPass.q + pert.delta)
            );
          }

          subToOptimize.param = testParam;
          const testResult = this.evaluateParametersCached(
            subToOptimize,
            previousValidSum,
            theoreticalMax
          );

          if (testResult.score > bestNeighborScore) {
            bestNeighbor = { param: testParam, result: testResult };
            bestNeighborScore = testResult.score;
          }
        }

        if (bestNeighbor) {
          currentParam = bestNeighbor.param;
          currentResult = bestNeighbor.result;
        } else {
          break; // No improvement at this scale, try finer
        }
      }
    }

    return currentResult;
  }

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
      polarities.reduce((a, b) => a + b, 0) / polarities.length
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

  calculateImprovementPercentage(scoreWithAllPass, scoreWithoutAllPass) {
    return scoreWithAllPass > 0 && scoreWithoutAllPass > 0
      ? (((scoreWithAllPass - scoreWithoutAllPass) / scoreWithoutAllPass) * 100).toFixed(
          2
        )
      : 'N/A';
  }

  logComparisonResults(
    subToOptimize,
    bestWithAllPass,
    bestWithoutAllPass,
    improvementPercentage,
    method
  ) {
    if (bestWithAllPass.score == -Infinity) {
      return;
    }
    this.lm.info(`Sub ${subToOptimize.name} ${method} optimization results:`);
    this.lm.info(`- Best without all-pass: Score ${bestWithoutAllPass.score.toFixed(2)}`);
    this.lm.info(`- Best with all-pass: Score ${bestWithAllPass.score.toFixed(2)}`);
    this.lm.info(`- Improvement with all-pass: ${improvementPercentage}%`);
  }

  // Create the next generation for genetic algorithm
  createNextGeneration(
    evaluated,
    populationSize,
    eliteCount,
    tournamentSize,
    mutationRate,
    mutationAmount
  ) {
    const nextGeneration = [];

    // Elitism - directly copy top performers
    for (let i = 0; i < eliteCount && i < evaluated.length; i++) {
      nextGeneration.push({ ...evaluated[i].param });
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

  createInitialPopulation(size, withAllPassProbability) {
    const population = [];
    const round = (value, step) => Math.round(value / step) * step;

    for (let i = 0; i < size; i++) {
      // Generate random parameters within the configured ranges
      const delay = round(
        this.randomInRange(this.config.delay.min, this.config.delay.max),
        this.config.delay.step
      );

      const gain = round(
        this.randomInRange(this.config.gain.min, this.config.gain.max),
        this.config.gain.step
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
              this.config.allPass.frequency.max
            ),
            this.config.allPass.frequency.step
          ),
          q: round(
            this.randomInRange(this.config.allPass.q.min, this.config.allPass.q.max),
            this.config.allPass.q.step
          ),
          enabled: true,
        };
      }

      population.push({ delay, gain, polarity, allPass });
    }

    return population;
  }

  // Helper for tournament selection
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
      tournament[0]
    );
  }

  // Mutate parameters of an individual
  mutate(individual, mutationAmount) {
    const round = (value, step) => Math.round(value / step) * step;

    this._mutateParameter(
      individual,
      'delay',
      mutationAmount,
      this.config.delay,
      round,
      0.3
    );
    this._mutateParameter(
      individual,
      'gain',
      mutationAmount,
      this.config.gain,
      round,
      0.3
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
        config.step
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
            this.config.allPass.frequency.max
          ),
          this.config.allPass.frequency.step
        );
        individual.allPass.q = round(
          this.randomInRange(this.config.allPass.q.min, this.config.allPass.q.max),
          this.config.allPass.q.step
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
              individual.allPass.frequency + freqMutation
            )
          ),
          this.config.allPass.frequency.step
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
            Math.min(this.config.allPass.q.max, individual.allPass.q + qMutation)
          ),
          this.config.allPass.q.step
        );
      }
    }
  }

  // Add to your class
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

  // Add a method to create seeded random function
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
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
  }

  // Helper method to get random value in range
  randomInRange(min, max) {
    return min + this._random() * (max - min);
  }

  calculateAllPassResponse(frequency, q) {
    // All-pass filter maintains magnitude but changes phase
    // The transfer function is: H(s) = (s² - ω₀/Q·s + ω₀²)/(s² + ω₀/Q·s + ω₀²)

    const w0 = 2 * Math.PI * frequency;

    // For each frequency point, calculate the phase shift
    return freqValue => {
      // Convert frequency to angular frequency
      const w = 2 * Math.PI * freqValue;

      // Calculate phase shift for all-pass filter
      // Phase response of a second-order all-pass is -2*arctan((w0/Q)·w/(w0²-w²))
      let phaseShift = -2 * Math.atan2((w0 * w) / q, w0 * w0 - w * w);

      // Convert to degrees
      phaseShift = (phaseShift * 180) / Math.PI;

      return phaseShift;
    };
  }

  chooseBestSolution(bestWithAllPass, bestWithoutAllPass) {
    // Choose between all-pass and no all-pass based on significant improvement
    const significantImprovement = 2; // 2% improvement threshold

    if (
      bestWithAllPass.score > bestWithoutAllPass.score &&
      bestWithAllPass.score >
        bestWithoutAllPass.score * (1 + significantImprovement / 100)
    ) {
      this.lm.info(`Using all-pass filter for significant improvement`);
      return bestWithAllPass;
    } else if (bestWithoutAllPass.score > 0) {
      return bestWithoutAllPass;
    }
  }
}

export default MultiSubOptimizer;
