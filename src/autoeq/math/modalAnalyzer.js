/**
 * modalAnalyzer.js
 *
 * Parametric modal detection on a band-limited residual using an all-pole
 * (LPC) spectral envelope, plus Q seeding from the measured peak width.
 *
 * The all-pole envelope is fitted on the residual power spectrum projected
 * onto a uniform low-rate grid (Wiener-Khinchin autocorrelation +
 * Levinson-Durbin). Its poles lock onto spectral peaks, which makes the
 * detection robust to fused modes that a plain local-maximum scan on a
 * smoothed curve merges into one. The envelope is evaluated analytically at
 * any frequency, so no polynomial root-finding is needed.
 *
 * Pure math — no DOM, no framework, no external dependencies.
 */

import { binarySearchLowerBound } from './filterMath.js';

const GUARD_RATIO = 1.25; // head-room between the band top and the model Nyquist
const UNIFORM_BINS = 256; // uniform spectrum bins used to build the autocorrelation
const MIN_BAND_POINTS = 8;
const REFINE_ITERATIONS = 24;
const MIN_SEED_GAIN_DB = 0.5;
const WIDTH_LEVEL_DIVISOR = Math.sqrt(2.5); // bandwidth measured at G/sqrt(2.5), not G-3 dB
const SEED_Q_MIN = 0.5;
const SEED_Q_MAX = 20; // matches the PK_MAX_Q engine guard

/**
 * Linear interpolation of a sampled curve, with constant extension outside
 * the sampled range.
 *
 * @param {ArrayLike<number>} freqs - Sorted ascending frequencies
 * @param {ArrayLike<number>} values
 * @param {number} f
 * @returns {number}
 */
function interpolateAt(freqs, values, f) {
  const n = freqs.length;
  if (f <= freqs[0]) return values[0];
  if (f >= freqs[n - 1]) return values[n - 1];
  const hi = binarySearchLowerBound(freqs, f);
  const lo = hi - 1;
  const span = freqs[hi] - freqs[lo];
  const t = span > 0 ? (f - freqs[lo]) / span : 0;
  return values[lo] + t * (values[hi] - values[lo]);
}

/**
 * Autocorrelation lags of the signal whose one-sided power spectrum is
 * sampled uniformly on [0, nyquist] (Wiener-Khinchin, direct cosine sum).
 *
 * @param {Float64Array} power - UNIFORM_BINS + 1 samples, DC to Nyquist
 * @param {number} maxLag
 * @returns {Float64Array} lags 0..maxLag
 */
function autocorrelationFromPower(power, maxLag) {
  const n = power.length - 1;
  const r = new Float64Array(maxLag + 1);
  for (let k = 0; k <= maxLag; k++) {
    let acc = power[0] + (k % 2 === 0 ? power[n] : -power[n]);
    for (let m = 1; m < n; m++) {
      acc += 2 * power[m] * Math.cos((Math.PI * m * k) / n);
    }
    r[k] = acc / (2 * n);
  }
  return r;
}

/**
 * Levinson-Durbin recursion. Returns the prediction-error polynomial
 * A(z) = 1 + a1·z⁻¹ + … (coefficients [1, a1, …]). If the recursion loses
 * stability (|reflection| ≥ 1) it stops early and returns the last stable
 * model, which keeps the envelope minimum-phase by construction.
 *
 * @param {Float64Array} r - Autocorrelation lags 0..order
 * @param {number} order
 * @returns {Float64Array|null} null when r[0] carries no energy
 */
function levinsonDurbin(r, order) {
  if (!Number.isFinite(r[0]) || r[0] <= 0) return null;
  let a = new Float64Array([1]);
  let error = r[0];
  for (let m = 1; m <= order; m++) {
    let acc = r[m];
    for (let i = 1; i < m; i++) acc += a[i] * r[m - i];
    const k = -acc / error;
    if (!Number.isFinite(k) || Math.abs(k) >= 1) return a;
    const next = new Float64Array(m + 1);
    next[0] = 1;
    for (let i = 1; i < m; i++) next[i] = a[i] + k * a[m - i];
    next[m] = k;
    a = next;
    error *= 1 - k * k;
    if (!Number.isFinite(error) || error <= 0) return a;
  }
  return a;
}

/**
 * All-pole envelope level (dB, relative — constant model gain omitted) at
 * frequency f for a model built against the given Nyquist.
 *
 * @param {Float64Array} a - Prediction-error polynomial
 * @param {number} f
 * @param {number} nyquist
 * @returns {number}
 */
