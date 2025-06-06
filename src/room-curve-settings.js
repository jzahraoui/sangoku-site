/**
 * @typedef {Object} RoomCurveConfig
 * @property {boolean} addRoomCurve - Whether to apply room curve
 * @property {number} lowFreqRiseStartHz - Low frequency rise start in Hz
 * @property {number} lowFreqRiseEndHz - Low frequency rise end in Hz
 * @property {number} lowFreqRiseSlopedBPerOctave - Low frequency slope in dB/octave
 * @property {number} highFreqFallStartHz - High frequency fall start in Hz
 * @property {number} highFreqFallSlopedBPerOctave - High frequency slope in dB/octave
 */

/**
 * Room curve settings for different calibration standards
 * @readonly
 */
class RoomCurvesSettings {
  /** @type {RoomCurveConfig} */
  static DOLBY_ATMOS_MUSIC = Object.freeze({
    addRoomCurve: true,
    lowFreqRiseStartHz: 165,
    lowFreqRiseEndHz: 125,
    lowFreqRiseSlopedBPerOctave: 2.5,
    highFreqFallStartHz: 1650,
    highFreqFallSlopedBPerOctave: 1.5,
  });

  static DR_OLIVE_TOOLE = Object.freeze({
    addRoomCurve: true,
    lowFreqRiseStartHz: 1850,
    lowFreqRiseEndHz: 70,
    lowFreqRiseSlopedBPerOctave: 0.7,
    highFreqFallStartHz: 4500,
    highFreqFallSlopedBPerOctave: 0.5,
  });

  static HARMAN = Object.freeze({
    addRoomCurve: true,
    lowFreqRiseStartHz: 185,
    lowFreqRiseEndHz: 60,
    lowFreqRiseSlopedBPerOctave: 4.1,
    highFreqFallStartHz: 600,
    highFreqFallSlopedBPerOctave: 0.5,
  });

  static HARMON = Object.freeze({
    addRoomCurve: true,
    lowFreqRiseStartHz: 225,
    lowFreqRiseEndHz: 60,
    lowFreqRiseSlopedBPerOctave: 3.6,
    highFreqFallStartHz: 700,
    highFreqFallSlopedBPerOctave: 0.5,
  });

  static RTINGS = Object.freeze({
    addRoomCurve: true,
    lowFreqRiseStartHz: 250,
    lowFreqRiseEndHz: 70,
    lowFreqRiseSlopedBPerOctave: 2.8,
    highFreqFallStartHz: 1000,
    highFreqFallSlopedBPerOctave: 0.9,
  });

  /** @private */
  constructor() {
    throw new Error('RoomCurvesSettings is a static class and cannot be instantiated');
  }

  /**
   * Get all available room curve configurations
   * @returns {Object.<string, RoomCurveConfig>}
   */
  static getAllCurves() {
    return Object.freeze({
      dolbyAtmosMusic: this.DOLBY_ATMOS_MUSIC,
      drOliveToole: this.DR_OLIVE_TOOLE,
      harman: this.HARMAN,
      rtings: this.RTINGS,
    });
  }
}

export default RoomCurvesSettings;
