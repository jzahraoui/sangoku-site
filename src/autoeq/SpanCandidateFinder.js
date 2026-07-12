/**
 * SpanCandidateFinder.js
 *
 * Scans a residual array (measured − target after current filters) and
 * returns a ranked list of frequency spans that are good candidates for
 * placing a new EQ filter.
 *
 * A "span" is a contiguous region where the residual has the same sign and
 * passes significance and conflict-avoidance checks.
 *
 * All hot-path loops use plain `for` and `Float64Array` to keep performance
 * identical to the original monolithic implementation.
 */

export class SpanCandidateFinder {
  /**
   * @param {import('./AutoEQConfig.js').AutoEQConfig} config
   */
  constructor(config) {
    this.allowBoosts = config.allowBoosts;
    this.individualMaxBoostDb = config.individualMaxBoostDb;
    this.flatnessTarget = config.flatnessTarget;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns up to `maxCandidates` candidate spans, sorted by descending
   * priority (|sumDelta|).
   *
   * @param {ArrayLike<number>} scanFreqs
   * @param {Float64Array}      residuals    - signed (>0 = above target, <0 = below)
   * @param {Array}             filters      - already-placed filters
   * @param {number}            maxCandidates
   * @returns {Array<{ spanStart, spanEnd, peakFreq, peakVal, sumDelta, priority }>}
   */
  findCandidateSpans(scanFreqs, residuals, filters, maxCandidates) {
    const numPoints = scanFreqs.length;
    if (numPoints === 0) return [];

    const candidates = [];
    const state = this._createSpanState(scanFreqs[0], residuals[0]);
    const pushCandidate = span => {
      candidates.push({ ...span, priority: Math.abs(span.sumDelta) });
    };

    for (let index = 1; index < numPoints; index++) {
      const residual = residuals[index];
      const freq = scanFreqs[index];
      const previousResidual = residuals[index - 1];

      this._updateSpanState(state, freq, residual);

      if (residual * previousResidual <= 0) {
        this._collectSpanCandidate(state, freq, filters, pushCandidate);
        this._restartSpanState(state, freq, residual);
      }
    }

    this._collectSpanCandidate(state, scanFreqs[numPoints - 1], filters, pushCandidate);

    if (candidates.length === 0) {
      const fallback = this._buildFallbackSpan(scanFreqs, residuals, filters);
      if (fallback) {
        candidates.push({ ...fallback, priority: Math.abs(fallback.sumDelta) });
      }
    }

    candidates.sort((a, b) => b.priority - a.priority);
    return candidates.slice(0, maxCandidates);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * A span is valid when it passes significance and conflict checks.
   * peakVal > 0 means the measured response is above the target (needs a cut).
   * peakVal < 0 means below target (needs a boost).
   */
  _isValidSpanCandidate(spanStart, spanEnd, peakFreq, peakVal, sumDelta, filters) {
    if (!this.allowBoosts && peakVal < 0) return false;
    if (peakVal < -this.individualMaxBoostDb) return false;
    if (!this._isSpanSignificant(spanStart, spanEnd, peakVal, sumDelta)) return false;
    return !this._hasConflictingFilter(filters, spanStart, spanEnd, peakFreq, peakVal);
  }

  _isSpanSignificant(spanStart, spanEnd, peakVal, sumDelta) {
    const absPeak = Math.abs(peakVal);
    const absSumDelta = Math.abs(sumDelta);
    const ratio = spanEnd / spanStart;
    const flatness = this.flatnessTarget;
    const cond1 = peakVal > 2 * flatness && absSumDelta > 10;
    const cond2 = absPeak > flatness && ratio > 1.08 && absSumDelta > 10;
    return cond1 || cond2;
  }

  _hasConflictingFilter(filters, spanStart, spanEnd, peakFreq, peakVal) {
    for (const filt of filters) {
      if (filt.fc < spanStart || filt.fc > spanEnd) {
        continue;
      }
      if (filt.gain * peakVal < 0) return true;
      if (Math.abs(filt.gain) < this.flatnessTarget) return true;
      if (Math.abs(filt.fc - peakFreq) < 1) return true;
    }
    return false;
  }

  _createSpanState(startFreq, startResidual) {
    return {
      // REW never starts the scan inside a below-target (boost) span: tracking
      // only begins on a positive residual or after a zero crossing
      // (C0417G.run with UA.m3730() = false).
      inSpan: startResidual > 0,
      spanStart: startFreq,
      peakVal: startResidual,
      peakFreq: startFreq,
      sumDelta: startResidual,
    };
  }

  _updateSpanState(state, freq, residual) {
    if (!state.inSpan) {
      return;
    }
    state.sumDelta += residual;
    if (Math.abs(residual) > Math.abs(state.peakVal)) {
      state.peakVal = residual;
      state.peakFreq = freq;
    }
  }

  _restartSpanState(state, freq, residual) {
    state.inSpan = true;
    state.spanStart = freq;
    state.peakVal = residual;
    state.peakFreq = freq;
    state.sumDelta = residual;
  }

  _collectSpanCandidate(state, spanEnd, filters, pushCandidate) {
    if (!state.inSpan) {
      return;
    }
    if (
      this._isValidSpanCandidate(
        state.spanStart,
        spanEnd,
        state.peakFreq,
        state.peakVal,
        state.sumDelta,
        filters,
      )
    ) {
      pushCandidate({
        spanStart: state.spanStart,
        spanEnd,
        peakFreq: state.peakFreq,
        peakVal: state.peakVal,
        sumDelta: state.sumDelta,
      });
    }
  }

  _buildFallbackSpan(scanFreqs, residuals, filters) {
    let maxR = 0;
    let maxI = -1;
    for (let i = 0; i < scanFreqs.length; i++) {
      if (residuals[i] > this.flatnessTarget && residuals[i] > maxR) {
        maxR = residuals[i];
        maxI = i;
      }
    }
    if (maxI < 0) {
      return null;
    }
    let lo = maxI;
    let hi = maxI;
    while (lo > 0 && residuals[lo - 1] > maxR / 3) lo--;
    while (hi < scanFreqs.length - 1 && residuals[hi + 1] > maxR / 3) hi++;
    let sumDelta = 0;
    for (let i = lo; i <= hi; i++) {
      sumDelta += residuals[i];
    }
    const fallback = {
      spanStart: scanFreqs[lo],
      spanEnd: scanFreqs[hi],
      peakFreq: scanFreqs[maxI],
      peakVal: maxR,
      sumDelta,
    };
    return this._isValidSpanCandidate(
      fallback.spanStart,
      fallback.spanEnd,
      fallback.peakFreq,
      fallback.peakVal,
      fallback.sumDelta,
      filters,
    )
      ? fallback
      : null;
  }
}
