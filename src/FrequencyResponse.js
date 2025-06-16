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
    Object.keys(rawData).forEach(key => {
      this[key] = rawData[key];
    });

    // Decode base64 encoded data if present
    if (rawData.magnitude) {
      this.decodedMagnitude = MeasurementItem.decodeRewBase64(rawData.magnitude);
    }

    if (rawData.phase) {
      this.decodedPhase = MeasurementItem.decodeRewBase64(rawData.phase);
    }
  }

  /**
   * Generate frequency array based on start frequency and step or PPO
   * @returns {Array} Array of frequency values
   */
  generateFrequencyArray() {
    if (!this.decodedMagnitude) {
      return [];
    }

    const dataLength = this.decodedMagnitude.length;

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
   * Get the end frequency based on the generated frequency array
   * @param {Array} freqs - Array of frequencies
   * @returns {number} The end frequency
   */
  getEndFrequency(freqs) {
    return freqs.length > 0 ? freqs[freqs.length - 1] : 0;
  }

  /**
   * Process the frequency response data
   * @returns {Object} Processed frequency response data
   */
  processFrequencyResponse() {
    const freqs = this.generateFrequencyArray();
    const endFreq = this.getEndFrequency(freqs);

    return {
      freqs,
      magnitude: this.decodedMagnitude,
      phase: this.decodedPhase,
      startFreq: this.startFreq,
      endFreq,
      freqStep: this.freqStep,
      ppo: this.ppo,
      smoothing: this.smoothing,
      unit: this.unit,
    };
  }
}

export default FrequencyResponse;