function envelopeDbAt(a, f, nyquist) {
  const omega = (Math.PI * f) / nyquist;
  let re = 0;
  let im = 0;
  for (let i = 0; i < a.length; i++) {
    re += a[i] * Math.cos(omega * i);
    im -= a[i] * Math.sin(omega * i);
  }
  return -10 * Math.log10(Math.max(re * re + im * im, Number.MIN_VALUE));
}

/**
 * Golden-section refinement of a local maximum of the envelope inside
 * [lo, hi] (frequencies in Hz).
 */
function refinePeak(a, nyquist, lo, hi) {
  const phi = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - phi * (hi - lo);
  let x2 = lo + phi * (hi - lo);
  let f1 = envelopeDbAt(a, x1, nyquist);
  let f2 = envelopeDbAt(a, x2, nyquist);
  for (let i = 0; i < REFINE_ITERATIONS; i++) {
    if (f1 < f2) {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + phi * (hi - lo);
      f2 = envelopeDbAt(a, x2, nyquist);
    } else {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - phi * (hi - lo);
      f1 = envelopeDbAt(a, x1, nyquist);
    }
  }
  return (lo + hi) / 2;
}

/**
 * Peak prominence on the evaluation grid: height above the higher of the
 * two bounding valleys.
 */
function prominenceAt(env, peakIdx) {
  let leftMin = env[peakIdx];
  for (let i = peakIdx - 1; i >= 0 && env[i] <= env[i + 1]; i--) {
    leftMin = env[i];
  }
  let rightMin = env[peakIdx];
  for (let i = peakIdx + 1; i < env.length && env[i] <= env[i - 1]; i++) {
    rightMin = env[i];
  }
  return env[peakIdx] - Math.max(leftMin, rightMin);
}

/**
 * Detects modal peak frequencies of a residual curve inside a band, using
 * an all-pole spectral envelope.
 *
 * @param {Object} options
 * @param {ArrayLike<number>} options.freqs - Sorted ascending scan frequencies (Hz)
 * @param {ArrayLike<number>} options.residuals - Residual (dB above target) per scan point
 * @param {number} options.minFreq - Band low edge (Hz)
 * @param {number} options.maxFreq - Band high edge (Hz)
 * @param {number} [options.lpcOrder=64] - All-pole model order
 * @param {number} [options.prominenceDb=1] - Minimum peak prominence (dB) to report
 * @param {number} [options.evalPpo=96] - Envelope evaluation density (points per octave)
 * @returns {Array<{fc:number, prominenceDb:number}>} Modes sorted by ascending fc
 */
export function detectModalFrequencies({
  freqs,
  residuals,
  minFreq,
  maxFreq,
  lpcOrder = 64,
  prominenceDb = 1,
  evalPpo = 96,
}) {
  if (!Number.isFinite(minFreq) || minFreq <= 0) return [];
  if (!Number.isFinite(maxFreq) || maxFreq <= minFreq) return [];
  const loIdx = binarySearchLowerBound(freqs, minFreq);
  const hiIdx = binarySearchLowerBound(freqs, maxFreq);
  if (hiIdx - loIdx < MIN_BAND_POINTS) return [];

  // Project the band onto a uniform grid; constant extension outside the
  // band keeps the model edges free of artificial discontinuities.
  const nyquist = maxFreq * GUARD_RATIO;
  const db = new Float64Array(UNIFORM_BINS + 1);
  let mean = 0;
  for (let n = 0; n <= UNIFORM_BINS; n++) {
    const f = (n * nyquist) / UNIFORM_BINS;
    db[n] = interpolateAt(
      freqs,
      residuals,
      Math.min(Math.max(f, minFreq), maxFreq),
    );
    mean += db[n];
  }
  mean /= UNIFORM_BINS + 1;
  const power = new Float64Array(UNIFORM_BINS + 1);
  for (let n = 0; n <= UNIFORM_BINS; n++) {
    power[n] = Math.pow(10, (db[n] - mean) / 10);
  }

  const order = Math.min(lpcOrder, UNIFORM_BINS - 1);
  const r = autocorrelationFromPower(power, order);
  const a = levinsonDurbin(r, order);
  if (!a || a.length < 3) return [];

  // Dense log-spaced evaluation of the envelope, then local maxima.
  const octaves = Math.log2(maxFreq / minFreq);
  const count = Math.max(Math.ceil(octaves * evalPpo), MIN_BAND_POINTS) + 1;
  const evalFreqs = new Float64Array(count);
  const env = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    evalFreqs[i] = minFreq * Math.pow(2, (octaves * i) / (count - 1));
    env[i] = envelopeDbAt(a, evalFreqs[i], nyquist);
  }

  const modes = [];
  for (let i = 1; i < count - 1; i++) {
    if (env[i] <= env[i - 1] || env[i] < env[i + 1]) continue;
    const prominence = prominenceAt(env, i);
    if (prominence < prominenceDb) continue;
    const fc = refinePeak(a, nyquist, evalFreqs[i - 1], evalFreqs[i + 1]);
    modes.push({ fc, prominenceDb: prominence });
  }
  return modes;
}

