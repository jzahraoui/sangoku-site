/**
 * FilterQualityEvaluator.js
 *
 * Computes perceptual quality metrics for a set of EQ filters relative to
 * a measurement grid, and decides whether a candidate filter set improves on
 * a baseline.
 *
 * The `evaluate()` output is a plain object:
 *   { score, fullRms, criticalRms, positiveRms, maxOvershoot,
 *     maxAbsError, freqAtMaxAbsError, qRiskPenalty, filterCount }
 *
 * All computations use the same grid and hot-path style (for loops,
 * typed arrays) as the rest of the pipeline.
 */

import {
  createPeakingProfiles,
  sumProfilesDbAtFrequency,
} from '../dsp/peakingProfiles.js';
import { getBoostQUpperBound, getCutQCap, getGridStride } from './math/filterMath.js';

export class FilterQualityEvaluator {
  /**
   * @param {import('./AutoEQConfig.js').AutoEQConfig} config
   */
  constructor(config) {
    this.sampleRate = config.sampleRate;
    this.matchRangeStart = config.matchRangeStart;
    this.matchRangeEnd = config.matchRangeEnd;
    this.criticalBandStart = config.criticalBandStart;
    this.criticalBandEnd = config.criticalBandEnd;
    this.varyQAbove200Hz = config.varyQAbove200Hz;
    this.qRiskPenaltyWeight = config.qRiskPenaltyWeight;
    this.filterCountPenalty = config.filterCountPenalty;
    this.maxFullRmsRegression = config.maxFullRmsRegression;
    this.maxMidRmsRegression = config.maxMidRmsRegression;
    this.maxOvershootRegression = config.maxOvershootRegression;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Evaluates filter quality on the provided calculation context grid.
   *
   * @param {Array}  filters
   * @param {object} calculationContext - { scanFreqs, measuredArr, targetArr, pointsPerOctave }
   * @param {object} [options]
   * @param {number} [options.ppo=48] - Points-per-octave for stride calculation
   * @returns {{ score, fullRms, criticalRms, positiveRms, maxOvershoot,
   *             maxAbsError, freqAtMaxAbsError, qRiskPenalty, filterCount }}
   */
  evaluate(filters, calculationContext, options = {}) {
    const profiles = createPeakingProfiles(filters, this.sampleRate);
    const criticalStart = Math.max(this.matchRangeStart, this.criticalBandStart);
    const criticalEnd = Math.min(this.matchRangeEnd, this.criticalBandEnd);
    const stride = getGridStride(calculationContext.pointsPerOctave, options.ppo ?? 48);

    let fullSum = 0;
    let fullCount = 0;
    let criticalSum = 0;
    let criticalCount = 0;
    let positiveSum = 0;
    let positiveCount = 0;
    let maxOvershoot = 0;
    let maxAbsError = 0;
    let freqAtMaxAbsError = this.matchRangeStart;

    for (let i = 0; i < calculationContext.scanFreqs.length; i += stride) {
      const freq = calculationContext.scanFreqs[i];
      const corrected =
        calculationContext.measuredArr[i] +
        sumProfilesDbAtFrequency(profiles, freq, this.sampleRate);
      const error = corrected - calculationContext.targetArr[i];
      const absError = Math.abs(error);

      fullSum += error * error;
      fullCount++;
      if (absError > maxAbsError) {
        maxAbsError = absError;
        freqAtMaxAbsError = freq;
      }
      if (error > maxOvershoot) {
        maxOvershoot = error;
      }

      if (freq >= criticalStart && freq <= criticalEnd) {
        criticalSum += error * error;
        criticalCount++;
        const positiveError = Math.max(error, 0);
        positiveSum += positiveError * positiveError;
        positiveCount++;
      }
    }

    const fullRms = Math.sqrt(fullSum / Math.max(fullCount, 1));
    const criticalRms = Math.sqrt(criticalSum / Math.max(criticalCount, 1));
    const positiveRms = Math.sqrt(positiveSum / Math.max(positiveCount, 1));
    const qRiskPenalty = this.computeQRiskPenalty(filters);
    const score =
      1.4 * fullRms +
      2.4 * criticalRms +
      0.8 * positiveRms +
      0.08 * maxOvershoot +
      this.qRiskPenaltyWeight * qRiskPenalty +
      this.filterCountPenalty * filters.length;

    return {
      score,
      fullRms,
      criticalRms,
      positiveRms,
      maxOvershoot,
      maxAbsError,
      freqAtMaxAbsError,
      qRiskPenalty,
      filterCount: filters.length,
    };
  }

  /**
   * Returns true if `candidate` is acceptable relative to `baseline`,
   * according to regression guards and optional quality requirements.
   *
   * @param {object} candidateQuality
   * @param {object} baselineQuality
   * @param {object} [options]
   * @returns {boolean}
   */
  acceptCandidate(candidateQuality, baselineQuality, options = {}) {
    const fullLimit = options.fullRegression ?? this.maxFullRmsRegression;
    const midLimit = options.midRegression ?? this.maxMidRmsRegression;
    const overshootLimit = options.overshootRegression ?? this.maxOvershootRegression;

    if (candidateQuality.fullRms > baselineQuality.fullRms + fullLimit) {
      return false;
    }
    if (candidateQuality.criticalRms > baselineQuality.criticalRms + midLimit) {
      return false;
    }
    if (candidateQuality.maxOvershoot > baselineQuality.maxOvershoot + overshootLimit) {
      return false;
    }
    if (
      options.positiveRegression != null &&
      candidateQuality.positiveRms >
        baselineQuality.positiveRms + options.positiveRegression
    ) {
      return false;
    }
    if (candidateQuality.score < baselineQuality.score - (options.scoreMargin ?? 1e-4)) {
      return true;
    }
    if (
      options.allowFilterReduction &&
      candidateQuality.filterCount < baselineQuality.filterCount &&
      candidateQuality.score <= baselineQuality.score + 0.02 &&
      candidateQuality.positiveRms <= baselineQuality.positiveRms + 0.02
    ) {
      return true;
    }
    if (
      options.requireCriticalImprovement &&
      candidateQuality.criticalRms < baselineQuality.criticalRms - 0.005 &&
      candidateQuality.score <= baselineQuality.score + 0.03
    ) {
      return true;
    }
    return false;
  }

  /**
   * Per-filter PASS/WARN/FAIL verdicts (spec FR-008a/FR-008b/FR-017).
   *
   * Bands and absolute safety thresholds:
   *   fc < 300 Hz : WARN above Q=8, FAIL above Q=10
   *   fc ≥ 300 Hz : WARN above Q=10, FAIL above Q=12
   *   boost above 3 kHz : WARN (position-dependent, poorly reproducible)
   *
   * @param {Array<{fc:number, Q:number, gain:number}>} filters
   * @returns {Array<{fc, Q, gain, verdict: 'PASS'|'WARN'|'FAIL', warnings: string[]}>}
   */
  buildFilterVerdicts(filters) {
    return filters.map(filter => {
      const warnings = [];
      let verdict = 'PASS';
      const { warnQ, failQ } =
        filter.fc < 300 ? { warnQ: 8, failQ: 10 } : { warnQ: 10, failQ: 12 };

      if (filter.Q > failQ) {
        verdict = 'FAIL';
        warnings.push(`Q=${filter.Q.toFixed(2)} > ${failQ} (plafond de sécurité)`);
      } else if (filter.Q > warnQ) {
        verdict = 'WARN';
        warnings.push(`Q=${filter.Q.toFixed(2)} > ${warnQ} (risque de ringing)`);
      }

      if (filter.gain > 0 && filter.fc > 3000) {
        if (verdict === 'PASS') verdict = 'WARN';
        warnings.push('boost au-dessus de 3 kHz (dépendant de la position)');
      }

      return { fc: filter.fc, Q: filter.Q, gain: filter.gain, verdict, warnings };
    });
  }

  /**
   * Summed Q-risk penalty across all filters.
   * Exposed so placement code can use it without re-evaluating a full grid.
   *
   * @param {Array} filters
   * @returns {number}
   */
  computeQRiskPenalty(filters) {
    return filters.reduce(
      (total, filter) => total + this._computeFilterQRiskPenalty(filter),
      0,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  _computeFilterQRiskPenalty(filter) {
    if (Math.abs(filter.gain) < 0.1) {
      return 0;
    }
    return filter.gain > 0
      ? this._computeBoostQRiskPenalty(filter)
      : this._computeCutQRiskPenalty(filter);
  }

  _computeBoostQRiskPenalty(filter) {
    const boostQCap = getBoostQUpperBound(filter.fc, this.varyQAbove200Hz);
    let penalty = Math.max(0, filter.Q - boostQCap) * (0.5 + filter.gain / 6);
    if (filter.fc > 1000 && filter.Q > 5) {
      penalty += (filter.Q - 5) * (filter.gain / 6);
    }
    if (filter.fc > 3000) {
      penalty += filter.gain * 0.05;
    }
    return penalty;
  }

  _computeCutQRiskPenalty(filter) {
    const cutQCap = getCutQCap(filter.fc, 10, 8, 5);
    return Math.max(0, filter.Q - cutQCap) * 0.25;
  }
}
