/**
 * BiquadFilter.js
 *
 * Classe publique représentant un filtre biquad peaking EQ.
 * Les calculs DSP purs sont délégués aux modules biquadCoefficients
 * et biquadResponse.
 */

import { validateNumber } from '../core/validators.js';
import { FILTER_TYPES } from './filterTypes.js';
import {
  computePeakingCoefficients,
  createUnityCoefficients,
} from './biquadCoefficients.js';
import {
  getMagnitudeSquaredFromCoefficients,
  getComplexResponseFromCoefficients,
  getPhaseFromCoefficients,
} from './biquadResponse.js';

/**
 * Classe représentant un filtre biquad
 */
export class BiquadFilter {
  /**
   * @param {number} sampleRate - Fréquence d'échantillonnage (Hz)
   * @throws {TypeError|RangeError} Si les paramètres sont invalides
   */
  constructor(sampleRate = 48000) {
    this.sampleRate = validateNumber(sampleRate, 'sampleRate', 8000, 384000);
    this.freqNorm = (Math.PI * 2) / this.sampleRate;

    // Type de filtre
    this.filterType = FILTER_TYPES.NONE;
    this.enabled = true;

    // Paramètres du filtre
    this.fc = 100;
    this.Q = 10;
    this.gain = 0;

    // Coefficients biquad
    this.a0 = 1;
    this.a1 = 0;
    this.a2 = 0;
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;

    // Coefficients intermédiaires pour calcul rapide
    this.aC2 = 0;
    this.aC3 = 0;
    this.bC2 = 0;
    this.bC3 = 0;
    this.aSum = 1;
    this.bSum = 1;

    // Coefficients de phase
    this.p1 = 1;
    this.p2 = 0;
    this.p3 = 0;
    this.p4 = 0;
    this.p5 = 0;

    // Cache pour calculs
    this.calcDone = false;
    this.calcRate = 0;
  }

  /**
   * Configure un filtre PK (peaking)
   * @param {number} fc - Fréquence centrale (Hz)
   * @param {number} Q - Facteur de qualité
   * @param {number} gain - Gain (dB)
   * @throws {TypeError|RangeError} Si les paramètres sont invalides
   */
  setPeaking(fc, Q, gain) {
    this.fc = validateNumber(fc, 'fc', 10, this.sampleRate * 0.4999);
    this.Q = validateNumber(Q, 'Q', 0.1, 100);
    this.gain = validateNumber(gain, 'gain', -60, 60);
    this.filterType = FILTER_TYPES.PEAKING;
    this.calcBiquad();
  }

  /**
   * Calcule les coefficients biquad
   */
  calcBiquad() {
    try {
      if (this.filterType === FILTER_TYPES.NONE) {
        this.resetToUnity();
        this.calcDone = true;
        return;
      }

      if (this.filterType !== FILTER_TYPES.PEAKING) {
        throw new TypeError(`Unsupported filter type: ${this.filterType}`);
      }

      Object.assign(
        this,
        computePeakingCoefficients({
          fc: this.fc,
          Q: this.Q,
          gain: this.gain,
          sampleRate: this.sampleRate,
        }),
      );

      this.calcDone = true;
      this.calcRate = this.sampleRate;
    } catch (error) {
      this.resetToUnity();
      this.calcDone = true;
      throw new Error(`Failed to calculate biquad coefficients: ${error.message}`, {
        cause: error,
      });
    }
  }

  /**
   * Réinitialise à un filtre passif (gain unitaire)
   */
  resetToUnity() {
    Object.assign(this, createUnityCoefficients());
  }

  /**
   * Calcule la réponse en magnitude au carré (formule exacte biquad)
   * Utilise l'évaluation directe de H(z) sur le cercle unité: z = e^(jω)
   * @param {number} freq - Fréquence en Hz
   * @returns {number} Magnitude au carré
   * @throws {TypeError} Si freq n'est pas un nombre
   */
  getMagnitudeSquared(freq) {
    freq = validateNumber(freq, 'freq', 0, Infinity);

    if (!this.enabled || this.filterType === FILTER_TYPES.NONE) {
      return 1;
    }

    if (freq >= this.sampleRate / 2) {
      freq = (0.9999 * this.sampleRate) / 2;
    }

    if (!this.calcDone || this.calcRate !== this.sampleRate) {
      this.calcBiquad();
    }

    return getMagnitudeSquaredFromCoefficients(this, freq, this.sampleRate);
  }

  /**
   * Calcule la réponse en dB
   * @param {number} freq - Fréquence en Hz
   * @returns {number} Magnitude en dB
   */
  getMagnitudeDB(freq) {
    if (!this.enabled || this.filterType === FILTER_TYPES.NONE) {
      return 0;
    }

    const magSq = this.getMagnitudeSquared(freq);

    // Handle edge case where magSq could be <= 0
    if (magSq <= 0) {
      return -120; // Return a very low dB value instead of -Infinity
    }

    return 10 * Math.log10(Math.max(magSq, Number.EPSILON));
  }

