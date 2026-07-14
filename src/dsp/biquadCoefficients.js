/**
 * biquadCoefficients.js
 *
 * Pure functions to compute biquad filter coefficients.
 * All inputs are validated; errors propagate to the caller.
 */

/**
 * Returns unity-gain (pass-through) biquad coefficients.
 * @returns {{ a0,a1,a2, b0,b1,b2, aC2,aC3,aSum, bC2,bC3,bSum, p1,p2,p3,p4,p5 }}
 */
export function createUnityCoefficients() {
  return {
    a0: 1,
    a1: 0,
    a2: 0,
    b0: 1,
    b1: 0,
    b2: 0,
    aC2: 0,
    aC3: 0,
    aSum: 1,
    bC2: 0,
    bC3: 0,
    bSum: 1,
    p1: 1,
    p2: 0,
    p3: 0,
    p4: 0,
    p5: 0,
  };
}

/**
 * Computes peaking EQ biquad coefficients.
 *
 * @param {Object} params
 * @param {number} params.fc         - Centre frequency (Hz)
 * @param {number} params.Q          - Quality factor (> 0)
 * @param {number} params.gain       - Gain (dB)
 * @param {number} params.sampleRate - Sample rate (Hz)
 * @returns {{ a0,a1,a2, b0,b1,b2, aC2,aC3,aSum, bC2,bC3,bSum, p1,p2,p3,p4,p5 }}
 * @throws {RangeError} If fc >= Nyquist, Q is too low, or coefficients are non-finite.
 */
export function computePeakingCoefficients({ fc, Q, gain, sampleRate }) {
  const omega = ((Math.PI * 2) / sampleRate) * fc;

  if (omega >= Math.PI) {
    throw new RangeError(
      `Frequency ${fc} Hz exceeds Nyquist limit (${sampleRate / 2} Hz)`,
    );
  }

  if (Q < 0.01) {
    throw new RangeError(`Q value ${Q} is too low (min 0.01)`);
  }

  const cs = Math.cos(omega);
  const sn = Math.sin(omega);
  const A = Math.pow(10, gain / 40);
  const alpha = sn / (2 * Q);

  if (!Number.isFinite(alpha) || alpha === 0) {
    throw new RangeError(`Invalid alpha value: ${alpha}`);
  }

  const b0 = 1 + alpha * A;
  const b1 = -2 * cs;
  const b2 = 1 - alpha * A;

  const a0 = 1 + alpha / A;
  const a1 = -2 * cs;
  const a2 = 1 - alpha / A;

  if (Math.abs(a0) < 1e-10) {
    throw new RangeError('Unstable filter coefficients (a0 ≈ 0)');
  }

  const aC2 = -8 * cs;
  const aC3 = 2 * (1 - (alpha * alpha) / A / A);
  const sn2 = Math.sin(omega / 2);
  const aSum = 16 * Math.pow(sn2, 4);

  const bC2 = aC2;
  const bC3 = 2 * (1 - alpha * alpha * A * A);
  const bSum = aSum;

  const p1 = 2 * (alpha * alpha + 2 * cs * cs + 1);
  const p2 = -8 * cs;
  const p3 = -2 * alpha * alpha + 2;
  const p4 = -4 * cs * alpha * (A - 1 / A);
  const p5 = 4 * alpha * (A - 1 / A);

  const coeffs = {
    a0,
    a1,
    a2,
    b0,
    b1,
    b2,
    aC2,
    aC3,
    aSum,
    bC2,
    bC3,
    bSum,
    p1,
    p2,
    p3,
    p4,
    p5,
  };

  for (const [key, val] of Object.entries(coeffs)) {
    if (!Number.isFinite(val)) {
      throw new RangeError(`Non-finite coefficient detected: ${key}=${val}`);
    }
  }

  return coeffs;
}

/**
 * Computes second-order all-pass biquad coefficients (RBJ Audio EQ Cookbook).
 *
 * |H(f)| = 1 at every frequency; the phase rotates by −360° across the band,
 * passing −180° at fc, with a transition sharpness set by Q. Used to realise
 * the sub-optimizer all-pass (REW slot 20/21) in the internal DSP layer.
 *
 * Note: unlike the peaking path, no p1..p5 phase fast-path coefficients are
 * produced — the phase of an all-pass is derived from the complex response.
 *
 * @param {Object} params
 * @param {number} params.fc - Centre frequency in Hz (phase = −180°)
 * @param {number} params.Q - Quality factor (transition sharpness)
 * @param {number} params.sampleRate - Sample rate in Hz
 * @returns {Object} Biquad coefficients { a0..a2, b0..b2 }
 * @throws {RangeError} If fc >= Nyquist, Q is too low, or coefficients are non-finite.
 */
