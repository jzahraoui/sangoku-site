import { fft, ifft, complex } from 'mathjs';
import Polar from './Polar.js';

/**
 * FrequencyResponseProcessor
 * Classe dédiée au traitement des réponses en fréquence
 * Smoothing, phase minimum, calculs avancés, etc.
 */
class FrequencyResponseProcessor {
  /**
   * Applique un lissage à la réponse en fréquence
   * @param {Float32Array} freqs - Tableau des fréquences
   * @param {Float32Array} magnitude - Magnitude en dB
   * @param {string} smoothing - Type de lissage ('1/12', '1/6', '1/3')
   * @returns {Float32Array} Magnitude lissée
   */
  static smooth(freqs, magnitude, smoothing = '1/12') {
    const octaveFraction = Number.parseFloat(smoothing.split('/')[1]);
    const smoothingFactor = Math.log(2) / octaveFraction;

    return magnitude.map((_, i) => {
      const centerFreq = freqs[i];
      let sum = 0;
      let count = 0;

      for (let j = 0; j < freqs.length; j++) {
        const freq = freqs[j];
        const logDistance = Math.abs(Math.log(freq / centerFreq));

        if (logDistance <= smoothingFactor) {
          const weight = Math.exp(
            (-logDistance * logDistance) / (2 * smoothingFactor * smoothingFactor)
          );
          sum += magnitude[j] * weight;
          count += weight;
        }
      }

      return count > 0 ? sum / count : magnitude[i];
    });
  }

  /**
   * Calcule la phase minimum à partir de la magnitude
   * Utilise la méthode cepstrale standard (Hilbert transform)
   * @param {Float32Array} magnitude - Magnitude en dB
   * @returns {Float32Array} Phase minimum en degrés
   */
  static calculateMinimumPhase(magnitude) {
    const N = magnitude.length;
    if (N === 0) throw new Error('Magnitude array cannot be empty');

    const fftSize = Math.pow(2, Math.ceil(Math.log2(N * 2)));

    // Convert dB to log magnitude
    const logMag = new Array(fftSize).fill(0);
    for (let i = 0; i < N; i++) {
      const linear = Polar.DbToLinearGain(magnitude[i]);
      logMag[i] = Math.log(Math.max(linear, 1e-10));
    }
    // Create symmetric spectrum for real signal
    for (let i = 1; i < N; i++) {
      logMag[fftSize - i] = logMag[i];
    }

    // IFFT to cepstrum domain
    const cepstrum = ifft(logMag);

    // Apply minimum phase window (Hilbert transform)
    const windowed = cepstrum.map((val, i) => {
      if (i === 0) return val;
      if (i < fftSize / 2) return val.mul(2);
      if (i === fftSize / 2) return val;
      return complex(0, 0);
    });

    // FFT back - imaginary part is minimum phase
    const result = fft(windowed);

    // Extract phase
    return result.slice(0, N).map(c => {
      return Polar.radiansToDegrees(Polar.normalizePhase(c.im));
    });
  }
}

export default FrequencyResponseProcessor;
