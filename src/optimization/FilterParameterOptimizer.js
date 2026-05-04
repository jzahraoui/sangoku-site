/**
 * FilterParameterOptimizer.js
 * Optimisation des paramètres de filtres
 *
 * Transforme cosinus (_C.f5948D):
 *   Forward (x → t):  t = acos((2*x - lo - hi) / (hi - lo))   range [lo,hi] → [0,π]
 *   Inverse (t → x):  x = (lo+hi)/2 + (hi-lo)*cos(t)/2        range [0,π]  → [lo,hi]
 *
 * `optimizeGainAndQ()` optimise les gains et les Q sur les bandes actives.
 * `optimizeAllParameters()` optimise gains, Q et fréquences centrales.
 *
 * Les bornes Q restent dépendantes de la fréquence et du gain pour reproduire
 * le comportement REW, mais les noms sont volontairement descriptifs.
 */

import { optimizeWithNewtonBfgs } from './NewtonBfgsOptimizer.js';
import { peakMagExact } from '../dsp/peakingMagnitude.js';
import {
  prepareProfileCoefficients,
  computeBaseMSE,
  computeFilteredMSE,
} from './filterMseKernel.js';
import { buildOptimizationFrequencyGrid } from './frequencyGrid.js';
import { buildOptimizationState } from './optimizationState.js';
import { createOptimizationDecoder } from './optimizerDecoding.js';

const MAX_PROFILES = 30;

export class FilterParameterOptimizer {
  /**
   * @param {Object} config
   * @param {number} config.sampleRate
   * @param {number} config.startFreq
   * @param {number} config.endFreq
   * @param {number} config.boostPenaltyThresholdDb
   * @param {number} config.maxBoostDb
   * @param {number} config.maxCutDb
   */
  constructor(config) {
    this.sampleRate = config.sampleRate ?? 48000;
    this.startFreq = config.startFreq ?? 20;
    this.endFreq = config.endFreq ?? 20000;
    this.boostPenaltyThresholdDb = config.boostPenaltyThresholdDb ?? 6;
    this.maxBoostDb = config.maxBoostDb ?? 6;
    this.maxCutDb = config.maxCutDb ?? 12;
    this.varyQAbove200Hz = config.varyQAbove200Hz ?? false;
    this.allowNarrowFiltersBelow200Hz = config.allowNarrowFiltersBelow200Hz ?? true;
    this.maxQ = config.maxQ ?? 10;

    this._freqs = null;
    this._weights = null;
    this._measuredDeltas = null;
    this._sth = null;
    this._sth2 = null;
    this._numPoints = 0;
    this._measuredSPLFn = null;
    this._targetCurveFn = null;

    // Pre-allocated biquad coefficient arrays (zero-alloc fast path)
    this._pAC2 = new Float64Array(MAX_PROFILES);
    this._pAC3 = new Float64Array(MAX_PROFILES);
    this._pASum = new Float64Array(MAX_PROFILES);
    this._pBC2 = new Float64Array(MAX_PROFILES);
    this._pBC3 = new Float64Array(MAX_PROFILES);
    this._pBSum = new Float64Array(MAX_PROFILES);
  }

  /**
   * Initialise directement depuis une grille fréquentielle brute.
   * @param {ArrayLike<number>} freqs
   * @param {ArrayLike<number>} measuredMagnitude
   * @param {ArrayLike<number>} targetMagnitude
   * @param {Array<{start:number,end:number}>} [spans]
   */
  initializeFromGrid(freqs, measuredMagnitude, targetMagnitude, spans = null) {
    this._measuredSPLFn = this._buildNearestAccessor(freqs, measuredMagnitude);
    this._targetCurveFn = this._buildNearestAccessor(freqs, targetMagnitude);

    const grid = buildOptimizationFrequencyGrid({
      freqs,
      measuredMagnitude,
      targetMagnitude,
      spans,
      startFreq: this.startFreq,
      endFreq: this.endFreq,
      sampleRate: this.sampleRate,
    });
    this._freqs = grid.freqs;
    this._weights = grid.weights;
    this._measuredDeltas = grid.deltas;
    this._sth = grid.sth;
    this._sth2 = grid.sth2;
    this._numPoints = grid.numPoints;
    this._decNumPoints = grid.decNumPoints;
    this._decDeltas = grid.decDeltas;
    this._decWeights = grid.decWeights;
    this._decSth = grid.decSth;
    this._decSth2 = grid.decSth2;
  }