  /**
   * Calcule la réponse complexe du filtre (partie réelle et imaginaire)
   * H(z) = (b0 + b1*z^-1 + b2*z^-2) / (a0 + a1*z^-1 + a2*z^-2)
   * avec z = e^(jω)
   * @param {number} freq - Fréquence en Hz
   * @returns {{re: number, im: number}} Partie réelle et imaginaire de H(e^jω)
   */
  getComplexResponse(freq) {
    if (!this.enabled || this.filterType === FILTER_TYPES.NONE || this.hasNoEffect()) {
      return { re: 1, im: 0 };
    }

    freq = validateNumber(freq, 'freq', 0, Infinity);

    if (freq >= this.sampleRate / 2) {
      freq = (0.9999 * this.sampleRate) / 2;
    }

    if (!this.calcDone || this.calcRate !== this.sampleRate) {
      this.calcBiquad();
    }

    return getComplexResponseFromCoefficients(this, freq, this.sampleRate);
  }

  /**
   * Calcule la phase en degrés
   * @param {number} freq - Fréquence en Hz
   * @returns {number} Phase en degrés
   */
  getPhase(freq) {
    if (!this.enabled || this.filterType === FILTER_TYPES.NONE || this.hasNoEffect()) {
      return 0;
    }

    freq = validateNumber(freq, 'freq', 0, Infinity);

    if (freq >= this.sampleRate / 2) {
      freq = (0.9999 * this.sampleRate) / 2;
    }

    if (!this.calcDone || this.calcRate !== this.sampleRate) {
      this.calcBiquad();
    }

    return getPhaseFromCoefficients(this, freq, this.sampleRate);
  }

  /**
   * Calcule le group delay en millisecondes
   * Group delay = -dφ/dω où φ est la phase en radians et ω est la fréquence angulaire
   * @param {number} freq - Fréquence en Hz
   * @returns {number} Group delay en ms
   */
  getGroupDelay(freq) {
    if (!this.enabled || this.filterType === FILTER_TYPES.NONE || this.hasNoEffect()) {
      return 0;
    }

    freq = validateNumber(freq, 'freq', 1, Infinity);

    // Limit to below Nyquist
    if (freq >= this.sampleRate / 2) {
      freq = (0.9999 * this.sampleRate) / 2;
    }

    // Calculer la phase à freq et freq + delta pour approximer la dérivée
    const delta = freq * 0.001; // 0.1% de la fréquence
    const phase1 = this.getPhase(freq - delta / 2) * (Math.PI / 180); // en radians
    const phase2 = this.getPhase(freq + delta / 2) * (Math.PI / 180); // en radians

    // Gérer le wrapping de phase
    let dPhase = phase2 - phase1;
    if (dPhase > Math.PI) dPhase -= 2 * Math.PI;
    if (dPhase < -Math.PI) dPhase += 2 * Math.PI;

    // Group delay = -dφ/dω = -dφ/(2π * df)
    const dOmega = 2 * Math.PI * delta;
    const groupDelay = -dPhase / dOmega;

    // Convertir en millisecondes
    return groupDelay * 1000;
  }

  /**
   * Vérifie si le filtre n'a aucun effet
   * @returns {boolean}
   */
  hasNoEffect() {
    if (!this.enabled || this.filterType === FILTER_TYPES.NONE) {
      return true;
    }
    if (this.filterType === FILTER_TYPES.PEAKING) {
      return Math.abs(this.gain) < 0.01;
    }
    return false;
  }

  /**
   * Sérialise en JSON
   * @returns {Object}
   */
  toJSON() {
    return {
      type: this.filterType,
      enabled: this.enabled,
      fc: this.fc,
      Q: this.Q,
      gain: this.gain,
      sampleRate: this.sampleRate,
    };
  }

  /**
   * Désérialise depuis JSON
   * @param {Object} json
   * @throws {Error} Si le JSON est invalide
   */
  fromJSON(json) {
    if (!json || typeof json !== 'object') {
      throw new TypeError('JSON must be a valid object');
    }

    try {
      const type = json.type ?? FILTER_TYPES.NONE;
      if (!Object.values(FILTER_TYPES).includes(type)) {
        throw new TypeError(`Unsupported filter type: ${type}`);
      }

      this.filterType = type;
      this.enabled = json.enabled === undefined ? true : Boolean(json.enabled);
      this.fc = validateNumber(json.fc ?? 100, 'fc', 10, 192000);
      this.Q = validateNumber(json.Q ?? 10, 'Q', 0.1, 100);
      this.gain = validateNumber(json.gain ?? 0, 'gain', -60, 60);
      this.sampleRate = validateNumber(
        json.sampleRate ?? 48000,
        'sampleRate',
        8000,
        384000,
      );
      // Update freqNorm when sampleRate changes
      this.freqNorm = (Math.PI * 2) / this.sampleRate;
      this.calcDone = false; // Force recalculation
      this.calcBiquad();
    } catch (error) {
      throw new Error(`Failed to load filter from JSON: ${error.message}`, {
        cause: error,
      });
    }
  }
}
