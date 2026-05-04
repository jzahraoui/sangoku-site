/**
 * peakingMagnitude.js
 *
 * Calcul de magnitude pour peaking EQ : approximation rapide et calcul exact.
 */

import { computePeakingCoefficients } from './biquadCoefficients.js';
import { getMagnitudeSquaredFromCoefficients } from './biquadResponse.js';

/**
 * Approximation rapide de magnitude pour peaking EQ.
 * Précision : ~0.3 dB RMS vs biquad exact. Vitesse : ~15× plus rapide.
 *
 * @param {number} fc   - Fréquence centrale (Hz)
 * @param {number} Q    - Facteur de qualité
 * @param {number} gain - Gain (dB)
 * @param {number} freq - Fréquence d'évaluation (Hz)
 * @returns {number} Réponse approximative en dB
 */
export function peakMagApprox(fc, Q, gain, freq) {
  if (Math.abs(gain) < 0.01) return 0;
  const ratio = freq / fc;
  const diff = ratio - 1 / ratio;
  return gain / (1 + Q * Q * diff * diff);
}

/**
 * Calcul exact de magnitude biquad pour peaking EQ.
 * Délègue à computePeakingCoefficients + getMagnitudeSquaredFromCoefficients.
 *
 * @param {number} fc         - Fréquence centrale (Hz)
 * @param {number} Q          - Facteur de qualité
 * @param {number} gain       - Gain (dB)
 * @param {number} freq       - Fréquence d'évaluation (Hz)
 * @param {number} sampleRate - Fréquence d'échantillonnage (Hz)
 * @returns {number} Réponse en dB
 */
export function peakMagExact(fc, Q, gain, freq, sampleRate) {
  if (Math.abs(gain) < 0.001) return 0;

  const coeffs = computePeakingCoefficients({ fc, Q, gain, sampleRate });
  const magSq = getMagnitudeSquaredFromCoefficients(coeffs, freq, sampleRate);

  return 10 * Math.log10(Math.max(magSq, Number.MIN_VALUE));
}
