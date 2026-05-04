/**
 * SpanAnalyzer.js
 * Analyse fréquentielle: grille 1/96 PPO + exclusion notches
 *
 * - MeasData.initFullSpanFreqsAndDeltas: grille 1/96 PPO
 * - MeasData.calcSpansExclNotches: spans inclus = complément notches + spans filtres
 */

import {
  createPeakingProfiles,
  sumProfilesDbAtFrequency,
} from '../dsp/peakingProfiles.js';

const PPO96_STEP = Math.pow(2, 1 / 96) - 1; // ≈ 0.007246
const PPO96_MULT = Math.pow(2, 1 / 96); // ≈ 1.007246

/**
 * Analyse fréquentielle d'une courbe mesurée
 *
 * Usage:
 *   const sa = new SpanAnalyzer(20, 20000, 1, 48000, 6);
 *   sa.initFromGrid(freqs, measuredMagnitude, targetMagnitude);
 *   const spans = sa.calcSpansExclNotches(filters);
 */
export class SpanAnalyzer {
  /**
   * @param {number} startFreq - Fréquence de début (Hz)
   * @param {number} endFreq - Fréquence de fin (Hz)
   * @param {number} notchThresholdDB - Seuil de suivi d'une zone négative (positif)
   * @param {number} sampleRate - Fréquence d'échantillonnage (Hz)
   * @param {number} minNotchDepthDB - Profondeur minimale pour exclure un notch (positif)
   */
  constructor(
    startFreq,
    endFreq,
    notchThresholdDB = 6,
    sampleRate = 48000,
    minNotchDepthDB = 6,
  ) {
    this.startFreq = startFreq;
    this.endFreq = endFreq;
    this.notchThresholdDB = notchThresholdDB;
    this.sampleRate = sampleRate;
    this.minNotchDepthDB = minNotchDepthDB;

    // Grille 1/96 PPO (remplie par init)
    this.freqs = null; // Float32Array des fréquences
    this.splDeltas = null; // Float32Array: measured - target (résiduel initial)
    this.numPoints = 0;
  }

  /**
   * Initialise directement depuis une grille fréquentielle brute.
   * @param {ArrayLike<number>} freqs
   * @param {ArrayLike<number>} measuredMagnitude
   * @param {ArrayLike<number>} targetMagnitude
   */
  initFromGrid(freqs, measuredMagnitude, targetMagnitude) {
    if (
      !freqs ||
      !measuredMagnitude ||
      !targetMagnitude ||
      freqs.length !== measuredMagnitude.length ||
      freqs.length !== targetMagnitude.length ||
      freqs.length === 0
    ) {
      throw new RangeError('Invalid grid data for SpanAnalyzer');
    }

    this.freqs = Float32Array.from(freqs);
    this.splDeltas = new Float32Array(freqs.length);
    this.numPoints = freqs.length;

    for (let i = 0; i < this.numPoints; i++) {
      this.splDeltas[i] = measuredMagnitude[i] - targetMagnitude[i];
    }
  }

  /**
   * Calcule les spans à inclure dans le MSE
   *
   * Algorithme:
   * 1. Détecter les zones notch (zone suivie par notchThresholdDB, exclusion par minNotchDepthDB)
   * 2. Construire les spans INCLUS = complément des notches (intersection avec [start, end])
   * 3. Ajouter les spans de filtres existants à la liste des inclus
   *
   * @param {Array<{fc: number, Q: number, gain: number}>} filters - Filtres existants
   * @returns {Array<{start: number, end: number}>} Spans à inclure dans le MSE
   */
  calcSpansExclNotches(filters = []) {
    const notches = this._detectNotches(filters);

    // Construire les spans inclus = complément des notches
    const includedSpans = this._complementSpans(notches, this.startFreq, this.endFreq);

    for (const span of this._collectFilterSpans(filters, false, true)) {
      includedSpans.push(span);
    }

    return includedSpans;
  }