export function computeAllPassCoefficients({ fc, Q, sampleRate }) {
  const omega = ((Math.PI * 2) / sampleRate) * fc;

  if (omega >= Math.PI) {
    throw new RangeError(
      `Frequency ${fc} Hz exceeds Nyquist limit (${sampleRate / 2} Hz)`,
    );
  }

  if (Q < 0.01) {
    throw new RangeError(`Q value ${Q} is too low (min 0.01)`);
  }

  const cs = Math.cos(omega);
  const sn = Math.sin(omega);
  const alpha = sn / (2 * Q);

  if (!Number.isFinite(alpha) || alpha === 0) {
    throw new RangeError(`Invalid alpha value: ${alpha}`);
  }

  const coeffs = {
    a0: 1 + alpha,
    a1: -2 * cs,
    a2: 1 - alpha,
    b0: 1 - alpha,
    b1: -2 * cs,
    b2: 1 + alpha,
  };

  for (const [key, val] of Object.entries(coeffs)) {
    if (!Number.isFinite(val)) {
      throw new RangeError(`Non-finite coefficient detected: ${key}=${val}`);
    }
  }

  return coeffs;
}

const SQRT2_OVER_2 = Math.SQRT2 / 2;

function assertBelowNyquist(fc, sampleRate) {
  if (((Math.PI * 2) / sampleRate) * fc >= Math.PI) {
    throw new RangeError(
      `Frequency ${fc} Hz exceeds Nyquist limit (${sampleRate / 2} Hz)`,
    );
  }
}

function finalize(coeffs) {
  for (const [key, val] of Object.entries(coeffs)) {
    if (!Number.isFinite(val)) {
      throw new RangeError(`Non-finite coefficient detected: ${key}=${val}`);
    }
  }
  return coeffs;
}

/**
 * Passe-bas 12 dB/oct de l'EQ Generic de REW (RBJ, Q forcé à √2/2 —
 * Filter.java case LP : b = [d3/2, d3, d3/2] avec d3 = 1 − cos ω).
 */
export function computeLowPassCoefficients({ fc, sampleRate }) {
  assertBelowNyquist(fc, sampleRate);
  const omega = ((Math.PI * 2) / sampleRate) * fc;
  const cs = Math.cos(omega);
  const sn = Math.sin(omega);
  const alpha = sn / (2 * SQRT2_OVER_2);
  const d3 = 1 - cs;
  return finalize({
    b0: d3 / 2,
    b1: d3,
    b2: d3 / 2,
    a0: 1 + alpha,
    a1: -2 * cs,
    a2: 1 - alpha,
  });
}

/** Passe-haut 12 dB/oct de l'EQ Generic de REW (RBJ, Q forcé à √2/2). */
export function computeHighPassCoefficients({ fc, sampleRate }) {
  assertBelowNyquist(fc, sampleRate);
  const omega = ((Math.PI * 2) / sampleRate) * fc;
  const cs = Math.cos(omega);
  const sn = Math.sin(omega);
  const alpha = sn / (2 * SQRT2_OVER_2);
  const d4 = 1 + cs;
  return finalize({
    b0: d4 / 2,
    b1: -d4,
    b2: d4 / 2,
    a0: 1 + alpha,
    a1: -2 * cs,
    a2: 1 - alpha,
  });
}

/**
 * Passe-bas 6 dB/oct (LP1) de REW — premier ordre bilinéaire
 * H(z) = K(1+z⁻¹) / ((1+K) + (K−1)z⁻¹) avec K = tan(ω/2), réalisé en biquad
 * (b2 = a2 = 0). Validé contre l'IR REW (test/fixtures/oca/filter-types.json).
 */
export function computeLowPass1Coefficients({ fc, sampleRate }) {
  assertBelowNyquist(fc, sampleRate);
  const K = Math.tan((Math.PI / sampleRate) * fc);
  return finalize({
    b0: K,
    b1: K,
    b2: 0,
    a0: 1 + K,
    a1: K - 1,
    a2: 0,
  });
}

/**
 * Passe-haut 6 dB/oct (HP1) de REW — premier ordre bilinéaire
 * H(z) = (1−z⁻¹) / ((1+K) + (K−1)z⁻¹) avec K = tan(ω/2).
 */
export function computeHighPass1Coefficients({ fc, sampleRate }) {
  assertBelowNyquist(fc, sampleRate);
  const K = Math.tan((Math.PI / sampleRate) * fc);
  return finalize({
    b0: 1,
    b1: -1,
    b2: 0,
    a0: 1 + K,
    a1: K - 1,
    a2: 0,
  });
}

