/**
 * @typedef {Object} RoomCurveConfig
 * @property {boolean} addRoomCurve - Whether to apply room curve
 * @property {number} [lowFreqRiseStartHz] - Low frequency rise start in Hz
 * @property {number} [lowFreqRiseEndHz] - Low frequency rise end in Hz
 * @property {number} [lowFreqRiseSlopedBPerOctave] - Low frequency slope in dB/octave
 * @property {number} [highFreqFallStartHz] - High frequency fall start in Hz
 * @property {number} [highFreqFallSlopedBPerOctave] - High frequency slope in dB/octave
 */

const PRESETS = Object.freeze({
  none: Object.freeze({
    text: 'None',
    settings: Object.freeze({ addRoomCurve: false }),
  }),
  dolbyAtmosMusic: Object.freeze({
    text: 'Dolby Atmos Music',
    settings: Object.freeze({
      addRoomCurve: true,
      lowFreqRiseStartHz: 165,
      lowFreqRiseEndHz: 125,
      lowFreqRiseSlopedBPerOctave: 2.5,
      highFreqFallStartHz: 1650,
      highFreqFallSlopedBPerOctave: 1.5,
    }),
  }),
  drOliveToole: Object.freeze({
    text: 'Dr. Olive / Toole',
    settings: Object.freeze({
      addRoomCurve: true,
      lowFreqRiseStartHz: 1850,
      lowFreqRiseEndHz: 70,
      lowFreqRiseSlopedBPerOctave: 0.7,
      highFreqFallStartHz: 4500,
      highFreqFallSlopedBPerOctave: 0.5,
    }),
  }),
  harman: Object.freeze({
    text: 'Harman',
    settings: Object.freeze({
      addRoomCurve: true,
      lowFreqRiseStartHz: 185,
      lowFreqRiseEndHz: 60,
      lowFreqRiseSlopedBPerOctave: 4.1,
      highFreqFallStartHz: 600,
      highFreqFallSlopedBPerOctave: 0.5,
    }),
  }),
  rtings: Object.freeze({
    text: 'RTINGS',
    settings: Object.freeze({
      addRoomCurve: true,
      lowFreqRiseStartHz: 250,
      lowFreqRiseEndHz: 70,
      lowFreqRiseSlopedBPerOctave: 2.8,
      highFreqFallStartHz: 1000,
      highFreqFallSlopedBPerOctave: 0.9,
    }),
  }),
});

const cloneSettings = settings => ({ ...settings });

/**
 * Room curve settings for different calibration standards.
 * @readonly
 */
class RoomCurvesSettings {
  static DEFAULT_CHOICE = 'none';

  /** @type {RoomCurveConfig} */
  static NONE = PRESETS.none.settings;
  /** @type {RoomCurveConfig} */
  static DOLBY_ATMOS_MUSIC = PRESETS.dolbyAtmosMusic.settings;
  /** @type {RoomCurveConfig} */
  static DR_OLIVE_TOOLE = PRESETS.drOliveToole.settings;
  /** @type {RoomCurveConfig} */
  static HARMAN = PRESETS.harman.settings;
  /** @type {RoomCurveConfig} */
  static HARMON = Object.freeze({
    addRoomCurve: true,
    lowFreqRiseStartHz: 225,
    lowFreqRiseEndHz: 60,
    lowFreqRiseSlopedBPerOctave: 3.6,
    highFreqFallStartHz: 700,
    highFreqFallSlopedBPerOctave: 0.5,
  });
  /** @type {RoomCurveConfig} */
  static RTINGS = PRESETS.rtings.settings;

  /** @private */
  constructor() {
    throw new Error('RoomCurvesSettings is a static class and cannot be instantiated');
  }

  /**
   * Get select options for the room curve dropdown.
   * @returns {{ value: string, text: string }[]}
   */
  static getChoices() {
    return Object.entries(PRESETS).map(([value, preset]) => ({
      value,
      text: preset.text,
    }));
  }

  /**
   * Get a clone of the REW room curve settings for a preset key.
   * @param {string} value
   * @returns {RoomCurveConfig}
   */
  static getCurveConfig(value = RoomCurvesSettings.DEFAULT_CHOICE) {
    const preset = PRESETS[value];
    if (!preset) {
      throw new Error(`Unknown room curve preset: ${value}`);
    }
    return cloneSettings(preset.settings);
  }

  /**
   * Check whether a preset key is available.
   * @param {string} value
   * @returns {boolean}
   */
  static hasChoice(value) {
    return Object.hasOwn(PRESETS, value);
  }

  /**
   * Get all available room curve configurations.
   * @returns {Object.<string, RoomCurveConfig>}
   */
  static getAllCurves() {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(PRESETS).map(([value, preset]) => [
          value,
          cloneSettings(preset.settings),
        ]),
      ),
    );
  }
}

export default RoomCurvesSettings;