  /**
   * Retourne le résiduel à une fréquence donnée (interpolation linéaire)
   * @param {number} freq
   * @returns {number}
   */
  getResidual(freq) {
    if (!this.freqs || this.numPoints === 0) return 0;
    if (freq <= this.freqs[0]) return this.splDeltas[0];
    if (freq >= this.freqs[this.numPoints - 1]) return this.splDeltas[this.numPoints - 1];

    // Recherche binaire
    let lo = 0,
      hi = this.numPoints - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.freqs[mid] < freq) lo = mid;
      else hi = mid;
    }
    const t = (freq - this.freqs[lo]) / (this.freqs[hi] - this.freqs[lo]);
    return this.splDeltas[lo] + t * (this.splDeltas[hi] - this.splDeltas[lo]);
  }

  // ==================== PRIVATE ====================

  /**
   * Détecte les zones notch (creux profonds à exclure)
   * @returns {Array<{start: number, end: number}>}
   */
  _detectNotches(filters) {
    const threshold = -this.notchThresholdDB;
    const profiles = createPeakingProfiles(filters, this.sampleRate);
    const notches = [];
    let notchStart = this.freqs[0];
    let notchMin = 0;
    let inNotch = this._notchValueAt(0, profiles) < threshold;

    if (inNotch) {
      notchMin = Number.NEGATIVE_INFINITY;
    }

    for (let i = 0; i < this.numPoints; i++) {
      const freq = this.freqs[i];
      const value = this._notchValueAt(i, profiles);

      if (!inNotch && value < 0) {
        inNotch = true;
        notchStart = freq;
        notchMin = value;
        continue;
      }

      if (this._shouldTrackNotchValue(inNotch, value, threshold, notches.length > 0)) {
        if (inNotch && value < notchMin) {
          notchMin = value;
        }
        continue;
      }

      if (inNotch) {
        this._pushNotchIfDeepEnough(notches, notchStart, freq, notchMin);
        inNotch = false;
        notchMin = 0;
      }
    }

    if (inNotch) {
      notches.push({ start: notchStart, end: this.freqs[this.numPoints - 1] });
    }

    return notches;
  }

  _notchValueAt(index, profiles) {
    return (
      this.splDeltas[index] +
      sumProfilesDbAtFrequency(profiles, this.freqs[index], this.sampleRate)
    );
  }

  _shouldTrackNotchValue(inNotch, value, threshold, hasPreviousNotch) {
    if (!(inNotch || value >= 0)) {
      return false;
    }
    return !inNotch || (value < 0 && (hasPreviousNotch || value < threshold));
  }

  _pushNotchIfDeepEnough(notches, start, end, minValue) {
    if (minValue < -this.minNotchDepthDB) {
      notches.push({ start, end });
    }
  }

  /**
   * Calcule le complément de zones (spans inclus = plage entière MOINS les notches)
   * @param {Array<{start, end}>} notches
   * @param {number} rangeStart
   * @param {number} rangeEnd
   * @returns {Array<{start, end}>}
   */
  _complementSpans(notches, rangeStart, rangeEnd) {
    if (notches.length === 0) {
      return [{ start: rangeStart, end: rangeEnd }];
    }

    const included = [];
    let current = rangeStart;

    for (const notch of notches) {
      if (notch.start > current) {
        included.push({ start: current, end: notch.start });
      }
      current = Math.max(current, notch.end);
    }

    if (current < rangeEnd) {
      included.push({ start: current, end: rangeEnd });
    }

    return included;
  }

  /**
   * Calcule le span fréquentiel d'un filtre
   * @param {number} fc
   * @param {number} Q
   * @returns {{freqLow: number, freqHigh: number}}
   */
  _getFilterSpan(fc, Q) {
    const freqHigh = 0.5 * fc * (1 / Q + Math.sqrt(4 + 1 / (Q * Q)));
    const freqLow = (fc * fc) / freqHigh;
    return { freqLow, freqHigh };
  }

  /**
   * Fusionne les spans qui se chevauchent ou sont adjacents
   * @param {Array<{start, end}>} spans
   * @returns {Array<{start, end}>}
   */
  _collectFilterSpans(filters, includeZeroGain = false, includeBoosts = true) {
    const spans = [];
    for (const filter of filters) {
      if (!this._shouldIncludeFilterSpan(filter, includeZeroGain, includeBoosts)) {
        continue;
      }
      const cappedQ = Math.min(filter.Q, 20);
      const span = this._getFilterSpan(filter.fc, cappedQ);
      const candidate = { start: span.freqLow, end: span.freqHigh };
      if (spans.length === 0) {
        spans.push(candidate);
        continue;
      }
      this._insertFilterSpan(spans, candidate);
      this._mergeAdjacentFilterSpans(spans);
    }
    return spans;
  }

  _shouldIncludeFilterSpan(filter, includeZeroGain, includeBoosts) {
    const gain = filter.gain;
    const keep =
      gain < 0 || (includeBoosts && gain > 0) || (!includeZeroGain && gain === 0);
    return keep && Math.abs(gain) >= 0.001;
  }

  _insertFilterSpan(spans, candidate) {
    if (candidate.start > spans.at(-1).start) {
      spans.push(candidate);
      return;
    }
    let inserted = false;
    for (let i = 0; i < spans.length; i++) {
      if (candidate.start <= spans[i].start) {
        spans.splice(i, 0, candidate);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      spans.push(candidate);
    }
  }

  _mergeAdjacentFilterSpans(spans) {
    let index = 0;
    while (index < spans.length - 1) {
      const current = spans[index];
      const next = spans[index + 1];
      if (current.end >= next.end) {
        spans.splice(index + 1, 1);
      } else if (current.end < next.start) {
        index++;
      } else {
        current.end = next.end;
        spans.splice(index + 1, 1);
      }
    }
  }
}

export { PPO96_STEP, PPO96_MULT };