  /**
   * Optimise gains et Q sur la bande utile des filtres.
   * @param {Array<{fc,Q,gain}>} filters - modifiés in-place
   * @param {Function} [onLog]
   */
  async optimizeGainAndQ(filters, onLog = null, maxIter = 500) {
    if (filters.length === 0 || this._numPoints === 0) return;
    await this._runOptimize(
      filters,
      /*optimizeQ=*/ true,
      /*optimizeFc=*/ false,
      maxIter,
      onLog ?? (() => {}),
      /*useDecimated=*/ true,
    );
  }

  /**
   * Optimise gains, Q et fréquences centrales.
   * @param {Array<{fc,Q,gain}>} filters - modifiés in-place
   * @param {Function} [onLog]
   */
  async optimizeAllParameters(filters, onLog = null, maxIter = 500, options = {}) {
    if (filters.length === 0 || this._numPoints === 0) return;
    await this._runOptimize(
      filters,
      /*optimizeQ=*/ true,
      /*optimizeFc=*/ true,
      maxIter,
      onLog ?? (() => {}),
      options.useDecimated ?? false,
      options.penalizeTargetOvershoot ?? true,
    );
  }

  // ==================== PRIVATE ====================

  _buildNearestAccessor(freqs, magnitude) {
    return freq => magnitude[this._findNearestIndex(freqs, freq)];
  }

  _findNearestIndex(freqs, targetFreq) {
    if (targetFreq <= freqs[0]) {
      return 0;
    }

    const lastIndex = freqs.length - 1;
    if (targetFreq >= freqs[lastIndex]) {
      return lastIndex;
    }

    let left = 0;
    let right = lastIndex;

    while (right - left > 1) {
      const mid = (left + right) >> 1;
      if (freqs[mid] < targetFreq) {
        left = mid;
      } else {
        right = mid;
      }
    }

    return Math.abs(freqs[right] - targetFreq) < Math.abs(targetFreq - freqs[left])
      ? right
      : left;
  }

  /**
   * MSE — zero-allocation fast path.
   * Uses pre-computed sTh/sTh2 and pre-allocated biquad coefficient arrays.
   *   f3 = (delta + filtersdB) * w         ← poids appliqué d'abord
   *   if overshoot > 0: f3 += 10*overshoot ← pénalité SANS poids
   *   return sum(f3²) / count              ← divisé par COUNT
   */
  _computeMSE(filters, penalizeTargetOvershoot = false) {
    const n = this._numPoints;
    if (n === 0) return 0;

    const arrays = {
      aC3: this._pAC3,
      aSum: this._pASum,
      bC3: this._pBC3,
      bSum: this._pBSum,
      c2: this._pAC2,
    };

    const numActive = prepareProfileCoefficients({
      filters,
      sampleRate: this.sampleRate,
      arrays,
    });
    if (numActive === 0) {
      return computeBaseMSE({ n, deltas: this._measuredDeltas, weights: this._weights });
    }

    return computeFilteredMSE({
      n,
      numActive,
      deltas: this._measuredDeltas,
      weights: this._weights,
      sth: this._sth,
      sth2: this._sth2,
      arrays,
      boostPenaltyThresholdDb: this.boostPenaltyThresholdDb,
      penalizeTargetOvershoot,
    });
  }

