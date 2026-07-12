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
