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
  };

  constructor(subMeasurements, config = MultiSubOptimizer.DEFAULT_CONFIG) {
    this.validateMeasurements(subMeasurements);
    this.subMeasurements = subMeasurements;
    this.optimizedSubs = [];
    this.config = config;
    this.frequencyWeights = null;
    this.theoreticalMaxResponse = null;

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

    subMeasurements.forEach(frequencyResponse => {
      if (frequencyResponse.freqs.length !== frequencyResponse.magnitude.length) {
        throw new Error('Frequency and magnitude arrays must have the same length');
      }
      if (!frequencyResponse.measurement) {
        throw new Error('Measurement UUID is required');
      }
    });
  }

  generateTestParams() {
    // Pre-calculate parameter ranges

    // Helper function to round to specific decimal places
    const round = (value, resolution = 0.0001) => {
      // Calculate number of decimal places from resolution
      const decimalPlaces = -Math.floor(Math.log10(resolution));
      const multiplier = Math.pow(10, decimalPlaces);
      return Math.round(value * multiplier) / multiplier;
    };

    const delayCount =
      Math.floor(
        (this.config.delay.max - this.config.delay.min) / this.config.delay.step + 0.5
      ) + 1;
    const delays = new Array(delayCount);
    for (let i = 0; i < delayCount; i++) {
      const calc = this.config.delay.min + i * this.config.delay.step;
      const rounded = round(calc, this.config.delay.step);
      delays[i] = rounded;
    }

    const gainCount =
      Math.floor(
        (this.config.gain.max - this.config.gain.min) / this.config.gain.step + 0.5
      ) + 1;
    const gains = new Array(gainCount);
    for (let i = 0; i < gainCount; i++) {
      gains[i] = round(
        this.config.gain.min + i * this.config.gain.step,
        this.config.gain.step
      );
    }

    const testParamsList = [];
    for (const polarity of [1, -1]) {
      for (const delay of delays) {
        for (const gain of gains) {
          testParamsList.push({ delay, gain, polarity });
        }
      }
    }
    return testParamsList;
  }

  optimizeSubwoofers() {
    // 1. Initial measurements preparation
    const preparedSubs = this.prepareMeasurements();

    // Calculate theoretical maximum response
    this.theoreticalMaxResponse = this.calculateCombinedResponse(preparedSubs, true);
    console.debug('Calculated theoretical maximum response');

    // 2. Calculate initial response
    // const initialResponse = this.calculateCombinedResponse(preparedSubs);

    // 3. Optimize parameters for each sub
    const optimizedParams = this.findOptimalParameters(preparedSubs);

    return optimizedParams;
  }

  prepareMeasurements() {
    console.debug('Preparing measurements for optimization');
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
      frequencyResponse.freqs.forEach((freq, index) => {
        // Round down to 7 digits for consistent comparison
        const roundedFreq = Math.floor(freq * scale) / scale;

        if (roundedFreq >= freqRangeStart && roundedFreq <= freqRangeEnd) {
          filteredFreqs.push(freq);
          filteredMagnitude.push(frequencyResponse.magnitude[index]);
          filteredPhase.push(frequencyResponse.phase[index]);
        }
      });
      return {
        measurement: frequencyResponse.measurement,
        freqs: filteredFreqs,
        magnitude: filteredMagnitude,
        phase: filteredPhase,
        freqStep: frequencyResponse.freqStep,
      };
    });

    // check if all measurements have the same frequency points
    const firstFreqs = preparedSubs[0].freqs;
    preparedSubs.forEach((sub, index) => {
      if (sub.freqs.length !== firstFreqs.length) {
        throw new Error(
          `Sub ${index} has a different number of frequency points than the first sub`
        );
      }
      sub.freqs.forEach((freq, freqIndex) => {
        if (freq !== firstFreqs[freqIndex]) {
          throw new Error(
            `Sub ${index} has a different frequency point at index ${freqIndex} than the first sub`
          );
        }
      });
    });

    this.frequencyWeights = this.calculateFrequencyWeights(preparedSubs[0].freqs);

    return preparedSubs;
  }

  findOptimalParameters(preparedSubs) {
    // Early validation
    if (!preparedSubs?.length || preparedSubs.length < 2) {
      return [];
    }

    // Initialize reference sub
    const referenceSub = {
      ...preparedSubs[0],
      param: Object.freeze({ delay: 0, gain: 0, polarity: 1 }),
    };

    const subsWithoutFirst = preparedSubs.slice(1);
    const testParamsList = Object.freeze(this.generateTestParams());
    console.debug(`Optimizing with ${testParamsList.length} test parameters`);

    // Pre-calculate the reference response once
    let previousValidSum = referenceSub;

    this.optimizedSubs = [];
    for (const subToOptimize of subsWithoutFirst) {
      const { bestParams, bestScore, finalResponse } = this.optimizeSingleSub(
        subToOptimize,
        previousValidSum,
        testParamsList
      );

      // Update for next iteration
      previousValidSum = finalResponse;

      this.optimizedSubs.push({
        ...subToOptimize,
        param: bestParams,
        score: bestScore,
      });
    }

    const result = {
      optimizedSubs: this.optimizedSubs,
      bestSum: previousValidSum,
    };

    return result;
  }

  calculateEfficiencyRatio(actualResponse, theoreticalResponse) {
    if (!actualResponse?.magnitude?.length || !theoreticalResponse?.magnitude?.length) {
      return 0;
    }

    let efficiencySum = 0;
    const count = actualResponse.magnitude.length;

    for (let i = 0; i < count; i++) {
      // Convert from dB to linear for proper ratio calculation
      const actualLinear = Math.pow(10, actualResponse.magnitude[i] / 20);
      const theoreticalLinear = Math.pow(10, theoreticalResponse.magnitude[i] / 20);

      // Calculate efficiency at each frequency point (as a percentage)
      const pointEfficiency =
        (actualLinear / theoreticalLinear) * this.frequencyWeights[i] * 100;
      efficiencySum += pointEfficiency;
    }

    // Return average efficiency percentage
    return efficiencySum / count;
  }

  // Helper method to optimize a single sub
  optimizeSingleSub(subToOptimize, previousValidSum, testParamsList) {
    let bestScore = 0;
    let bestParams = null;
    let finalResponse = null;

    const testResults = testParamsList.map(testParams => {
      const subModified = this.calculateResponseWithParams({
        ...subToOptimize,
        param: testParams,
      });

      const combinedResponse = this.calculateCombinedResponse([
        subModified,
        previousValidSum,
      ]);

      const magnitudeScore = this.calculateEfficiencyRatio(
        combinedResponse,
        this.theoreticalMaxResponse
      );

      return {
        score: magnitudeScore,
        params: { ...testParams },
        response: combinedResponse,
      };
    });

    for (const result of testResults) {
      if (result.score > bestScore) {
        bestScore = result.score;
        bestParams = result.params;
        finalResponse = result.response;
      }
    }

    this.checkDelayBoundaries(subToOptimize, bestParams);

    return { bestParams, bestScore, finalResponse };
  }

  getFinalSubSum() {
    const optimizedSubArray = [];
    const defaultParams = Object.freeze({ delay: 0, gain: 0, polarity: 1 });
    for (const originalSub of this.subMeasurements) {
      const found = this.optimizedSubs.find(
        sub => sub.measurement === originalSub.measurement
      );
      originalSub.param = found?.param ? found.param : defaultParams;
      const response = this.calculateResponseWithParams(originalSub);
      optimizedSubArray.push(response);
    }

    const optimizedSubsSum = this.calculateCombinedResponse(optimizedSubArray);

    return optimizedSubsSum;
  }

  // Helper method to check delay boundaries
  checkDelayBoundaries(sub, params) {
    if (
      params.delay === this.config.delay.max ||
      params.delay === this.config.delay.min
    ) {
      console.warn(
        `Optimal delay for ${sub.measurement} is at the edge: ${
          params.delay * 1000
        }ms. This may indicate that the delay range is too narrow.`
      );
    }
  }

  calculateAlignmentScore(response) {
    // Input validation
    if (!response?.magnitude?.length || !response?.phase?.length || !response?.freqs) {
      return 0;
    }
    let coherenceScore = 0;
    const weights = this.frequencyWeights;

    for (let i = 0; i < response.magnitude.length; i++) {
      // Phase coherence: prefer phases closer to 0° or 180°
      const phase = response.phase[i] % 360;

      const phaseRadians = Polar.degreesToRadians(phase);
      const phaseCoherence = Math.abs(Math.cos(phaseRadians));

      // Combine magnitude and phase scores with frequency weighting
      coherenceScore += phaseCoherence * weights[i] * Math.abs(response.magnitude[i]);
    }

    // Normalize the final score
    const totalWeight = weights.reduce(
      (sum, weight, i) => sum + weight * Math.abs(response.magnitude[i]),
      0
    );

    return totalWeight > 0 ? coherenceScore / totalWeight : 0;
  }

  calculateFrequencyWeights(frequencies) {
    const minFreq = Math.min(...frequencies);
    const maxFreq = Math.max(...frequencies);

    // Create weights that consider multiple factors important for subwoofer optimization
    return frequencies.map(freq => {
      // 1. Basic low-frequency emphasis (similar to previous implementation but refined)
      const basicWeight = 1 / Math.pow(freq / minFreq, 0.6); // Adjust power for smoothness

      // 2. Modal region emphasis - most critical for room acoustics (typically 20-80Hz)
      const modalImportance = freq < 80 ? 1.5 : 1.0;

      // 3. Crossover region emphasis - important for integration with mains (usually 80-120Hz)
      const distanceFromCrossover = Math.abs(freq - 80);
      const crossoverImportance = distanceFromCrossover < 20 ? 1.3 : 1.0;

      // 4. De-emphasize extremes of range where measurement accuracy might be lower
      let edgeFactor = 1.0;
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
      return basicWeight * modalImportance * crossoverImportance * edgeFactor;
    });
  }

  calculateAverageLevelScore(response) {
    // Input validation
    if (
      !response ||
      !response.freqs ||
      !response.magnitude ||
      response.freqs.length !== response.magnitude.length
    ) {
      return -Infinity;
    }

    let peak = 0;
    let dip = Infinity;
    let dipSum = 0;
    let levelSum = 0;
    let count = 0;
    const peakThreshold = 5;

    for (let i = 0; i < response.freqs.length; i++) {
      const level = response.magnitude[i];
      const previousLevel = response.magnitude[i - 1] || level;
      peak = Math.max(peak, level);
      dip = Math.min(dip, level);

      // Penalize rapid changes in magnitude (potential destructive interference)
      const diff = level - previousLevel;
      if (diff < -peakThreshold) {
        // More than 3dB change between adjacent frequencies
        dipSum += Math.abs(diff);
      }
      levelSum += level;
      count++;
    }

    // Guard against empty or invalid data
    if (count === 0) {
      return -Infinity;
    }

    // Calculate average magnitude
    const avgMag = levelSum / count;
    // const range = peak - dip;
    const peakBonus = peak * 0.5; // Reduce peak influence
    const score = avgMag + peakBonus - dipSum;

    return score;
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
      lines[i] =
        `${response.freqs[i].toFixed(6)}  ${response.magnitude[i].toFixed(3)} ${response.phase[i].toFixed(4)}`;
    }

    // Join all lines at once instead of concatenating strings
    return lines.join('\n');
  }

  // function to calculate combined response resulting of arthemetic sum operation on magnitude and phase of two responses
  calculateCombinedResponse(subs, theoreticalResponse = false) {
    if (!subs || subs.length === 0) {
      throw new Error('No measurements provided');
    }

    const freqs = subs[0].freqs;
    const freqStep = subs[0].freqStep;
    const combinedMagnitude = new Array(freqs.length).fill(0);
    const combinedPhase = new Array(freqs.length).fill(0);

    // For each frequency point
    for (let freqIndex = 0; freqIndex < freqs.length; freqIndex++) {
      // Process each subwoofer's response
      let polarSum;
      for (const sub of subs) {
        const phase = theoreticalResponse ? 0 : sub.phase[freqIndex];
        // Convert magnitude from dB to linear voltage
        const subPolar = Polar.fromDb(sub.magnitude[freqIndex], phase);

        polarSum = polarSum ? polarSum.add(subPolar) : subPolar;
      }

      combinedMagnitude[freqIndex] = polarSum.magnitudeDb;
      combinedPhase[freqIndex] = polarSum.phaseDegrees;
    }

    return {
      freqs: freqs,
      magnitude: combinedMagnitude,
      phase: combinedPhase,
      freqStep: freqStep,
    };
  }

  calculateResponseWithParams(sub) {
    const size = sub.freqs.length;
    const response = {
      measurement: sub.measurement,
      freqs: sub.freqs,
      magnitude: [],
      phase: [],
      freqStep: sub.freqStep,
    };
    const { gain, delay, polarity } = sub.param;

    for (let freqIndex = 0; freqIndex < size; freqIndex++) {
      // Calculate magnitude
      let polar = Polar.fromDb(sub.magnitude[freqIndex], sub.phase[freqIndex])
        .addGainDb(gain)
        .delay(delay, sub.freqs[freqIndex]);

      if (polarity === -1) {
        polar = polar.invertPolarity();
      }

      // Store results
      response.magnitude.push(polar.magnitudeDb);
      response.phase.push(polar.phaseDegrees);
    }

    return response;
  }

  calculateFlatnessScore(response) {
    const magnitudes = response.magnitude;
    const len = magnitudes.length;

    if (len <= 1) return 0; // Handle edge cases

    let totalVariation = 0;
    let min = magnitudes[0];
    let max = magnitudes[0];

    // Single pass to calculate variation and find min/max
    for (let i = 1; i < len; i++) {
      const current = magnitudes[i];
      const previous = magnitudes[i - 1];

      totalVariation += Math.abs(current - previous);
      min = Math.min(min, current);
      max = Math.max(max, current);
    }
    const range = max - min;
    // Perfectly flat response
    if (range === 0) return 0; // Avoid division by zero

    // Normalize the variation score by the range and length
    const normalizedVariation = totalVariation / (len - 1);
    return normalizedVariation;
  }
}

export default MultiSubOptimizer;
