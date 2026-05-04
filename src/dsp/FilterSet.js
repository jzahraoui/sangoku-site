/**
 * FilterSet.js
 * Ensemble de filtres biquad
 */

import { validateNumber } from '../core/validators.js';
import { BiquadFilter } from './BiquadFilter.js';
import { FILTER_TYPES } from './filterTypes.js';
import {
  getCumulativeResponse,
  getCumulativeComplexResponse,
  getCumulativeGroupDelay,
  getGroupDelayStats,
} from './filterSetResponse.js';
import { filterSetToJSON, loadFilterSetFromJSON } from './filterSetSerialization.js';

export class FilterSet {
  /**
   * @param {number} numFilters - Nombre de filtres
   * @param {number} sampleRate - Fréquence d'échantillonnage
   */
  constructor(numFilters = 10, sampleRate = 48000) {
    numFilters = validateNumber(numFilters, 'numFilters', 1, 100);
    this.sampleRate = validateNumber(sampleRate, 'sampleRate', 8000, 384000);
    this.filters = [];

    for (let i = 0; i < numFilters; i++) {
      this.filters.push(new BiquadFilter(sampleRate));
    }
  }

  /**
   * Calcule la réponse cumulée de tous les filtres
   * @param {number} freq - Fréquence en Hz
   * @returns {number} Magnitude cumulée en dB
   */
  getCumulativeResponse(freq) {
    freq = validateNumber(freq, 'freq', 0, Infinity);
    return getCumulativeResponse(this.filters, freq);
  }

  /**
   * Calcule la réponse complexe cumulée de tous les filtres (multiplication complexe)
   * Équivalent à une convolution dans le domaine temporel
   * @param {number} freq - Fréquence en Hz
   * @returns {{re: number, im: number, magnitude: number, phase: number}} Réponse complexe
   */
  getCumulativeComplexResponse(freq) {
    freq = validateNumber(freq, 'freq', 0, Infinity);
    return getCumulativeComplexResponse(this.filters, freq);
  }

  /**
   * Calcule le group delay cumulé de tous les filtres
   * @param {number} freq - Fréquence en Hz
   * @returns {number} Group delay total en ms
   */
  getCumulativeGroupDelay(freq) {
    freq = validateNumber(freq, 'freq', 1, Infinity);
    return getCumulativeGroupDelay(this.filters, freq);
  }

  /**
   * Calcule les statistiques de group delay sur une plage de fréquences
   * @param {number} startFreq - Fréquence de début (Hz)
   * @param {number} endFreq - Fréquence de fin (Hz)
   * @param {number} points - Nombre de points (défaut 100)
   * @returns {{min: number, max: number, maxFreq: number, range: number, avgAbsVariation: number}}
   */
  getGroupDelayStats(startFreq = 20, endFreq = 20000, points = 100) {
    return getGroupDelayStats({ filters: this.filters, startFreq, endFreq, points });
  }

  /**
   * Obtient les filtres actifs
   * @returns {BiquadFilter[]}
   */
  getActiveFilters() {
    return this.filters.filter(f => f.enabled && !f.hasNoEffect());
  }

  /**
   * Réinitialise tous les filtres
   */
  resetAll() {
    for (const f of this.filters) {
      f.filterType = FILTER_TYPES.NONE;
      f.gain = 0;
      f.enabled = true;
      f.resetToUnity();
      f.calcDone = true;
    }
  }

  /**
   * Sérialise en JSON
   * @returns {Object}
   */
  toJSON() {
    return filterSetToJSON(this);
  }

  /**
   * Désérialise depuis JSON
   * @param {Object} json
   * @throws {Error} Si le JSON est invalide
   */
  fromJSON(json) {
    loadFilterSetFromJSON(this, json);
  }
}
