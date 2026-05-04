/**
 * EqualizerAdapter.js
 *
 * Translates continuous filter parameters (fc, gain, Q) into the discrete
 * values supported by a specific equalizer model (step sizes, clamps, etc.).
 *
 * Responsibilities:
 *   - Quantise frequency, gain and Q to the equalizer's resolution
 *   - Apply per-equalizer bounds
 *   - Detect degenerate "edge boost" filters that have reached the limit
 *
 * All methods mutate filters in-place.  Pass cloned arrays when you need
 * to preserve the originals.
 */

export class EqualizerAdapter {
  /**
   * @param {import('./AutoEQConfig.js').AutoEQConfig} config
   */
  constructor(config) {
    this.equalizerFreqStep = config.equalizerFreqStep;
    this.equalizerGainStep = config.equalizerGainStep;
    this.equalizerQStep = config.equalizerQStep;
    this.equalizerManufacturer = config.equalizerManufacturer;
    this.equalizerModel = config.equalizerModel;
    this.individualMaxBoostDb = config.individualMaxBoostDb;
    this.maxCutDb = config.maxCutDb;
    this.matchRangeStart = config.matchRangeStart;
    this.matchRangeEnd = config.matchRangeEnd;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the gain bounds for the current equalizer.
   * @returns {{ min: number, max: number }}
   */
  getGainBounds() {
    if (this._isGenericEqualizer()) {
      return { min: -120, max: 30 };
    }
    return { min: -this.maxCutDb, max: this.individualMaxBoostDb };
  }

  /**
   * Returns the Q bounds for the current equalizer.
   * @returns {{ min: number, max: number }}
   */
  getQBounds() {
    if (this._isGenericEqualizer()) {
      return { min: 0.01, max: 50 };
    }
    return { min: 0.1, max: 50 };
  }

  /**
   * Returns the quantised centre frequency for `freq`.
   * @param {number} freq
   * @returns {number}
   */
  quantizeFrequency(freq) {
    return this._roundToStep(
      freq,
      this._getFreqStep(freq),
      this.matchRangeStart,
      this.matchRangeEnd,
    );
  }

  /**
   * True when the filter sits at the upper edge of the frequency range and
   * its gain has not reached the per-model boost cap, indicating it is an
   * artifact of the optimiser rather than a useful peak correction.
   *
   * @param {{ fc: number, gain: number }} filter
   * @param {number} maxAllowedFc
   * @returns {boolean}
   */
  isUpperEdgeBoost(filter, maxAllowedFc) {
    if (filter.gain <= 0) {
      return false;
    }
    const freqStep = this._getFreqStep(filter.fc) ?? 1;
    const edgeTolerance = Math.max(1, freqStep * 2);
    if (filter.fc < maxAllowedFc - edgeTolerance) {
      return false;
    }
    const maxGainTolerance = Math.max(this.equalizerGainStep, 0.1);
    return filter.gain < this.individualMaxBoostDb - maxGainTolerance;
  }

  /**
   * Quantises fc, gain and Q of a single filter in-place.
   * @param {{ fc: number, gain: number, Q: number }} filter
   */
  adaptFilter(filter) {
    filter.fc = this.quantizeFrequency(filter.fc);
    filter.gain = this._quantizeGain(filter.gain);
    filter.Q = this._getNearestActualQ(filter.Q);
  }

  /**
   * Quantises all filters in the array in-place.
   * @param {Array<{ fc: number, gain: number, Q: number }>} filters
   */
  adaptFilters(filters) {
    for (const filter of filters) {
      this.adaptFilter(filter);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  _isGenericEqualizer() {
    return this.equalizerManufacturer === 'Generic' && this.equalizerModel === 'Generic';
  }

  _countStepDecimals(step) {
    const normalized = step.toString().toLowerCase();
    if (normalized.includes('e-')) {
      return Number.parseInt(normalized.split('e-')[1], 10);
    }
    const dot = normalized.indexOf('.');
    return dot >= 0 ? normalized.length - dot - 1 : 0;
  }

  _getFreqStep(freq) {
    const freqStep = this.equalizerFreqStep ?? (this._isGenericEqualizer() ? 0.01 : null);
    if (freqStep == null) {
      return null;
    }
    switch (this._countStepDecimals(freqStep)) {
      case 0:
        return 1;
      case 1:
        return freq >= 100 ? 1 : 0.1;
      case 2:
      default:
        if (freq < 50) {
          return 0.05;
        }
        if (freq < 100) {
          return 0.1;
        }
        if (freq < 200) {
          return 0.5;
        }
        return 1;
    }
  }

  _roundToStep(value, step, min, max) {
    if (step == null) {
      return Math.max(min, Math.min(max, value));
    }
    const rounded = Math.round(value / step) * step;
    return Math.max(min, Math.min(max, rounded));
  }

  _quantizeGain(gain) {
    const bounds = this.getGainBounds();
    return this._roundToStep(
      gain,
      this.equalizerGainStep,
      bounds.min,
      Math.min(bounds.max, this.individualMaxBoostDb),
    );
  }

  _getQStep() {
    return this.equalizerQStep ?? null;
  }

  _getNearestActualQ(q) {
    const step = this._getQStep();
    if (step == null) {
      return q;
    }
    const bounds = this.getQBounds();
    return this._roundToStep(q, step, bounds.min, bounds.max);
  }
}