/**
 * Walks the residual away from a peak looking for the width-level crossing,
 * stopping at the first valley (curve rising again) or the band edge.
 *
 * @returns {{crossFreq:number|null, valleyFreq:number}}
 */
function traceHalfWidth(freqs, residuals, peakIdx, level, dir, loIdx, hiIdx) {
  let prev = residuals[peakIdx];
  for (let i = peakIdx + dir; i >= loIdx && i <= hiIdx; i += dir) {
    const value = residuals[i];
    if (value <= level) {
      const fA = freqs[i - dir];
      const fB = freqs[i];
      const t = prev - value > 0 ? (prev - level) / (prev - value) : 0;
      return { crossFreq: fA + t * (fB - fA), valleyFreq: fB };
    }
    if (value > prev) {
      return { crossFreq: null, valleyFreq: freqs[i - dir] };
    }
    prev = value;
  }
  return { crossFreq: null, valleyFreq: freqs[dir > 0 ? hiIdx : loIdx] };
}

/**
 * Seeds the Q of a peaking correction from the measured width of the
 * residual peak at level G/√2.5 (G = residual height at fc). Falls back on
 * mirrored half-widths for one-sided peaks, and on the valley-to-valley
 * distance for peaks buried less than the width level above their valleys —
 * a deliberately conservative (low) Q that the optimizer can sharpen.
 *
 * @param {Object} options
 * @param {ArrayLike<number>} options.freqs - Sorted ascending scan frequencies (Hz)
 * @param {ArrayLike<number>} options.residuals - Residual (dB above target) per scan point
 * @param {number} options.fc - Peak frequency (Hz)
 * @param {number} options.minFreq - Band low edge (Hz)
 * @param {number} options.maxFreq - Band high edge (Hz)
 * @returns {number|null} Seed Q, or null when the peak is unusable
 */
export function seedQFromPeakWidth({ freqs, residuals, fc, minFreq, maxFreq }) {
  const loIdx = binarySearchLowerBound(freqs, minFreq);
  const hiIdx = Math.min(
    binarySearchLowerBound(freqs, maxFreq),
    freqs.length - 1,
  );
  if (hiIdx - loIdx < 2 || fc < freqs[loIdx] || fc > freqs[hiIdx]) return null;

  const gain = interpolateAt(freqs, residuals, fc);
  if (!Number.isFinite(gain) || gain < MIN_SEED_GAIN_DB) return null;
  const level = gain / WIDTH_LEVEL_DIVISOR;

  let peakIdx = binarySearchLowerBound(freqs, fc);
  peakIdx = Math.min(Math.max(peakIdx, loIdx), hiIdx);
  const left = traceHalfWidth(freqs, residuals, peakIdx, level, -1, loIdx, hiIdx);
  const right = traceHalfWidth(freqs, residuals, peakIdx, level, 1, loIdx, hiIdx);

  let bandwidth;
  if (left.crossFreq !== null && right.crossFreq !== null) {
    bandwidth = right.crossFreq - left.crossFreq;
  } else if (left.crossFreq !== null) {
    bandwidth = 2 * (fc - left.crossFreq);
  } else if (right.crossFreq !== null) {
    bandwidth = 2 * (right.crossFreq - fc);
  } else {
    bandwidth = right.valleyFreq - left.valleyFreq;
  }
  if (!Number.isFinite(bandwidth) || bandwidth <= 0) return null;

  return Math.min(Math.max(fc / bandwidth, SEED_Q_MIN), SEED_Q_MAX);
}
