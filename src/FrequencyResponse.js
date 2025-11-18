import MeasurementItem from './MeasurementItem.js';

/**
 * Class to handle API command results as objects
 */
class FrequencyResponse {
  /**
   * Create a new FrequencyResponse instance
   * @param {Object} rawData - The raw data from the API response
   */
  constructor(rawData) {
    // Store the original raw data
    this.rawData = rawData;

    // Extract common properties
    for (const key of Object.keys(rawData)) {
      this[key] = rawData[key];
    }
  }

  /**
   * Generate frequency array based on start frequency and step or PPO
   * @returns {Float32Array} Float32Array of frequency values
   */
  generateFrequencyArray() {
    if (!this.magnitudeArray || !this.data) {
      throw new Error('Magnitude data is missing');
    }

    const dataLength = this.magnitudeArray.length || this.data.length;

    if (this.freqStep) {
      return Float32Array.from({ length: dataLength }, (_, i) =>
        MeasurementItem.cleanFloat32Value(this.startFreq + i * this.freqStep)
      );
    }
    if (this.ppo) {
      return Float32Array.from({ length: dataLength }, (_, i) =>
        MeasurementItem.cleanFloat32Value(this.startFreq * Math.pow(2, i / this.ppo))
      );
    }
    throw new Error('Either freqStep or ppo must be defined to generate frequency array');
  }

  /**
   * Process the frequency response data
   * @returns {Object} Processed frequency response data
   */
  processFrequencyResponse() {
    const freqs = this.generateFrequencyArray();

    return {
      freqs,
      ...(this.magnitude && { magnitude: this.magnitudeArray }),
      ...(this.phaseArray && { phase: this.phaseArray }),
      ...(this.data && { data: this.data }),
      startFreq: this.startFreq,
      endFreq: freqs.at(-1) ?? 0,
      ...(this.freqStep && { freqStep: this.freqStep }),
      ...(this.ppo && { ppo: this.ppo }),
      ...(this.samplingRate && { samplingRate: this.samplingRate }),
      ...(-this.smoothing && { smoothing: this.smoothing }),
      ...(this.unit && { unit: this.unit }),
    };
  }
}

export default FrequencyResponse;
