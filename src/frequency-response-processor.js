import { fft, ifft, complex } from 'mathjs';
import Polar from './Polar.js';

const LINEAR_TOLERANCE = 1e-6;
const LOG_TOLERANCE = 1e-5;

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
   * @param {string} smoothing - Type de lissage ('None', '1/12', '1/6', '1/3')
   * @returns {Float32Array} Magnitude lissée
   */
  static smooth(freqs, magnitude, smoothing = '1/12') {
    const { freqs: validatedFreqs, values } = this.validateFrequencySeries(
      freqs,
      magnitude,
      'smooth',
    );

    if (smoothing === 'None' || smoothing === 'none' || smoothing === null) {
      return Float32Array.from(values);
    }

    const octaveFraction = this.parseSmoothing(smoothing);
    const smoothingFactor = Math.log(2) / octaveFraction;
    const logFreqs = validatedFreqs.map(freq => Math.log(freq));

    let startIdx = 0;
    let endIdx = 0;

    return Float32Array.from(values, (_, i) => {
      const centerLogFreq = logFreqs[i];
      let sum = 0;
      let count = 0;

      while (startIdx < i && centerLogFreq - logFreqs[startIdx] > smoothingFactor) {
        startIdx++;
      }

      while (
        endIdx + 1 < logFreqs.length &&
        logFreqs[endIdx + 1] - centerLogFreq <= smoothingFactor
      ) {
        endIdx++;
      }

      for (let j = startIdx; j <= endIdx; j++) {
        const logDistance = Math.abs(logFreqs[j] - centerLogFreq);

        if (logDistance <= smoothingFactor) {
          const weight = Math.exp(
            (-logDistance * logDistance) / (2 * smoothingFactor * smoothingFactor),
          );
          sum += values[j] * weight;
          count += weight;
        }
      }

      return count > 0 ? sum / count : values[i];
    });
  }

  /**
   * Calcule la phase minimum à partir de la magnitude
   * Utilise la méthode cepstrale standard (Hilbert transform)
   * @param {Float32Array|Object} response - Magnitude en dB ou réponse { freqs, magnitude, freqStep, ppo }
   * @param {Object} [options] - { freqs, startFreq, freqStep, ppo }
   * @returns {Float32Array} Phase minimum en degrés
   */
  static calculateMinimumPhase(response, options = {}) {
    const input = this.normaliseMinimumPhaseInput(response, options);
    const samples = this.prepareMinimumPhaseSamples(input);
    const gridPhase = this.calculateUniformMinimumPhase(samples.magnitude);

    if (samples.outputAxis === samples.gridAxis) {
      return gridPhase;
    }

    return Float32Array.from(samples.outputAxis, axisValue =>
      this.interpolateLinear(axisValue, samples.gridAxis, gridPhase),
    );
  }

  static calculateUniformMinimumPhase(magnitude) {
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
    return Float32Array.from(result.slice(0, N), c =>
      Polar.radiansToDegrees(Polar.normalizePhase(c.im)),
    );
  }

  static normaliseMinimumPhaseInput(response, options) {
    const magnitude = response?.magnitude ?? response;
    const freqs = options.freqs ?? response?.freqs ?? null;
    const freqStep = options.freqStep ?? response?.freqStep ?? null;
    const ppo = options.ppo ?? response?.ppo ?? null;
    const startFreq = options.startFreq ?? response?.startFreq ?? null;

    const values = this.validateFiniteArray(magnitude, 'magnitude');
    const resolvedFreqs = freqs
      ? this.validateFiniteArray(freqs, 'freqs')
      : this.generateFrequencyArray(values.length, startFreq, freqStep, ppo);

    if (resolvedFreqs && resolvedFreqs.length !== values.length) {
      throw new Error('Frequency and magnitude arrays must have the same length');
    }

    return { magnitude: values, freqs: resolvedFreqs, freqStep, ppo };
  }

  static prepareMinimumPhaseSamples({ magnitude, freqs, freqStep, ppo }) {
    if (!freqs) {
      return { magnitude, gridAxis: null, outputAxis: null };
    }

    this.validatePositiveFrequencies(freqs);
    const spacing = this.detectSpacing(freqs, freqStep, ppo);
    const outputAxis = spacing === 'log' ? freqs.map(freq => Math.log(freq)) : freqs;

    if (
      this.isUniform(outputAxis, spacing === 'log' ? LOG_TOLERANCE : LINEAR_TOLERANCE)
    ) {
      return { magnitude, gridAxis: outputAxis, outputAxis };
    }

    const gridAxis = Array.from({ length: outputAxis.length }, (_, i) => {
      if (outputAxis.length === 1) return outputAxis[0];
      const ratio = i / (outputAxis.length - 1);
      return outputAxis[0] + (outputAxis.at(-1) - outputAxis[0]) * ratio;
    });

    return {
      magnitude: Float32Array.from(gridAxis, axisValue =>
        this.interpolateLinear(axisValue, outputAxis, magnitude),
      ),
      gridAxis,
      outputAxis,
    };
  }

  static validateFrequencySeries(freqs, magnitude, context) {
    const validatedFreqs = this.validateFiniteArray(freqs, 'freqs');
    const values = this.validateFiniteArray(magnitude, 'magnitude');

    if (validatedFreqs.length !== values.length) {
      throw new Error(
        `${context}: frequency and magnitude arrays must have the same length`,
      );
    }

    this.validatePositiveFrequencies(validatedFreqs);

    return { freqs: validatedFreqs, values };
  }

  static validateFiniteArray(values, name) {
    if (!values || typeof values.length !== 'number') {
      throw new TypeError(`${name} must be an array-like object`);
    }

    if (values.length === 0) {
      throw new Error(`${name} array cannot be empty`);
    }

    return Array.from(values, value => {
      if (!Number.isFinite(value)) {
        throw new TypeError(`${name} array contains a non-finite value`);
      }
      return value;
    });
  }

  static validatePositiveFrequencies(freqs) {
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] <= 0) {
        throw new Error('Frequency values must be positive');
      }
      if (i > 0 && freqs[i] <= freqs[i - 1]) {
        throw new Error('Frequency values must be strictly increasing');
      }
    }
  }

  static parseSmoothing(smoothing) {
    if (typeof smoothing !== 'string') {
      throw new TypeError('smoothing must be a string');
    }

    const match = new RegExp(/^1\/(\d+(?:\.\d+)?)$/).exec(smoothing);
    const octaveFraction = match ? Number.parseFloat(match[1]) : Number.NaN;

    if (!Number.isFinite(octaveFraction) || octaveFraction <= 0) {
      throw new Error(`Invalid smoothing value: ${smoothing}`);
    }

    return octaveFraction;
  }

  static generateFrequencyArray(length, startFreq, freqStep, ppo) {
    if (freqStep == null && ppo == null && startFreq == null) return null;

    if (!Number.isFinite(startFreq) || startFreq <= 0) {
      throw new Error('startFreq must be provided and positive');
    }

    if (freqStep != null) {
      if (!Number.isFinite(freqStep) || freqStep <= 0) {
        throw new Error('freqStep must be a positive number');
      }
      return Array.from({ length }, (_, i) => startFreq + i * freqStep);
    }

    if (!Number.isFinite(ppo) || ppo <= 0) {
      throw new Error('ppo must be a positive number');
    }

    return Array.from({ length }, (_, i) => startFreq * Math.pow(2, i / ppo));
  }

  static detectSpacing(freqs, freqStep, ppo) {
    if (this.isUniform(freqs, LINEAR_TOLERANCE)) return 'linear';

    const logFreqs = freqs.map(freq => Math.log(freq));
    if (this.isUniform(logFreqs, LOG_TOLERANCE)) return 'log';

    if (freqStep != null && ppo == null) return 'linear';
    if (ppo != null) return 'log';

    throw new Error('Frequency spacing must be linear (freqStep) or logarithmic (ppo)');
  }

  static isUniform(values, tolerance) {
    if (values.length < 3) return true;

    const step = values[1] - values[0];
    const scale = Math.max(1, Math.abs(step));

    for (let i = 2; i < values.length; i++) {
      if (Math.abs(values[i] - values[i - 1] - step) > tolerance * scale) {
        return false;
      }
    }

    return true;
  }

  static interpolateLinear(value, xValues, yValues) {
    if (!xValues) return yValues[0];
    if (value <= xValues[0]) return yValues[0];
    if (value >= xValues.at(-1)) return yValues.at(-1);

    let lo = 0;
    let hi = xValues.length - 1;

    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (xValues[mid] <= value) lo = mid;
      else hi = mid;
    }

    const ratio = (value - xValues[lo]) / (xValues[hi] - xValues[lo]);
    return yValues[lo] + ratio * (yValues[hi] - yValues[lo]);
  }
}

export default FrequencyResponseProcessor;
