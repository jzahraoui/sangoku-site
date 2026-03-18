import Polar from './Polar.js';

/**
 * Scorer — Frequency response quality metrics
 *
 * Computes psychoacoustic quality scores and frequency weights
 * used by the multi-sub optimizer.
 *
 * All instance methods require frequencyWeights to be set via constructor.
 * Static helpers (buildWeights, computeFrequencyWeight) are pure.
 */
class Scorer {
  /**
   * @param {Float32Array} frequencyWeights - Pre-computed perceptual weights
   */
  constructor(frequencyWeights) {
    this.frequencyWeights = frequencyWeights;
  }

  // =========================================================
  // Static helpers — pure, no instance state required
  // =========================================================

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
  static computeFrequencyWeight(freq) {
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
   * Builds a Float32Array of perceptual weights for the given frequency array.
   * @param {ArrayLike<number>} frequencies
   * @returns {Float32Array}
   */
  static buildWeights(frequencies) {
    const weights = new Float32Array(frequencies.length);
    for (let i = 0; i < frequencies.length; i++) {
      weights[i] = Scorer.computeFrequencyWeight(frequencies[i]);
    }
    return weights;
  }

  // =========================================================
  // Efficiency
  // =========================================================

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
    if (actualResponse.magnitude.length !== theoreticalResponse.magnitude.length) {
      throw new Error('Magnitude arrays must have the same length');
    }
    if (actualResponse.magnitude.length !== this.frequencyWeights.length) {
      throw new Error('Frequency weights array must match magnitude array length');
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

  // =========================================================
  // Quality score — public entry point
  // =========================================================

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
    const { freqs, magnitude } = response;
    const len = freqs.length;
    if (len === 0) return 0;

    const efficiency = this._calculateEfficiencyScore(
      magnitude,
      theoreticalMax.magnitude,
      len,
    );
    const { referenceLevel, levelWeightSum } = this._calculateReferenceLevel(
      magnitude,
      len,
    );
    const { dipPenalty, peakPenalty } = this._calculateDipPeakPenalties(
      magnitude,
      referenceLevel,
      levelWeightSum,
      len,
    );
    const nullPenalty = this._calculateNullPenalty(freqs, magnitude, levelWeightSum, len);
    const smoothnessPenalty = this._calculateSmoothnessPenalty(
      freqs,
      magnitude,
      levelWeightSum,
      len,
    );

    // Weights determined by psychoacoustic importance
    return (
      efficiency -
      dipPenalty * 3 -
      nullPenalty * 3 -
      peakPenalty * 0.5 -
      smoothnessPenalty
    );
  }

  // =========================================================
  // Quality score — private sub-components
  // =========================================================

  _calculateEfficiencyScore(magnitude, theoMagnitude, len) {
    let efficiencySum = 0;
    let efficiencyWeightSum = 0;

    for (let i = 0; i < len; i++) {
      const actualLinear = Polar.DbToLinearGain(magnitude[i]);
      const theoLinear = Polar.DbToLinearGain(theoMagnitude[i]);
      const weight = this.frequencyWeights[i];

      if (theoLinear > 0) {
        const ratio = Math.min(actualLinear / theoLinear, 1);
        efficiencySum += ratio * weight;
        efficiencyWeightSum += weight;
      }
    }

    return efficiencyWeightSum > 0 ? (efficiencySum / efficiencyWeightSum) * 100 : 0;
  }

  _calculateReferenceLevel(magnitude, len) {
    let levelSum = 0;
    let levelWeightSum = 0;
    for (let i = 0; i < len; i++) {
      levelSum += magnitude[i] * this.frequencyWeights[i];
      levelWeightSum += this.frequencyWeights[i];
    }
    return { referenceLevel: levelSum / levelWeightSum, levelWeightSum };
  }

  _calculateDipPeakPenalties(magnitude, referenceLevel, levelWeightSum, len) {
    let dipPenalty = 0;
    let peakPenalty = 0;

    for (let i = 0; i < len; i++) {
      const deviation = magnitude[i] - referenceLevel;
      const weight = this.frequencyWeights[i];

      if (deviation < 0) {
        const dipDepth = -deviation;
        if (dipDepth > 3) {
          dipPenalty += Math.pow(dipDepth - 3, 1.8) * weight;
        }
      } else if (deviation > 3) {
        peakPenalty += (deviation - 3) * 0.3 * weight;
      }
    }

    return {
      dipPenalty: dipPenalty / levelWeightSum,
      peakPenalty: peakPenalty / levelWeightSum,
    };
  }

  _calculateNullPenalty(freqs, magnitude, levelWeightSum, len) {
    let nullPenalty = 0;

    for (let i = 2; i < len - 2; i++) {
      const mag = magnitude[i];
      const localAvg =
        (magnitude[i - 2] + magnitude[i - 1] + magnitude[i + 1] + magnitude[i + 2]) / 4;
      const localDip = localAvg - mag;

      if (localDip > 6) {
        nullPenalty += this._calculateNullPenaltyAtIndex(
          freqs,
          magnitude,
          i,
          localDip,
          len,
        );
      }
    }

    return nullPenalty / levelWeightSum;
  }

  _calculateNullPenaltyAtIndex(freqs, magnitude, i, localDip, len) {
    const mag = magnitude[i];
    const halfDepth = mag + localDip / 2;

    let leftIdx = i;
    let rightIdx = i;
    while (leftIdx > 0 && magnitude[leftIdx] < halfDepth) leftIdx--;
    while (rightIdx < len - 1 && magnitude[rightIdx] < halfDepth) rightIdx++;

    const nullWidth = freqs[rightIdx] - freqs[leftIdx];
    const nullQ = freqs[i] / Math.max(nullWidth, 1);
    const qFactor = Math.min(nullQ / 5, 3);
    const depthFactor = Math.pow(localDip / 6, 1.5);

    return depthFactor * qFactor * this.frequencyWeights[i];
  }

  _calculateSmoothnessPenalty(freqs, magnitude, levelWeightSum, len) {
    let smoothnessPenalty = 0;

    for (let i = 1; i < len; i++) {
      const octaveSpan = Math.log2(freqs[i] / freqs[i - 1]);
      if (octaveSpan > 0) {
        const slope = Math.abs(magnitude[i] - magnitude[i - 1]) / octaveSpan;
        if (slope > 12) {
          smoothnessPenalty += (slope - 12) * 0.05 * this.frequencyWeights[i];
        }
      }
    }

    return smoothnessPenalty / levelWeightSum;
  }
}

export default Scorer;