  _initializeZeroGains(filters) {
    for (const filter of filters) {
      if (filter.gain === 0) {
        let filterSum = 0;
        for (const other of filters) {
          if (other !== filter && other.gain !== 0) {
            filterSum += peakMagExact(
              other.fc,
              other.Q,
              other.gain,
              filter.fc,
              this.sampleRate,
            );
          }
        }
        filter.gain =
          -(this._measuredSPLFn(filter.fc) + filterSum - this._targetCurveFn(filter.fc)) /
          2;
      }
    }
  }

  _copyOptimizedFilters(filters, workingFilters) {
    for (let i = 0; i < filters.length; i++) {
      filters[i].fc = workingFilters[i].fc;
      filters[i].Q = workingFilters[i].Q;
      filters[i].gain = workingFilters[i].gain;
    }
  }

  /**
   * Cœur de l'optimisation des paramètres de filtres.
   *
   * Ordre param encodé: [gains₀..N, Qs₀..N, fcs₀..N]
   * Ordre de décodage:  fcs → gains → Qs
   * Bornes angulaires:  [0, π]  (domaine de la transformée cosinus)
   */
  async _runOptimize(
    filters,
    optimizeQ,
    optimizeFc,
    maxIter,
    log,
    useDecimated = true,
    penalizeTargetOvershoot = false,
  ) {
    this._initializeZeroGains(filters);

    const state = buildOptimizationState({
      filters,
      optimizeQ,
      optimizeFc,
      startFreq: this.startFreq,
      endFreq: this.endFreq,
      maxCutDb: this.maxCutDb,
      maxBoostDb: this.maxBoostDb,
      maxQ: this.maxQ,
      varyQAbove200Hz: this.varyQAbove200Hz,
    });

    const decode = createOptimizationDecoder({
      state,
      optimizeQ,
      optimizeFc,
      maxQ: this.maxQ,
      varyQAbove200Hz: this.varyQAbove200Hz,
    });

    decode(state.initT);
    const mseBefore = this._computeMSE(filters);

    const wf = state.workingFilters;

    // Optionally swap to decimated grid for BFGS (halves inner-loop cost)
    let fullN, fullDeltas, fullWeights, fullSth, fullSth2;
    if (useDecimated) {
      fullN = this._numPoints;
      fullDeltas = this._measuredDeltas;
      fullWeights = this._weights;
      fullSth = this._sth;
      fullSth2 = this._sth2;
      this._numPoints = this._decNumPoints;
      this._measuredDeltas = this._decDeltas;
      this._weights = this._decWeights;
      this._sth = this._decSth;
      this._sth2 = this._decSth2;
    }

    const objectiveFn = t => {
      decode(t);
      return this._computeMSE(wf, penalizeTargetOvershoot);
    };

    try {
      const result = await optimizeWithNewtonBfgs(objectiveFn, state.initT, {
        maxIterations: maxIter,
      });

      // Restore full grid before final evaluation
      if (useDecimated) {
        this._numPoints = fullN;
        this._measuredDeltas = fullDeltas;
        this._weights = fullWeights;
        this._sth = fullSth;
        this._sth2 = fullSth2;
      }

      decode(result.x);
      const mseAfter = this._computeMSE(state.workingFilters);

      if (mseAfter < mseBefore) {
        this._copyOptimizedFilters(filters, state.workingFilters);
        log(
          `  Optimizer(${optimizeFc ? 'gain+Q+fc' : 'gain+Q'}): ` +
            `${Math.sqrt(mseBefore).toFixed(3)} → ${Math.sqrt(mseAfter).toFixed(3)} dB RMS`,
        );
      } else {
        log(
          `  Optimizer(${optimizeFc ? 'gain+Q+fc' : 'gain+Q'}): pas d'améliorat. ` +
            `(${Math.sqrt(mseBefore).toFixed(3)} dB RMS)`,
        );
      }
    } catch (e) {
      if (useDecimated) {
        this._numPoints = fullN;
        this._measuredDeltas = fullDeltas;
        this._weights = fullWeights;
        this._sth = fullSth;
        this._sth2 = fullSth2;
      }
      log(`  Optimizer échoué: ${e.message}`);
    }
  }
}
