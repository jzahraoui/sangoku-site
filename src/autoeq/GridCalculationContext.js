/**
 * GridCalculationContext.js
 *
 * Prepares the frequency grid used throughout the AutoEQ pipeline from raw
 * measured and target frequency responses.
 *
 * Responsibilities:
 *   - Slice the measured response to the requested [matchRangeStart, matchRangeEnd]
 *   - Resample the target onto the measured grid (nearest frequency) — REW can
 *     return measured and target responses with different startFreq values
 *   - Build fast nearest-neighbour accessor functions
 *   - Estimate the points-per-octave density of the grid
 *   - Sanity-check the resulting context before computation starts
 *
 * The resulting instance is a plain data object — no further computation is
 * deferred.  All fields are public and read-only after construction.
 */

import { binarySearchLowerBound } from './math/filterMath.js';

export class GridCalculationContext {
  /**
   * Factory method: validates inputs, slices to range, builds accessors.
   *
   * @param {{ freqs: ArrayLike<number>, magnitude: ArrayLike<number> }} measuredSPL
   * @param {{ freqs: ArrayLike<number>, magnitude: ArrayLike<number> }} targetCurve
   * @param {{ matchRangeStart: number, matchRangeEnd: number }} config
   * @returns {GridCalculationContext}
   */
  static fromResponses(measuredSPL, targetCurve, config) {
    const measured = GridCalculationContext._normalizeResponse(
      measuredSPL,
      'measuredSPL',
    );
    const target = GridCalculationContext._normalizeResponse(targetCurve, 'targetCurve');

    const { freqs, measuredMagnitude, targetMagnitude } =
      GridCalculationContext._sliceToRange(measured, target, config);

    const ctx = new GridCalculationContext();
    ctx.mode = 'grid';
    ctx.scanFreqs = freqs;
    ctx.measuredArr = measuredMagnitude;
    ctx.targetArr = targetMagnitude;
    ctx.pointsPerOctave = GridCalculationContext._estimatePointsPerOctave(freqs);
    ctx.measuredFn = GridCalculationContext._buildNearestAccessor(
      freqs,
      measuredMagnitude,
    );
    ctx.targetFn = GridCalculationContext._buildNearestAccessor(freqs, targetMagnitude);
    return ctx;
  }

  /**
   * Verifies that the accessor functions return finite values at 1 kHz.
   * Throws a TypeError if either returns a non-finite result.
   */
  validate() {
    const testFreq = 1000;
    const m = this.measuredFn(testFreq);
    const t = this.targetFn(testFreq);
    if (!Number.isFinite(m)) {
      throw new TypeError(`measuredSPL(${testFreq}) returned non-finite: ${m}`);
    }
    if (!Number.isFinite(t)) {
      throw new TypeError(`targetCurve(${testFreq}) returned non-finite: ${t}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private static helpers
  // ─────────────────────────────────────────────────────────────────────────

  static _normalizeResponse(input, name) {
    if (!input || typeof input !== 'object') {
      throw new TypeError(`${name} must be a frequency response object`);
    }
    const { freqs, magnitude } = input;
    if (
      !GridCalculationContext._isArrayLikeNumeric(freqs) ||
      !GridCalculationContext._isArrayLikeNumeric(magnitude)
    ) {
      throw new TypeError(`${name} must provide numeric freqs and magnitude arrays`);
    }
    if (freqs.length !== magnitude.length || freqs.length === 0) {
      throw new RangeError(
        `${name} freqs and magnitude must have the same non-zero length`,
      );
    }
    return { freqs, magnitude };
  }

  static _sliceToRange(measured, target, config) {
    const { matchRangeStart, matchRangeEnd } = config;
    const startIndex = binarySearchLowerBound(measured.freqs, matchRangeStart);
    const rawEndIndex = binarySearchLowerBound(measured.freqs, matchRangeEnd);
    const endIndex = Math.min(rawEndIndex, measured.freqs.length - 1);

    if (startIndex > endIndex) {
      throw new RangeError('No raw response points available in the requested range');
    }

    const freqs = measured.freqs.slice(startIndex, endIndex + 1);
    // The target grid may not match the measured grid (different startFreq from
    // REW): resample it by nearest frequency instead of reusing measured indexes.
    const targetMagnitude = new Float64Array(freqs.length);
    for (let i = 0; i < freqs.length; i++) {
      targetMagnitude[i] =
        target.magnitude[GridCalculationContext._findNearestIndex(target.freqs, freqs[i])];
    }

    return {
      freqs,
      measuredMagnitude: measured.magnitude.slice(startIndex, endIndex + 1),
      targetMagnitude,
    };
  }

  static _isArrayLikeNumeric(value) {
    return Array.isArray(value) || ArrayBuffer.isView(value);
  }

  static _buildNearestAccessor(freqs, magnitude) {
    return freq => magnitude[GridCalculationContext._findNearestIndex(freqs, freq)];
  }

  static _findNearestIndex(freqs, freq) {
    if (!Number.isFinite(freq)) {
      throw new TypeError(`Invalid lookup frequency: ${freq}`);
    }
    const upper = binarySearchLowerBound(freqs, freq);
    if (upper <= 0) {
      return 0;
    }
    if (upper >= freqs.length) {
      return freqs.length - 1;
    }
    const lower = upper - 1;
    return Math.abs(freqs[upper] - freq) < Math.abs(freq - freqs[lower]) ? upper : lower;
  }

  static _estimatePointsPerOctave(freqs) {
    if (!freqs || freqs.length < 2 || freqs[0] <= 0 || freqs[1] <= 0) {
      return 96;
    }
    const ratio = freqs[1] / freqs[0];
    if (!Number.isFinite(ratio) || ratio <= 1) {
      return 96;
    }
    return Math.max(1, Math.round(Math.log(2) / Math.log(ratio)));
  }
}
