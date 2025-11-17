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
   * @returns {Array} Array of frequency values
   */
  generateFrequencyArray() {
    if (!this.magnitudeArray) {
      return [];
    }

    const dataLength = this.magnitudeArray.length;

    if (this.freqStep) {
      return Array.from({ length: dataLength }, (_, i) =>
        MeasurementItem.cleanFloat32Value(this.startFreq + i * this.freqStep)
      );
    } else {
      const pointsPerOctave = this.ppo || 96; // Use provided PPO, or stored PPO, or default
      return Array.from({ length: dataLength }, (_, i) =>
        MeasurementItem.cleanFloat32Value(
          this.startFreq * Math.pow(2, i / pointsPerOctave)
        )
      );
    }
  }

  /**
   * Process the frequency response data
   * @returns {Object} Processed frequency response data
   */
  processFrequencyResponse() {
    const freqs = this.generateFrequencyArray();

    return {
      freqs,
      magnitude: this.magnitudeArray,
      ...(this.phaseArray && { phase: this.phaseArray }),
      startFreq: this.startFreq,
      endFreq: freqs.at(-1) ?? 0,
      freqStep: this.freqStep,
      ...(this.ppo && { ppo: this.ppo }),
      ...(this.samplingRate && { samplingRate: this.samplingRate }),
      ...(-this.smoothing && { smoothing: this.smoothing }),
      ...(this.unit && { unit: this.unit }),
    };
  }
}

export default FrequencyResponse;