/** Notch de l'EQ Generic de REW (Q forcé à 30 — Filter.java initNotch). */
export function computeNotchCoefficients({ fc, sampleRate, Q = 30 }) {
  assertBelowNyquist(fc, sampleRate);
  const omega = ((Math.PI * 2) / sampleRate) * fc;
  const cs = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * Q);
  return finalize({
    b0: 1,
    b1: -2 * cs,
    b2: 1,
    a0: 1 + alpha,
    a1: -2 * cs,
    a2: 1 - alpha,
  });
}

/**
 * Correction de fc près de Nyquist appliquée par REW aux shelves 6/12 dB
 * (Filter.java correctedFc) : compense la compression de l'axe des fréquences
 * de la transformée bilinéaire.
 */
function correctedFc(fc, sampleRate) {
  const x = (Math.PI / sampleRate) * fc;
  return fc * Math.pow(x / Math.sin(x), 2 + 0.015707963267948967 * Math.exp((10.98 * fc) / sampleRate));
}

/**
 * Shelfs de REW (formules RBJ « shelf slope S » de Filter.java
 * lowShelf/highShelf), validés contre l'IR REW
 * (test/fixtures/oca/filter-types.json). Trois variantes :
 * - 'plain' (types LS/HS) : S = 1, ω = 2π·fc/fs direct ;
 * - '6dB'  (LS 6dB/HS 6dB)  : S = 0.5, ω = 2·atan(π·correctedFc(fc)·k/fs)
 *   avec k = 10^(|gain|/40) (multiplié pour LS, divisé pour HS) ;
 * - '12dB' (LS 12dB/HS 12dB) : S = 1, même warp avec k = 10^(|gain|/80).
 */
export function computeShelfCoefficients({
  fc,
  gain,
  sampleRate,
  high = false,
  variant = 'plain',
}) {
  assertBelowNyquist(fc, sampleRate);
  const A = Math.pow(10, gain / 40);
  let omega;
  let slope;
  if (variant === 'plain') {
    omega = ((Math.PI * 2) / sampleRate) * fc;
    slope = 1;
  } else if (variant === '6dB' || variant === '12dB') {
    slope = variant === '6dB' ? 0.5 : 1;
    const shift = Math.pow(10, Math.abs(gain) / (variant === '6dB' ? 40 : 80));
    omega =
      2 *
      Math.atan(
        ((Math.PI * correctedFc(fc, sampleRate)) / sampleRate) *
          (high ? 1 / shift : shift),
      );
  } else {
    throw new RangeError(`Unknown shelf variant: ${variant}`);
  }
  const cs = Math.cos(omega);
  const sn = Math.sin(omega);
  const betasn = Math.sqrt((A * A + 1) / slope - (A - 1) * (A - 1)) * sn;

  if (high) {
    return finalize({
      b0: A * (A + 1 + (A - 1) * cs + betasn),
      b1: -2 * A * (A - 1 + (A + 1) * cs),
      b2: A * (A + 1 + (A - 1) * cs - betasn),
      a0: A + 1 - (A - 1) * cs + betasn,
      a1: 2 * (A - 1 - (A + 1) * cs),
      a2: A + 1 - (A - 1) * cs - betasn,
    });
  }
  return finalize({
    b0: A * (A + 1 - (A - 1) * cs + betasn),
    b1: 2 * A * (A - 1 - (A + 1) * cs),
    b2: A * (A + 1 - (A - 1) * cs - betasn),
    a0: A + 1 + (A - 1) * cs + betasn,
    a1: -2 * (A - 1 + (A + 1) * cs),
    a2: A + 1 + (A - 1) * cs - betasn,
  });
}

/**
 * Filtre Modal de REW : biquad PK dont le Q est dérivé du temps de
 * décroissance visé (Filter.java setFilterT60Target) :
 * Q = 0.5·A·sin(ω)·(1+e)/(1−e) avec A = 10^(gain/40) et
 * e = exp(−2·ln(1000)/(fs·t60Target)), t60Target étant la valeur brute du
 * bank REW. Validé contre l'IR REW (test/fixtures/oca/filter-types.json).
 */
export function computeModalCoefficients({ fc, gain, t60Target, sampleRate }) {
  assertBelowNyquist(fc, sampleRate);
  if (!Number.isFinite(t60Target) || t60Target <= 0) {
    throw new RangeError(`Invalid t60Target: ${t60Target}`);
  }
  const omega = ((Math.PI * 2) / sampleRate) * fc;
  const A = Math.pow(10, gain / 40);
  const e = Math.exp((-2 * Math.log(1000)) / (sampleRate * t60Target));
  const Q = ((0.5 * A * Math.sin(omega)) * (1 + e)) / (1 - e);
  return computePeakingCoefficients({ fc, Q, gain, sampleRate });
}
