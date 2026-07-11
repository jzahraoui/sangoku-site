import Polar from '../Polar.js';

// Pre-EQ score — temporal guard tuning. Excess group delay below one period
// at the affected frequency is masked by the room's own modal decay; beyond
// it, the quadratic ramp charges the score. The per-bin cap keeps unwrap
// artifacts and band-edge anomalies (10-16 Hz, low weights) from dominating,
// and the weight scales the term against efficiency (0-200 after its ×2).
const GROUP_DELAY_ALLOWANCE_CYCLES = 1;
const GROUP_DELAY_PER_BIN_CAP = 9;
const PRE_EQ_GROUP_DELAY_WEIGHT = 2;
const MEDIAN_MAX_SAMPLES = 192;

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

    // Weights determined by psychoacoustic importance.
    // Efficiency is weighted 2× because it represents proximity to the
    // theoretical maximum (coherent sum). Without this weight, the optimizer
    // sacrifices level to reduce dips — acceptable with all-pass filters (which
    // can correct phase without losing level) but harmful without them (where
    // delay is the only tool and trades level for smoothness). The 2× weight
    // ensures the optimizer does not degrade the overall level when smoothing
    // the response.
    return (
      efficiency * 2 -
      dipPenalty * 3 -
      nullPenalty * 3 -
      peakPenalty * 0.5 -
      smoothnessPenalty
    );
  }

  // =========================================================
  // Pre-EQ score — public entry point
  // =========================================================

  /**
   * Quality score for a response that will be EQ'd toward a target curve
   * afterwards ('pre-eq' objective).
   *
   * Downstream EQ corrects peaks (a cut is free and, for minimum-phase room
   * modes, also shortens their time-domain ringing), broad bumps and overall
   * tilt — so unlike the balanced score, peaks and smoothness are NOT
   * penalized here. What EQ cannot fix is what this score targets:
   *  1. Overall level below the coherent sum (efficiency): every dB lost is
   *     a dB of boost/headroom needed later to reach the target.
   *  2. Localized shortfalls vs the theoretical envelope (dips-vs-theo) and
   *     narrow phase-cancellation nulls: boosting a cancellation does not
   *     fill it.
   *  3. Group-delay excess (bass that trails in time): energy arriving late
   *     at some frequencies cannot be re-aligned by magnitude EQ.
   *
   * @param {Object} response - Combined frequency response
   * @param {Object} theoreticalMax - Theoretical maximum response (phase=0)
   * @returns {number} Score (higher is better)
   */
  calculatePreEqScore(response, theoreticalMax) {
    const { freqs, magnitude } = response;
    const len = freqs.length;
    if (len === 0) return 0;

    const efficiency = this._calculateEfficiencyScore(
      magnitude,
      theoreticalMax.magnitude,
      len,
    );

    let levelWeightSum = 0;
    for (let i = 0; i < len; i++) levelWeightSum += this.frequencyWeights[i];

    const dipVsTheoPenalty = this._calculateDipVsTheoPenalty(
      magnitude,
      theoreticalMax.magnitude,
      levelWeightSum,
      len,
    );
    const nullPenalty = this._calculateNullPenalty(freqs, magnitude, levelWeightSum, len);
    const groupDelayPenalty = this._calculateGroupDelayExcessPenalty(
      freqs,
      response.phase,
      levelWeightSum,
      len,
    );

    return (
      efficiency * 2 -
      dipVsTheoPenalty * 3 -
      nullPenalty * 3 -
      groupDelayPenalty * PRE_EQ_GROUP_DELAY_WEIGHT
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
    // Average in the linear power domain so the reference tracks acoustic
    // energy rather than the log of the dB values. Averaging in dB underweights
    // peaks and biases the dip/peak penalties.
    let powerSum = 0;
    let levelWeightSum = 0;
    for (let i = 0; i < len; i++) {
      const weight = this.frequencyWeights[i];
      const linear = Polar.DbToLinearGain(magnitude[i]);
      powerSum += linear * linear * weight;
      levelWeightSum += weight;
    }
    const meanPower = levelWeightSum > 0 ? powerSum / levelWeightSum : 0;
    const referenceLevel = 10 * Math.log10(Math.max(meanPower, Number.EPSILON));
    return { referenceLevel, levelWeightSum };
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

  /**
   * Penalizes LOCALIZED shortfalls below the theoretical envelope. The
   * uniform part of the shortfall (the weighted-median gap to theo) is pure
   * efficiency loss, already counted by the efficiency term; what is
   * penalized here is a bin falling more than 3 dB deeper than that typical
   * gap — a hole in the achievable curve that EQ boost cannot fill cheaply.
   * Same functional form as the balanced dip penalty (pow 1.8 over a 3 dB
   * allowance) so the two scores stay comparable in magnitude.
   */
  _calculateDipVsTheoPenalty(magnitude, theoMagnitude, levelWeightSum, len) {
    const shortfalls = new Float64Array(len);
    for (let i = 0; i < len; i++) {
      shortfalls[i] = theoMagnitude[i] - magnitude[i];
    }
    const medianShortfall = this._weightedMedian(shortfalls, len);

    let dipPenalty = 0;
    for (let i = 0; i < len; i++) {
      const excess = shortfalls[i] - medianShortfall;
      if (excess > 3) {
        dipPenalty += Math.pow(excess - 3, 1.8) * this.frequencyWeights[i];
      }
    }
    return dipPenalty / levelWeightSum;
  }

  /**
   * Penalizes group-delay excess of the combined response — "bass trailing
   * in time". The group delay is derived from the unwrapped phase; the
   * weighted-median group delay (bulk arrival time) is free, and each bin is
   * charged for its excess beyond GROUP_DELAY_ALLOWANCE_CYCLES periods at
   * that frequency (below ~1 period the smear is masked by the room's own
   * modal decay). Quadratic ramp with a per-bin cap so a single unwrap
   * artifact or band-edge anomaly cannot dominate the score.
   */
  _calculateGroupDelayExcessPenalty(freqs, phase, levelWeightSum, len) {
    if (!phase || phase.length !== len || len < 3) return 0;

    const tau = this._groupDelaySeconds(freqs, phase, len);
    const medianTau = this._weightedMedian(tau, len);

    let penalty = 0;
    for (let i = 0; i < len; i++) {
      const excessCycles = Math.abs(tau[i] - medianTau) * freqs[i];
      if (excessCycles <= GROUP_DELAY_ALLOWANCE_CYCLES) continue;
      const overshoot = excessCycles - GROUP_DELAY_ALLOWANCE_CYCLES;
      penalty +=
        Math.min(overshoot * overshoot, GROUP_DELAY_PER_BIN_CAP) *
        this.frequencyWeights[i];
    }
    return penalty / levelWeightSum;
  }

  /** Group delay (seconds) via central difference on the unwrapped phase. */
  _groupDelaySeconds(freqs, phase, len) {
    const unwrapped = new Float64Array(len);
    unwrapped[0] = phase[0];
    let offset = 0;
    for (let i = 1; i < len; i++) {
      const delta = phase[i] - phase[i - 1];
      if (delta > 180) offset -= 360;
      else if (delta < -180) offset += 360;
      unwrapped[i] = phase[i] + offset;
    }

    const tau = new Float64Array(len);
    for (let i = 0; i < len; i++) {
      const lo = i === 0 ? 0 : i - 1;
      const hi = i === len - 1 ? len - 1 : i + 1;
      tau[i] = -(unwrapped[hi] - unwrapped[lo]) / (freqs[hi] - freqs[lo]) / 360;
    }
    return tau;
  }

  /**
   * Weighted median of `values` using the scorer's frequency weights.
   * Subsampled (stride) to bound the per-evaluation sort cost: the median is
   * robust and the inputs (shortfall, group delay) vary smoothly on the
   * log-frequency grid, so ~MEDIAN_MAX_SAMPLES points estimate it well.
   */
  _weightedMedian(values, len) {
    const stride = Math.max(1, Math.ceil(len / MEDIAN_MAX_SAMPLES));
    const indices = [];
    for (let i = 0; i < len; i += stride) indices.push(i);
    indices.sort((a, b) => values[a] - values[b]);

    let total = 0;
    for (const i of indices) total += this.frequencyWeights[i];

    let acc = 0;
    for (const i of indices) {
      acc += this.frequencyWeights[i];
      if (acc >= total / 2) return values[i];
    }
    return values[indices.at(-1)];
  }

  _calculateSmoothnessPenalty(freqs, magnitude, levelWeightSum, len) {
    // Obs F: 12 dB/oct stays the threshold (in-band region: any slope above
    // this is a real resonance edge, not a natural rolloff). Above the
    // threshold we use a quadratic ramp calibrated so that the contribution at
    // a typical resonance slope (~24 dB/oct) matches the legacy linear penalty,
    // while sharper spikes get weighted more decisively. A per-bin cap then
    // prevents any single outlier from saturating the smoothness term and
    // overshadowing broader smoothness issues.
    const SLOPE_THRESHOLD_DB_PER_OCT = 12;
    const SLOPE_REFERENCE_DB_PER_OCT = 24;
    const REFERENCE_CONTRIBUTION = 0.6; // == legacy (24 - 12) * 0.05
    const PER_BIN_PENALTY_CAP = 2.5;
    const slopeNorm = SLOPE_REFERENCE_DB_PER_OCT - SLOPE_THRESHOLD_DB_PER_OCT;
    let smoothnessPenalty = 0;

    for (let i = 1; i < len; i++) {
      const octaveSpan = Math.log2(freqs[i] / freqs[i - 1]);
      if (octaveSpan <= 0) continue;

      const slope = Math.abs(magnitude[i] - magnitude[i - 1]) / octaveSpan;
      if (slope <= SLOPE_THRESHOLD_DB_PER_OCT) continue;

      const overshoot = (slope - SLOPE_THRESHOLD_DB_PER_OCT) / slopeNorm;
      const binPenalty = Math.min(
        overshoot * overshoot * REFERENCE_CONTRIBUTION,
        PER_BIN_PENALTY_CAP,
      );
      smoothnessPenalty += binPenalty * this.frequencyWeights[i];
    }

    return smoothnessPenalty / levelWeightSum;
  }
}

export default Scorer;
