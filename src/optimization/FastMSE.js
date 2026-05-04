/**
 * FastMSE.js
 * Calcul rapide du MSE pondéré
 *
 * addMSERange (grille ADDITIVE, pas = max(0.5, f * PPO96_STEP)):
 *   - Poids w = max(0.5, f*step) / (f*step)   → sur-pondère basses fréquences
 *   - deltaInit = splNoHiddenFilters(f) - roomCurve(f) - target(f)
 *
 * fastMSE :
 *   f3 = (baseDeltas[i] + filtersdB) * weights[i]       ← poids appliqué d'abord
 *   overshoot = filtersdB - boostPenaltyThresholdDb
 *   if (overshoot > 0) f3 += 10 * overshoot             ← pénalité SANS poids
 *   sum += f3 * f3
 *   return sum / count                                   ← normalisé par COUNT (pas sum(w²))
 */

import { buildMseGrid } from './mseGrid.js';
import {
  prepareProfileCoefficients,
  prepareProfileCoefficientsWithCandidateParams,
  computeBaseMSE,
  computeFilteredMSE,
} from './filterMseKernel.js';

const MAX_PROFILES = 30;

export class FastMSE {
  /**
   * @param {number} boostPenaltyThresholdDb - Seuil de pénalité pour boost excessif en dB
   * @param {number} sampleRate
   */
  constructor(boostPenaltyThresholdDb = 6, sampleRate = 48000) {
    this.boostPenaltyThresholdDb = boostPenaltyThresholdDb;
    this.sampleRate = sampleRate;

    // Données MSE (remplies par initFromGrid)
    this._mseFreqs = null;
    this._mseWeights = null;
    this._mseDeltas = null;
    this._mseSth = null;
    this._mseSth2 = null;
    this._mseCount = 0;

    // Buffers pré-alloués pour les coefficients de profils
    this._pC2 = new Float64Array(MAX_PROFILES);
    this._pAC3 = new Float64Array(MAX_PROFILES);
    this._pASum = new Float64Array(MAX_PROFILES);
    this._pBC3 = new Float64Array(MAX_PROFILES);
    this._pBSum = new Float64Array(MAX_PROFILES);

    // Stable object referencing the buffers above — created once, reused every call.
    this._profileArrays = {
      c2: this._pC2,
      aC3: this._pAC3,
      aSum: this._pASum,
      bC3: this._pBC3,
      bSum: this._pBSum,
    };
  }

  /**
   * Initialise les données MSE directement depuis une grille fréquentielle brute.
   * @param {Array<{start: number, end: number}>} spans
   * @param {ArrayLike<number>} freqs
   * @param {ArrayLike<number>} measuredMagnitude
   * @param {ArrayLike<number>} targetMagnitude
   */
  initFromGrid(spans, freqs, measuredMagnitude, targetMagnitude) {
    const grid = buildMseGrid({
      spans,
      freqs,
      measuredMagnitude,
      targetMagnitude,
      sampleRate: this.sampleRate,
    });

    this._mseFreqs = grid.freqs;
    this._mseWeights = grid.weights;
    this._mseDeltas = grid.deltas;
    this._mseSth = grid.sth;
    this._mseSth2 = grid.sth2;
    this._mseCount = grid.count;
  }

  _getProfileArrays() {
    return this._profileArrays;
  }

  /**
   * Calcule le MSE avec un ensemble de filtres donné.
   *
   *   f3 = (mseSPLDeltas[i] + filtersdB) * mseWeights[i]   ← poids avant pénalité
   *   if (filtersdB - boostPenaltyThresholdDb > 0) f3 += 10 * boostOvershoot  ← pénalité sans poids
   *   sum += f3²
   *   return sum / count                                         ← divisé par count
   *
   * @param {Array<{fc: number, Q: number, gain: number}>} filters
   * @returns {number} MSE (dB² pondéré, normalisé par count)
   */
  compute(filters) {
    if (this._mseCount === 0) return 0;

    const arrays = this._getProfileArrays();
    const numActive = prepareProfileCoefficients({
      filters,
      sampleRate: this.sampleRate,
      arrays,
    });

    if (numActive === 0) {
      return computeBaseMSE({
        n: this._mseCount,
        deltas: this._mseDeltas,
        weights: this._mseWeights,
      });
    }

    return computeFilteredMSE({
      n: this._mseCount,
      numActive,
      deltas: this._mseDeltas,
      weights: this._mseWeights,
      sth: this._mseSth,
      sth2: this._mseSth2,
      arrays,
      boostPenaltyThresholdDb: this.boostPenaltyThresholdDb,
      penalizeTargetOvershoot: false,
    });
  }

  /**
   * Calcule le MSE avec un filtre TEST supplémentaire (sans modifier la liste).
   * Utilisé pour évaluer les candidats sans créer de copie du tableau.
   *
   * @param {Array<{fc, Q, gain}>} filters - Filtres existants
   * @param {number} testFc
   * @param {number} testQ
   * @param {number} testGain
   * @returns {number} MSE
   */
  computeWithCandidate(filters, testFc, testQ, testGain) {
    if (this._mseCount === 0) return 0;

    const arrays = this._getProfileArrays();
    const numActive = prepareProfileCoefficientsWithCandidateParams({
      filters,
      candidateFc: testFc,
      candidateQ: testQ,
      candidateGain: testGain,
      sampleRate: this.sampleRate,
      arrays,
    });

    if (numActive === 0) {
      return computeBaseMSE({
        n: this._mseCount,
        deltas: this._mseDeltas,
        weights: this._mseWeights,
      });
    }

    return computeFilteredMSE({
      n: this._mseCount,
      numActive,
      deltas: this._mseDeltas,
      weights: this._mseWeights,
      sth: this._mseSth,
      sth2: this._mseSth2,
      arrays,
      boostPenaltyThresholdDb: this.boostPenaltyThresholdDb,
      penalizeTargetOvershoot: false,
    });
  }

  /**
   * Calcule l'erreur RMS courante (pour reporting)
   * @param {Array<{fc, Q, gain}>} filters
   * @returns {number} RMS en dB
   */
  rms(filters) {
    return Math.sqrt(this.compute(filters));
  }

  get count() {
    return this._mseCount;
  }
}
