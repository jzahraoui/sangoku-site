import Polar from './Polar.js';

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

  constructor(subMeasurements, config = MultiSubOptimizer.DEFAULT_CONFIG) {
    this.validateMeasurements(subMeasurements);
    this.subMeasurements = subMeasurements;
    this.optimizedSubs = [];
    this.config = config;
    this.frequencyWeights = null;
    this.theoreticalMaxResponse = null;
    this.logText = '\n';

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

  appendLogText(text) {
    this.logText += text;
    this.logText += '\n';
    console.debug(text);
  }

  generatesLogResults(executionTime, optimizedSubs, bestScore) {
    this.appendLogText('Optimized parameters:');
    for (const sub of optimizedSubs) {
      let allpassLog = 'allpass: disabled';
      if (sub.param.allPass?.enabled) {
        allpassLog = `allpass: freq: ${sub.param.allPass.frequency}Hz Q: ${sub.param.allPass.q}`;
      }
      const delayMs = (sub.param.delay * 1000).toFixed(2);
      const infoMessage = `${sub.name} inverted: ${
        sub.param.polarity === -1
      } delay: ${delayMs}ms`;
      this.appendLogText(`${infoMessage} ${allpassLog}`);
    }

    // convert execution time to human readable format - FIX: properly format duration in ms
    const seconds = Math.floor((executionTime % 60000) / 1000);
    const milliseconds = Math.floor(executionTime % 1000);

    // Format as HH:MM:SS.mmm
    const humanReadableTime = `${seconds}.${milliseconds.toString().padStart(3, '0')}s`;

    this.appendLogText(`Execution time: ${humanReadableTime}`);
    this.appendLogText(`Best score: ${bestScore.toFixed(2)}`);
  }

  prepareMeasurements() {
    // Normalize measurements and prepare for processing
    const preparedSubs = this.subMeasurements.map(frequencyResponse => {
      // Normalize frequency response
      // remove outside frequency range
      const scale = 1e7;
      const freqRangeStart = Math.fround(this.config.frequency.min);
      const freqRangeEnd = Math.fround(this.config.frequency.max);

      // Create new arrays to store filtered values
      const filteredFreqs = [];
      const filteredMagnitude = [];
      const filteredPhase = [];

      // Iterate through frequencies and keep only those within range
      for (let index = 0; index < frequencyResponse.freqs.length; index++) {
        const freq = frequencyResponse.freqs[index];
        const roundedFreq = Math.floor(freq * scale) / scale;

        if (roundedFreq >= freqRangeStart && roundedFreq <= freqRangeEnd) {
          filteredFreqs.push(freq);
          filteredMagnitude.push(frequencyResponse.magnitude[index]);
          filteredPhase.push(frequencyResponse.phase[index]);
        }
      }
      return {
        measurement: frequencyResponse.measurement,
        name: frequencyResponse.name,
        freqs: filteredFreqs,
        magnitude: filteredMagnitude,
        phase: filteredPhase,
        freqStep: frequencyResponse.freqStep,
        endFreq: filteredFreqs.at(-1),
        startFreq: filteredFreqs[0],
        param: MultiSubOptimizer.EMPTY_CONFIG,
        ppo: frequencyResponse.ppo,
      };
    });

    // check if all measurements have the same frequency points
    const firstFreqs = preparedSubs[0].freqs;
    const preparedSubsWithoutFirst = preparedSubs.slice(1);
    for (let index = 0; index < preparedSubsWithoutFirst.length; index++) {
      const sub = preparedSubsWithoutFirst[index];
      if (sub.freqs.length !== firstFreqs.length) {
        throw new Error(
          `Sub ${index} has a different number of frequency points than the first sub`
        );
      }
      for (let freqIndex = 0; freqIndex < sub.freqs.length; freqIndex++) {
        const freq = sub.freqs[freqIndex];
        const precision = 1e3;
        const roundedFreq = Math.floor(freq * precision) / precision;
        const roundedFirstFreq =
          Math.floor(firstFreqs[freqIndex] * precision) / precision;
        if (roundedFreq !== roundedFirstFreq) {
          throw new Error(
            `Sub ${index} has a different frequency point at index ${freqIndex} than the first sub`
          );
        }
      }
    }

    this.frequencyWeights = this.calculateFrequencyWeights(preparedSubs[0].freqs);

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

    this.appendLogText(
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
      options.testParamsList = Object.freeze(this.generateTestParams(5)); // Coarse params
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
   * Calculates the efficiency ratio between actual and theoretical frequency responses.
   *
   * This method compares how well the actual combined subwoofer response performs
   * relative to the theoretical maximum possible response at each frequency point.
   *
   * The calculation process:
   * 1. Converts dB magnitudes to linear gain values for proper ratio calculation
   * 2. Calculates point-wise efficiency: (actual/theoretical) × 100%
   * 3. Applies frequency weighting to emphasize important bass frequencies
   * 4. Returns the weighted average efficiency across all frequency points
   *
   * Higher values indicate better efficiency - the actual response is closer
   * to the theoretical maximum. Values above 100% indicate constructive
   * interference beyond the theoretical sum, while lower values indicate
   * destructive interference or suboptimal alignment.
   *
   * @param {Object} actualResponse - Current combined frequency response
   * @param {Object} theoreticalResponse - Theoretical maximum response (all subs in-phase)
   * @returns {number} Weighted average efficiency percentage (0-100+%)
   */
  calculateEfficiencyRatio(actualResponse, theoreticalResponse) {
    if (!actualResponse?.magnitude?.length || !theoreticalResponse?.magnitude?.length) {
      return 0;
    }

    let efficiencySum = 0;
    const count = actualResponse.magnitude.length;

    for (let i = 0; i < count; i++) {
      // Convert from dB to linear for proper ratio calculation
      const actualLinear = Polar.DbToLinearGain(actualResponse.magnitude[i]);
      const theoreticalLinear = Polar.DbToLinearGain(theoreticalResponse.magnitude[i]);

      // Calculate efficiency at each frequency point (as a percentage)
      const pointEfficiency = (actualLinear / theoreticalLinear) * 100;
      const pointEfficiencyWeighted = pointEfficiency * this.frequencyWeights[i];
      efficiencySum += pointEfficiencyWeighted;
    }

    // Return average efficiency percentage
    return efficiencySum / count;
  }

  updateBestSolutions(evaluated, bestWithAllPass, bestWithoutAllPass) {
    const highest = evaluated[0];
    let highestWithoutAllPass, highestWithAllPass;
    if (highest.hasAllPass) {
      highestWithAllPass = highest;
      highestWithoutAllPass = evaluated.find(individual => !individual.hasAllPass);
    } else {
      highestWithAllPass = evaluated.find(individual => individual.hasAllPass);
      highestWithoutAllPass = highest;
    }

    if (highestWithAllPass?.score > bestWithAllPass.score) {
      Object.assign(bestWithAllPass, highestWithAllPass);
    }
    if (highestWithoutAllPass?.score > bestWithoutAllPass.score) {
      Object.assign(bestWithoutAllPass, highestWithoutAllPass);
    }
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
      bestWithAllPass,
      bestWithoutAllPass,
    } = options;
    let generationsWithoutImprovement = 0;
    let previousBestScore = 0;
    let bestInRun = null;

    for (let generation = 0; generation < generations; generation++) {
      const adaptiveMutation = mutationAmount * (1 - generation / generations);
      const evaluated = population.map(param => {
        subToOptimize.param = param;
        return this.evaluateParameters(subToOptimize, previousValidSum, theo);
      });

      evaluated.sort((a, b) => b.score - a.score);
      const highest = evaluated[0];

      this.updateBestSolutions(evaluated, bestWithAllPass, bestWithoutAllPass);

      if (highest.score > previousBestScore) {
        previousBestScore = highest.score;
        generationsWithoutImprovement = 0;
        bestInRun = highest;
      } else {
        generationsWithoutImprovement++;
      }

      if (
        generationsWithoutImprovement >= maxNoImprovementGenerations &&
        generation >= 20
      ) {
        console.debug(
          `Early stopping at generation ${generation} - no improvement for ${maxNoImprovementGenerations} generations`
        );
        break;
      }

      if (generation === generations - 1) break;

      population = this.createNextGeneration(
        evaluated,
        populationSize,
        eliteCount,
        tournamentSize,
        mutationRate,
        adaptiveMutation
      );
    }

    return bestInRun;
  }

  findBestCoarseParam(subToOptimize, previousValidSum, theo, testParamsList) {
    let bestCoarse = null;
    for (const param of testParamsList) {
      subToOptimize.param = param;
      const individual = this.evaluateParameters(subToOptimize, previousValidSum, theo);
      if (!bestCoarse || individual.score > bestCoarse.score) bestCoarse = individual;
    }
    return bestCoarse.param;
  }

  createHybridPopulation(coarseBest, populationSize, withAllPassProbability) {
    const focusedCount = Math.floor(populationSize * 0.6);
    const randomCount = populationSize - focusedCount;
    const population = [];

    for (let i = 0; i < focusedCount; i++) {
      const individual = structuredClone(coarseBest);
      this.mutate(individual, 0.2);
      population.push(individual);
    }

    population.push(...this.createInitialPopulation(randomCount, withAllPassProbability));
    return population;
  }

  // Helper method to optimize a single sub
  optimizeSingleSub(subToOptimize, previousValidSum, options = {}) {
    // Set defaults with the genetic algorithm as the default approach
    const {
      method = 'genetic',
      testParamsList = null,
      populationSize = 110,
      generations = 80, // Number of generations for genetic algorithm
      eliteCount = 0.13 * populationSize, // 13% of population
      mutationRate = 0.5, // Mutation rate for genetic algorithm
      mutationAmount = 0.4, // Mutation amount for genetic algorithm
      tournamentSize = 3, // Tournament size for selection
      withAllPassProbability = 0.7,
      seed = null, // Add seed parameter
      runs = 1, // Number of independent runs
      maxNoImprovementGenerations = 10, // Early stopping criteria
    } = options;

    let bestWithAllPass = { score: -Infinity };
    let bestWithoutAllPass = { score: -Infinity };

    if (!testParamsList) {
      throw new Error('coarseParams is required for genetic optimization');
    }

    // Set random seed if provided
    if (seed === null) {
      this._random = Math.random;
    } else {
      this._random = this._createSeededRandom(seed);
    }

    // Calculate theoretical maximum response once
    const theo = this.calculateCombinedResponse([subToOptimize, previousValidSum], true);

    // Different optimization strategies
    if (method === 'genetic') {
      let bestOverall = null;
      const coarseBest = this.findBestCoarseParam(
        subToOptimize,
        previousValidSum,
        theo,
        testParamsList
      );

      for (let run = 0; run < runs; run++) {
        const population = this.createHybridPopulation(
          coarseBest,
          populationSize,
          withAllPassProbability
        );

        // Add early stopping criteria
        const bestInRun = this.runGeneticLoop(
          subToOptimize,
          previousValidSum,
          theo,
          population,
          {
            generations,
            populationSize,
            eliteCount,
            tournamentSize,
            mutationRate,
            mutationAmount,
            maxNoImprovementGenerations,
            bestWithAllPass,
            bestWithoutAllPass,
          }
        );

        // Track the best overall solution across runs
        if (!bestOverall || bestInRun.score > bestOverall.score) {
          bestOverall = bestInRun;
        }
      }
    } else if (method === 'classic') {
      for (const param of testParamsList) {
        subToOptimize.param = param;
        const individual = this.evaluateParameters(subToOptimize, previousValidSum, theo);

        if (individual.hasAllPass && individual.score > bestWithAllPass.score) {
          bestWithAllPass = individual;
        } else if (
          !individual.hasAllPass &&
          individual.score > bestWithoutAllPass.score
        ) {
          bestWithoutAllPass = individual;
        }
      }
    }

    // Compare all-pass vs non-all-pass solutions
    const improvementPercentage = this.calculateImprovementPercentage(
      bestWithAllPass.score,
      bestWithoutAllPass.score
    );

    // Log the comparison results
    this.logComparisonResults(
      subToOptimize,
      bestWithAllPass,
      bestWithoutAllPass,
      improvementPercentage,
      method
    );

    const finalResponse = this.chooseBestSolution(bestWithAllPass, bestWithoutAllPass);

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
      const message = `WARNING: Optimal delay for ${sub.name} is at the edge: ${delayMs}ms.
       This may indicate that the delay range is too narrow.`;
      this.appendLogText(message);
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
      console.warn('Invalid response data for alignment score');
      return 0;
    }
    if (
      !this.frequencyWeights ||
      this.frequencyWeights.length !== response.freqs.length
    ) {
      console.warn('Frequency weights not available or mismatched for alignment score');
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

  // TODO: adjut basicweightPower to get more consistent results
  calculateFrequencyWeights(frequencies) {
    const minFreq = Math.min(...frequencies);
    const maxFreq = Math.max(...frequencies);
    const basicweightPower = 0.15; // Adjust power for smoothness
    const modalRegionFrequency = 160; // Hz

    // Create weights that consider multiple factors important for subwoofer optimization
    return frequencies.map(freq => {
      // 1. Basic low-frequency emphasis - more weight for lower frequencies
      const basicWeight = 1 / Math.pow(freq / minFreq, basicweightPower); // Adjust power for smoothness

      // 2. Modal region emphasis - most critical for room acoustics (typically 20-80Hz)
      const modalImportance = freq < modalRegionFrequency ? 1.5 : 1;

      // 4. De-emphasize extremes of range where measurement accuracy might be lower
      let edgeFactor = 1;
      if (freq < minFreq * 1.2) {
        // Low extreme
        const normalizedPosition = (freq - minFreq) / (minFreq * 0.2);
        edgeFactor = 0.5 + 0.5 * normalizedPosition;
      } else if (freq > maxFreq * 0.8) {
        // High extreme
        const normalizedPosition = (maxFreq - freq) / (maxFreq * 0.2);
        edgeFactor = 0.5 + 0.5 * normalizedPosition;
      }

      // Combine all factors - multiply for compound effect
      return basicWeight * modalImportance * edgeFactor;
    });
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

  // function to calculate combined response resulting of arthemetic sum operation on magnitude and phase of two responses
  calculateCombinedResponse(subs, theoreticalResponse = false) {
    if (!subs?.length) throw new Error('No measurements provided');

    const freqs = subs[0].freqs;
    const freqStep = subs[0].freqStep;
    const ppo = subs[0].ppo;
    const combinedMagnitude = new Array(freqs.length);
    const combinedPhase = new Array(freqs.length);

    // For each frequency point
    for (let freqIndex = 0; freqIndex < freqs.length; freqIndex++) {
      // Process each subwoofer's response
      let polarSum = null;
      for (const sub of subs) {
        const phase = theoreticalResponse ? 0 : sub.phase[freqIndex];
        // Convert magnitude from dB to linear voltage
        const subPolar = Polar.fromDb(sub.magnitude[freqIndex], phase);

        polarSum = polarSum ? polarSum.add(subPolar) : subPolar;
      }

      combinedMagnitude[freqIndex] = polarSum.magnitudeDb;
      combinedPhase[freqIndex] = polarSum.phaseDegrees;
    }

    return { freqs, magnitude: combinedMagnitude, phase: combinedPhase, freqStep, ppo };
  }

  calculateResponseWithParams(sub) {
    const size = sub.freqs.length;
    const response = {
      measurement: sub.measurement,
      name: sub.name,
      freqs: sub.freqs,
      magnitude: [],
      phase: [],
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
      response.magnitude.push(polar.magnitudeDb);
      response.phase.push(polar.phaseDegrees);
    }

    return response;
  }

  /**
   * Calculates a penalty score for frequency response dips/drops.
   * Penalizes rapid magnitude drops between adjacent frequency points,
   * weighted by frequency importance.
   *
   * @param {Object} response - Frequency response with magnitude array
   * @returns {number} Penalty score where higher values indicate more problematic dips
   */
  dipPenaltyScore(response) {
    if (
      response?.freqs?.length !== response?.magnitude?.length ||
      response?.freqs?.length === 0
    ) {
      return 0; // Return 0 penalty for invalid input instead of -Infinity
    }

    // Validate frequency weights availability
    if (
      !this.frequencyWeights ||
      this.frequencyWeights.length !== response.freqs.length
    ) {
      console.warn('Frequency weights unavailable, using uniform weighting');
      this.frequencyWeights = new Array(response.freqs.length).fill(1);
    }

    let dipPenalty = 0;

    // Fixed threshold - 3dB is a reasonable threshold for detecting problematic drops
    // Adaptive threshold based on frequency resolution
    // Higher resolution (smaller spacing) = lower threshold for detecting drops
    const dropThreshold = Math.max(3, response.freqStep * 17);

    let allreadyCountedDip = false;

    for (let i = 1; i < response.freqs.length; i++) {
      // Start from i=1
      const currentLevel = response.magnitude[i];
      const previousLevel = response.magnitude[i - 1]; // Fixed: use adjacent point
      const weight = this.frequencyWeights[i];

      // Validate individual data points
      if (
        !Number.isFinite(currentLevel) ||
        !Number.isFinite(previousLevel) ||
        !Number.isFinite(weight)
      ) {
        continue;
      }

      // Calculate drop (positive value indicates a drop in level)
      const drop = previousLevel - currentLevel;

      if (drop > dropThreshold && !allreadyCountedDip) {
        // Scale penalty by drop severity and frequency importance
        const severityFactor = Math.min(drop / dropThreshold, 3); // Cap at 3x threshold
        const weightedPenalty = drop * severityFactor * weight;

        dipPenalty += weightedPenalty;
        allreadyCountedDip = true; // Set flag to avoid double counting
      } else {
        allreadyCountedDip = false; // Reset flag when no drop detected
      }
    }

    return dipPenalty / 2;
  }

  /**
   * Calculates a comprehensive flatness score for frequency response analysis.
   *
   * The score combines three key metrics with configurable weightings:
   * 1. Overall flatness: Standard deviation from mean magnitude (50% weight)
   * 2. Local smoothness: RMS of adjacent point variations (30% weight)
   * 3. Peak-to-peak range: Total dynamic range across frequency band (20% weight)
   *
   * Lower scores indicate flatter, smoother responses which are generally
   * more desirable for subwoofer optimization. The function penalizes both
   * overall deviations from the mean level and rapid local variations
   * between adjacent frequency points.
   *
   * @param {Object} response - Frequency response with magnitude array
   * @returns {number} Flatness where lower values indicate flatter response
   */
  calculateFlatnessScore(response) {
    const magnitudes = response.magnitude;
    const len = magnitudes.length;

    if (len <= 1) return 0; // Handle edge cases

    // Calculate mean level for reference
    const meanLevel = magnitudes.reduce((sum, val) => sum + val, 0) / len;

    // Calculate variance (squared deviation from mean)
    let variance = 0;
    let deviationSum = 0;
    let localVariationSum = 0;
    let min = magnitudes[0];
    let max = magnitudes[0];

    // Weighted analysis of both overall deviation and local variations
    for (let i = 0; i < len; i++) {
      // Overall deviation from mean (flatness across whole range)
      const deviation = magnitudes[i] - meanLevel;
      deviationSum += Math.pow(deviation, 2);

      // Local variation (smoothness between adjacent points)
      if (i > 0) {
        const localDiff = magnitudes[i] - magnitudes[i - 1];
        // Square the difference to penalize larger jumps more
        localVariationSum += Math.pow(localDiff, 2);
      }

      // Track min/max for peak-to-peak measurement
      min = Math.min(min, magnitudes[i]);
      max = Math.max(max, magnitudes[i]);
    }

    // Calculate standard deviation (overall flatness)
    variance = deviationSum / len;
    const stdDev = Math.sqrt(variance);

    // Calculate RMS of local variations (smoothness)
    const localRMS = Math.sqrt(localVariationSum / (len - 1));

    // Peak-to-peak range (another flatness indicator)
    const peakToPeak = max - min;

    // Weighted combination of factors - lower is better (flatter)
    // Weight factors can be adjusted based on what aspects of flatness are most important
    const overallWeight = 0.5; // How much we care about overall deviation
    const localWeight = 0.3; // How much we care about local smoothness
    const peakWeight = 0.2; // How much we care about peak-to-peak range

    // Combining the metrics (normalizing each factor first)
    const normalizedStdDev = stdDev;
    const normalizedLocalRMS = localRMS * 2; // Scale up local variations for better sensitivity
    const normalizedPeakToPeak = peakToPeak / 3; // Divide by typical range for subwoofers

    // Final score (lower is better - flatter response)
    const flatnessScore =
      overallWeight * normalizedStdDev +
      localWeight * normalizedLocalRMS +
      peakWeight * normalizedPeakToPeak;

    return flatnessScore;
  }

  // Helper method to evaluate parameters
  evaluateParameters(subToOptimize, previousValidSum, theoreticalMax) {
    const subModified = this.calculateResponseWithParams(subToOptimize);

    const response = this.calculateCombinedResponse([subModified, previousValidSum]);

    const efficiencyRatioscore = this.calculateEfficiencyRatio(response, theoreticalMax);

    const dipPenaltyScore = this.dipPenaltyScore(response);

    response.score = efficiencyRatioscore - dipPenaltyScore;
    response.param = subToOptimize.param;
    response.hasAllPass = subToOptimize.param.allPass.enabled;

    return response;
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
    const message = `Sub ${subToOptimize.name} ${method} optimization results:
    - Best without all-pass: Score ${bestWithoutAllPass.score.toFixed(2)}
    - Best with all-pass: Score ${bestWithAllPass.score.toFixed(2)}
    - Improvement with all-pass: ${improvementPercentage}%`;
    this.appendLogText(message);
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
    // Simple xorshift implementation
    let state = seed;
    return function () {
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
      this.appendLogText(`Using all-pass filter for significant improvement`);
      return bestWithAllPass;
    } else if (bestWithoutAllPass.score > 0) {
      return bestWithoutAllPass;
    }
  }
}

export default MultiSubOptimizer;
