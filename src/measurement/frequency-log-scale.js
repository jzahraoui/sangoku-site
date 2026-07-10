/**
 * Logarithmic frequency-scale maths for the dual-range frequency slider.
 *
 * [MOTEUR] module — no DOM, no Knockout, no UI framework. Extracted verbatim from the
 * Knockout `FrequencyRangeSlider` widget so any slider UI shares one source of truth
 * for the log10 ↔ frequency ↔ ratio conversions, clamping and snapping.
 *
 * A slider maps a linear position (ratio 0..1 across the track) onto a log10
 * frequency axis between `minLog` and `maxLog` (log10 Hz). Frequencies are
 * clamped to that window, snapped with a progressive step, and ordered so the
 * lower bound never exceeds the upper.
 */

// Default log10 bounds: 10 Hz .. 20 kHz.
const DEFAULT_MIN_LOG = 1;
const DEFAULT_MAX_LOG = Math.log10(20000);
// Fallback precision (decimal places of log10(freq)) when the input `step`
// attribute is missing or integral. 4 decimals keep the round-trip drift below
// ~0.025%, well under the `roundFrequency` snap.
const DEFAULT_LOG_DECIMALS = 4;

/** Parse a number from an attribute/value, falling back when non-finite. */
function readNumber(value, fallback) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Decimal places encoded in a `step` string ("0.0001" → 4); default otherwise. */
function getDecimalPlaces(value) {
  const [, fraction = ''] = String(value).split('.');
  return fraction.length || DEFAULT_LOG_DECIMALS;
}

/**
 * Progressive snap: 1 Hz steps below 1 kHz, 100 Hz up to 10 kHz, then 1 kHz.
 * Standalone (window-independent) so it can be reused directly.
 */
function roundFrequency(frequency) {
  let step = 1;
  if (frequency > 10000) {
    step = 1000;
  } else if (frequency > 1000) {
    step = 100;
  }
  return Math.round(frequency / step) * step;
}

/**
 * Build a log-scale helper bound to a [minLog, maxLog] window. All methods are
 * pure. `decimalPlaces` controls `formatLog` (the range-input value string).
 */
function createFrequencyLogScale({
  minLog = DEFAULT_MIN_LOG,
  maxLog = DEFAULT_MAX_LOG,
  decimalPlaces = DEFAULT_LOG_DECIMALS,
} = {}) {
  const minFrequency = 10 ** minLog;
  const maxFrequency = 10 ** maxLog;
  const range = maxLog - minLog || 1;

  function clampLog(logValue) {
    return Math.min(Math.max(logValue, minLog), maxLog);
  }

  function clampFrequency(frequency) {
    const numeric = Number.isFinite(frequency)
      ? frequency
      : readNumber(frequency, minFrequency);
    return Math.min(Math.max(numeric, minFrequency), maxFrequency);
  }

  function logFromFrequency(frequency) {
    return clampLog(Math.log10(clampFrequency(frequency)));
  }

  /** Snapped frequency for a log10 value (clamped to the window first). */
  function frequencyFromLog(logValue) {
    return roundFrequency(10 ** clampLog(logValue));
  }

  /** log10 value for a linear ratio (0..1) across the track. */
  function logFromRatio(ratio) {
    const clampedRatio = Math.min(Math.max(ratio, 0), 1);
    return minLog + clampedRatio * range;
  }

  /** Snapped frequency for a linear ratio (0..1) across the track. */
  function frequencyFromRatio(ratio) {
    return roundFrequency(10 ** logFromRatio(ratio));
  }

  /** Track percentage (0..100) for a log10 value — feeds the fill gradient. */
  function percentForLog(logValue) {
    return ((clampLog(logValue) - minLog) / range) * 100;
  }

  /** Track percentage (0..100) for a frequency. */
  function percentForFrequency(frequency) {
    return percentForLog(logFromFrequency(frequency));
  }

  /** Range-input value string (fixed decimals of the clamped log10 value). */
  function formatLog(logValue) {
    return clampLog(logValue).toFixed(decimalPlaces);
  }

  /**
   * Clamp + snap + order a bound pair so lower ≤ upper. Returns fresh values;
   * callers decide whether to commit them.
   */
  function normalizeBounds(lower, upper) {
    const lowerFrequency = roundFrequency(clampFrequency(lower));
    const upperFrequency = roundFrequency(clampFrequency(upper));
    return {
      lower: Math.min(lowerFrequency, upperFrequency),
      upper: Math.max(lowerFrequency, upperFrequency),
    };
  }

  return {
    minLog,
    maxLog,
    minFrequency,
    maxFrequency,
    decimalPlaces,
    clampLog,
    clampFrequency,
    logFromFrequency,
    frequencyFromLog,
    logFromRatio,
    frequencyFromRatio,
    percentForLog,
    percentForFrequency,
    formatLog,
    normalizeBounds,
    roundFrequency,
  };
}

export {
  DEFAULT_MIN_LOG,
  DEFAULT_MAX_LOG,
  DEFAULT_LOG_DECIMALS,
  createFrequencyLogScale,
  roundFrequency,
  readNumber,
  getDecimalPlaces,
};
