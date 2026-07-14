/**
 * biquadResponse.js
 *
 * Pure functions to evaluate biquad frequency responses from coefficients.
 * No state — all inputs are passed explicitly.
 */

/**
 * Computes |H(e^jω)|² for normalized biquad coefficients.
 *
 * @param {{ a0,a1,a2,b0,b1,b2 }} coeffs
 * @param {number} freq       - Frequency (Hz)
 * @param {number} sampleRate - Sample rate (Hz)
 * @returns {number} Magnitude squared (linear)
 */
export function getMagnitudeSquaredFromCoefficients(coeffs, freq, sampleRate) {
  const { a0, a1, a2, b0, b1, b2 } = coeffs;

  const omega = (2 * Math.PI * freq) / sampleRate;
  const cosW = Math.cos(omega);
  const cos2W = Math.cos(2 * omega);

  const b0n = b0 / a0;
  const b1n = b1 / a0;
  const b2n = b2 / a0;
  const a1n = a1 / a0;
  const a2n = a2 / a0;

  const numSq =
    b0n * b0n +
    b1n * b1n +
    b2n * b2n +
    2 * (b0n * b1n + b1n * b2n) * cosW +
    2 * b0n * b2n * cos2W;

  const denSq =
    1 + a1n * a1n + a2n * a2n + 2 * (a1n + a1n * a2n) * cosW + 2 * a2n * cos2W;

  if (Math.abs(denSq) < 1e-15) {
    return 1;
  }

  const result = Math.abs(numSq / denSq);
  return Number.isFinite(result) ? result : 1;
}

/**
 * Computes H(e^jω) as a complex number.
 *
 * @param {{ a0,a1,a2,b0,b1,b2 }} coeffs
 * @param {number} freq       - Frequency (Hz)
 * @param {number} sampleRate - Sample rate (Hz)
 * @returns {{ re: number, im: number }}
 */
export function getComplexResponseFromCoefficients(coeffs, freq, sampleRate) {
  const { a0, a1, a2, b0, b1, b2 } = coeffs;

  const omega = (2 * Math.PI * freq) / sampleRate;
  const cosW = Math.cos(omega);
  const sinW = Math.sin(omega);
  const cos2W = Math.cos(2 * omega);
  const sin2W = Math.sin(2 * omega);

  const b0n = b0 / a0;
  const b1n = b1 / a0;
  const b2n = b2 / a0;
  const a1n = a1 / a0;
  const a2n = a2 / a0;

  const numRe = b0n + b1n * cosW + b2n * cos2W;
  const numIm = -b1n * sinW - b2n * sin2W;

  const denRe = 1 + a1n * cosW + a2n * cos2W;
  const denIm = -a1n * sinW - a2n * sin2W;

  const denMagSq = denRe * denRe + denIm * denIm;
  if (denMagSq < 1e-30) {
    return { re: 1, im: 0 };
  }

  const re = (numRe * denRe + numIm * denIm) / denMagSq;
  const im = (numIm * denRe - numRe * denIm) / denMagSq;

  return Number.isFinite(re) && Number.isFinite(im) ? { re, im } : { re: 1, im: 0 };
}

/**
 * Same computation as getComplexResponseFromCoefficients, with the
 * frequency-dependent trigonometry supplied by the caller. Lets hot loops
 * (per-candidate filter evaluation on a fixed frequency grid) precompute
 * cos/sin tables once instead of paying four transcendental calls per bin.
 *
 * @param {{ a0,a1,a2,b0,b1,b2 }} coeffs
 * @param {{ cosW,sinW,cos2W,sin2W }} trig - Precomputed at the target
 *   frequency for the same sample rate the coefficients were designed for
 * @returns {{ re: number, im: number }}
 */
export function getComplexResponseWithTrig(coeffs, trig) {
  const { a0, a1, a2, b0, b1, b2 } = coeffs;
  const { cosW, sinW, cos2W, sin2W } = trig;

  const b0n = b0 / a0;
  const b1n = b1 / a0;
  const b2n = b2 / a0;
  const a1n = a1 / a0;
  const a2n = a2 / a0;

  const numRe = b0n + b1n * cosW + b2n * cos2W;
  const numIm = -b1n * sinW - b2n * sin2W;

  const denRe = 1 + a1n * cosW + a2n * cos2W;
  const denIm = -a1n * sinW - a2n * sin2W;

  const denMagSq = denRe * denRe + denIm * denIm;
  if (denMagSq < 1e-30) {
    return { re: 1, im: 0 };
  }

  const re = (numRe * denRe + numIm * denIm) / denMagSq;
  const im = (numIm * denRe - numRe * denIm) / denMagSq;

  return Number.isFinite(re) && Number.isFinite(im) ? { re, im } : { re: 1, im: 0 };
}

/**
 * Réponse complexe d'une cascade de biquads : produit des réponses de chaque
 * étage (getComplexResponseFromCoefficients). Les coefficients doivent avoir
 * été calculés au `sampleRate` fourni.
 *
 * @param {Array<{ a0,a1,a2,b0,b1,b2 }>} filters - Cascade (BiquadFilter ou coeffs)
 * @param {number} freq       - Frequency (Hz)
 * @param {number} sampleRate - Sample rate (Hz)
 * @returns {{ re: number, im: number }}
 */
export function getCascadeComplexResponse(filters, freq, sampleRate) {
  let re = 1;
  let im = 0;
  for (const filter of filters) {
    const stage = getComplexResponseFromCoefficients(filter, freq, sampleRate);
    const nextRe = re * stage.re - im * stage.im;
    im = re * stage.im + im * stage.re;
    re = nextRe;
  }
  return { re, im };
}

/**
 * Computes filter phase in degrees.
 *
 * @param {{ p1,p2,p3,p4,p5 }} coeffs - Phase coefficients
 * @param {number} freq       - Frequency (Hz)
 * @param {number} sampleRate - Sample rate (Hz)
 * @returns {number} Phase in degrees
 */
export function getPhaseFromCoefficients(coeffs, freq, sampleRate) {
  const { p1, p2, p3, p4, p5 } = coeffs;

  const theta = freq * ((Math.PI * 2) / sampleRate);
  const cosTheta = Math.cos(theta);
  const cos2Theta = Math.cos(2 * theta);
  const sinTheta = Math.sin(theta);

  const numerator = (p4 + p5 * cosTheta) * sinTheta;
  const denominator = p1 + p2 * cosTheta + p3 * cos2Theta;

  if (Math.abs(denominator) < 1e-15) {
    return 0;
  }

  const phase = Math.atan2(numerator, denominator);
  return Number.isFinite(phase) ? (phase * 180) / Math.PI : 0;
}
