/**
 * BiquadFilter.js
 *
 * Classe publique représentant un filtre biquad (peaking, all-pass,
 * passe-bas/haut 6 et 12 dB/oct, notch, shelves, modal — les types de l'EQ
 * Generic de REW). Les calculs DSP purs sont délégués aux modules
 * biquadCoefficients et biquadResponse.
 */

import { validateNumber } from '../core/validators.js';
import { FILTER_TYPES, SHELF_VARIANTS } from './filterTypes.js';
import {
  computeAllPassCoefficients,
  computePeakingCoefficients,
  computeLowPassCoefficients,
  computeHighPassCoefficients,
  computeLowPass1Coefficients,
  computeHighPass1Coefficients,
  computeNotchCoefficients,
  computeShelfCoefficients,
  computeModalCoefficients,
  createUnityCoefficients,
} from './biquadCoefficients.js';
import {
  getMagnitudeSquaredFromCoefficients,
  getComplexResponseFromCoefficients,
  getPhaseFromCoefficients,
} from './biquadResponse.js';

function validateShelfVariant(variant) {
  if (!SHELF_VARIANTS.includes(variant)) {
    throw new RangeError(`Unknown shelf variant: ${variant}`);
  }
  return variant;
}

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
    this.shelfVariant = 'plain'; // shelves uniquement
    this.t60Target = 0; // Modal uniquement

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
   * Configure un filtre all-pass du second ordre (|H| = 1, rotation de phase
   * de −360° avec −180° à fc). Réalisation DSP du all-pass de l'optimiseur
   * de subs (slot 20/21 côté REW).
   * @param {number} fc - Fréquence centrale (Hz)
   * @param {number} Q - Facteur de qualité
   * @throws {TypeError|RangeError} Si les paramètres sont invalides
   */
  setAllPass(fc, Q) {
    this.fc = validateNumber(fc, 'fc', 1, this.sampleRate * 0.4999);
    this.Q = validateNumber(Q, 'Q', 0.1, 100);
    this.gain = 0;
    this.filterType = FILTER_TYPES.ALL_PASS;
    this.calcBiquad();
  }

  /**
   * Configure un passe-bas 12 dB/oct (type REW « LP », Q forcé à √2/2)
   * @param {number} fc - Fréquence de coupure (Hz)
   */
  setLowPass(fc) {
    this.fc = validateNumber(fc, 'fc', 1, this.sampleRate * 0.4999);
    this.Q = Math.SQRT2 / 2;
    this.gain = 0;
    this.filterType = FILTER_TYPES.LOW_PASS;
    this.calcBiquad();
  }

  /**
   * Configure un passe-haut 12 dB/oct (type REW « HP », Q forcé à √2/2)
   * @param {number} fc - Fréquence de coupure (Hz)
   */
  setHighPass(fc) {
    this.fc = validateNumber(fc, 'fc', 1, this.sampleRate * 0.4999);
    this.Q = Math.SQRT2 / 2;
    this.gain = 0;
    this.filterType = FILTER_TYPES.HIGH_PASS;
    this.calcBiquad();
  }

  /**
   * Configure un passe-bas 6 dB/oct du premier ordre (type REW « LP1 »)
   * @param {number} fc - Fréquence de coupure (Hz)
   */
  setLowPass1(fc) {
    this.fc = validateNumber(fc, 'fc', 1, this.sampleRate * 0.4999);
    this.Q = 0.5;
    this.gain = 0;
    this.filterType = FILTER_TYPES.LOW_PASS_1;
    this.calcBiquad();
  }

  /**
   * Configure un passe-haut 6 dB/oct du premier ordre (type REW « HP1 »)
   * @param {number} fc - Fréquence de coupure (Hz)
   */
  setHighPass1(fc) {
    this.fc = validateNumber(fc, 'fc', 1, this.sampleRate * 0.4999);
    this.Q = 0.5;
    this.gain = 0;
    this.filterType = FILTER_TYPES.HIGH_PASS_1;
    this.calcBiquad();
  }

  /**
   * Configure un notch (type REW « Notch », Q forcé à 30)
   * @param {number} fc - Fréquence centrale (Hz)
   */
  setNotch(fc) {
    this.fc = validateNumber(fc, 'fc', 1, this.sampleRate * 0.4999);
    this.Q = 30;
    this.gain = 0;
    this.filterType = FILTER_TYPES.NOTCH;
    this.calcBiquad();
  }

  /**
   * Configure un low shelf REW (« LS », « LS 6dB », « LS 12dB »)
   * @param {number} fc - Fréquence de coude (Hz)
   * @param {number} gain - Gain du plateau (dB)
   * @param {string} [variant='plain'] - 'plain' | '6dB' | '12dB'
   */
  setLowShelf(fc, gain, variant = 'plain') {
    this.fc = validateNumber(fc, 'fc', 1, this.sampleRate * 0.4999);
    this.gain = validateNumber(gain, 'gain', -60, 60);
    this.shelfVariant = validateShelfVariant(variant);
    this.filterType = FILTER_TYPES.LOW_SHELF;
    this.calcBiquad();
  }

  /**
   * Configure un high shelf REW (« HS », « HS 6dB », « HS 12dB »)
   * @param {number} fc - Fréquence de coude (Hz)
   * @param {number} gain - Gain du plateau (dB)
   * @param {string} [variant='plain'] - 'plain' | '6dB' | '12dB'
   */
  setHighShelf(fc, gain, variant = 'plain') {
    this.fc = validateNumber(fc, 'fc', 1, this.sampleRate * 0.4999);
    this.gain = validateNumber(gain, 'gain', -60, 60);
    this.shelfVariant = validateShelfVariant(variant);
    this.filterType = FILTER_TYPES.HIGH_SHELF;
    this.calcBiquad();
  }

  /**
   * Configure un filtre Modal REW (PK dont le Q dérive du T60 visé)
   * @param {number} fc - Fréquence centrale (Hz)
   * @param {number} gain - Gain (dB)
   * @param {number} t60Target - Valeur T60 brute du bank REW (> 0)
   */
  setModal(fc, gain, t60Target) {
    this.fc = validateNumber(fc, 'fc', 1, this.sampleRate * 0.4999);
    this.gain = validateNumber(gain, 'gain', -60, 60);
    this.t60Target = validateNumber(t60Target, 't60Target', 1e-6, Infinity);
    this.filterType = FILTER_TYPES.MODAL;
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

      if (this.filterType === FILTER_TYPES.PEAKING) {
        Object.assign(
          this,
          computePeakingCoefficients({
            fc: this.fc,
            Q: this.Q,
            gain: this.gain,
            sampleRate: this.sampleRate,
          }),
        );
      } else {
        // Pour les autres types, pas de coefficients p1..p5 (sauf MODAL qui
        // délègue au PK) : la phase se dérive de la réponse complexe
        // (voir getPhase).
        this.resetToUnity();
        Object.assign(this, this.computeTypedCoefficients());
      }

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
   * Calcule les coefficients des types non-PK (dispatch par filterType)
   * @returns {{ a0,a1,a2, b0,b1,b2 }}
   */
  computeTypedCoefficients() {
    const { fc, Q, gain, sampleRate } = this;
    switch (this.filterType) {
      case FILTER_TYPES.ALL_PASS:
        return computeAllPassCoefficients({ fc, Q, sampleRate });
      case FILTER_TYPES.LOW_PASS:
        return computeLowPassCoefficients({ fc, sampleRate });
      case FILTER_TYPES.HIGH_PASS:
        return computeHighPassCoefficients({ fc, sampleRate });
      case FILTER_TYPES.LOW_PASS_1:
        return computeLowPass1Coefficients({ fc, sampleRate });
      case FILTER_TYPES.HIGH_PASS_1:
        return computeHighPass1Coefficients({ fc, sampleRate });
      case FILTER_TYPES.NOTCH:
        return computeNotchCoefficients({ fc, sampleRate });
      case FILTER_TYPES.LOW_SHELF:
        return computeShelfCoefficients({
          fc,
          gain,
          sampleRate,
          high: false,
          variant: this.shelfVariant ?? 'plain',
        });
      case FILTER_TYPES.HIGH_SHELF:
        return computeShelfCoefficients({
          fc,
          gain,
          sampleRate,
          high: true,
          variant: this.shelfVariant ?? 'plain',
        });
      case FILTER_TYPES.MODAL:
        return computeModalCoefficients({
          fc,
          gain,
          t60Target: this.t60Target,
          sampleRate,
        });
      default:
        throw new TypeError(`Unsupported filter type: ${this.filterType}`);
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

    // Seuls PEAKING et MODAL (qui délègue au PK) produisent les coefficients
    // rapides p1..p5 ; les autres types passent par la réponse complexe.
    if (
      this.filterType === FILTER_TYPES.PEAKING ||
      this.filterType === FILTER_TYPES.MODAL
    ) {
      return getPhaseFromCoefficients(this, freq, this.sampleRate);
    }

    const { re, im } = getComplexResponseFromCoefficients(this, freq, this.sampleRate);
    return Math.atan2(im, re) * (180 / Math.PI);
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
    // Les types dont l'effet est proportionnel au gain sont neutres à gain nul ;
    // les passe-bas/haut, notch et all-pass agissent quel que soit le gain.
    if (
      this.filterType === FILTER_TYPES.PEAKING ||
      this.filterType === FILTER_TYPES.MODAL ||
      this.filterType === FILTER_TYPES.LOW_SHELF ||
      this.filterType === FILTER_TYPES.HIGH_SHELF
    ) {
      return Math.abs(this.gain) < 0.01;
    }
    return false;
  }

  /**
   * Sérialise en JSON
   * @returns {Object}
   */
  toJSON() {
    const json = {
      type: this.filterType,
      enabled: this.enabled,
      fc: this.fc,
      Q: this.Q,
      gain: this.gain,
      sampleRate: this.sampleRate,
    };
    if (
      this.filterType === FILTER_TYPES.LOW_SHELF ||
      this.filterType === FILTER_TYPES.HIGH_SHELF
    ) {
      json.shelfVariant = this.shelfVariant;
    }
    if (this.filterType === FILTER_TYPES.MODAL) {
      json.t60Target = this.t60Target;
    }
    return json;
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
      this.fc = validateNumber(json.fc ?? 100, 'fc', 1, 192000);
      this.Q = validateNumber(json.Q ?? 10, 'Q', 0.1, 100);
      this.gain = validateNumber(json.gain ?? 0, 'gain', -60, 60);
      this.shelfVariant = validateShelfVariant(json.shelfVariant ?? 'plain');
      if (type === FILTER_TYPES.MODAL) {
        this.t60Target = validateNumber(json.t60Target, 't60Target', 1e-6, Infinity);
      }
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
