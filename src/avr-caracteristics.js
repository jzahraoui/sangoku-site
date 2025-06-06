class AvrCaracteristics {
  // Constants
  static SPEED_OF_SOUND = {
    LEGACY: 300,
    DEFAULT: 343,
  };

  static FREQUENCY_INDEXES = {
    BASE: [40, 60, 80, 90, 100, 110, 120, 150, 200, 250],
    get EXTENDED() {
      const extendedArray = [...this.BASE];
      extendedArray.splice(8, 0, 180);
      return extendedArray;
    },
  };

  static DAC_MODELS = Object.freeze({
    SOFT_ROLL_IDENTIFIERS: ['NR', 'SR', 'AV7', 'AV8', 'AV1', 'CINEMA'],
    SWITCHABLE_FILTER_MODELS: ['AV10', 'CINEMA 30'],
  });

  static MODEL_LISTS = Object.freeze({
    LEGACY_SPEED_OF_SOUND: [
      '-S720W',
      '-S920W',
      'X1300W',
      'X2300W',
      'X3300W',
      'NR1607',
      'SR5011',
      'SR6011',
      'C-A110',
      'X3700H',
      'X4700H',
      'X6500H',
      'X6700H',
      'X8500H',
      'R-A110',
      '-S730H',
      '-S740H',
      '-S750H',
      '-S760H',
      '-S930H',
      '-S940H',
      '-S950H',
      '-S960H',
      'X1400H',
      'X1500H',
      'X1600H',
      'X1700H',
      'X2400H',
      'X2500H',
      'X2600H',
      'X2700H',
      'X3400H',
      'X3500H',
      'X3600H',
      'X3700H',
      'X4300H',
      'X4400H',
      'X4500H',
      'X6300H',
      'X6400H',
      'X6500H',
      'X6700H',
      'X8500H',
      'AV7703',
      'AV7704',
      'AV7705',
      'AV7706',
      'AV8805',
      'NR1608',
      'NR1609',
      'NR1710',
      'NR1711',
      'SR5012',
      'SR5013',
      'SR5014',
      'SR5015',
      'SR6012',
      'SR6013',
      'SR6014',
      'SR6015',
      'SR7011',
      'SR7012',
      'SR7013',
      'SR7015',
      'SR8012',
      'SR8015',
    ],

    CIRRUS_LOGIC_DSP: [
      '-S720W',
      '-S920W',
      'X1300W',
      'X2300W',
      'X3300W',
      'NR1607',
      'SR5011',
      '-S730H',
      '-S740H',
      '-S750H',
      '-S760H',
      '-S930H',
      '-S940H',
      '-S950H',
      '-S960H',
      'X1400H',
      'X1500H',
      'X1600H',
      'X1700H',
      'X2400H',
      'X2500H',
      'X2600H',
      'X2700H',
      'X3400H',
      'X3500H',
      'X3600H',
      'NR1608',
      'NR1609',
      'NR1710',
      'NR1711',
      'SR5012',
      'SR5013',
      'SR5014',
      'SR5015',
      'SR6013',
      'SR6014',
      '-S770H',
      '-S970H',
      'X1800H',
      'X2800H',
      'EMA 60',
      'MA 70s',
    ],

    LEGACY_MODELS: [
      '-S720W',
      '-S920W',
      'X1300W',
      'X2300W',
      'X3300W',
      'NR1607',
      'SR5011',
      'SR6011',
      'X6500H',
      '-S730H',
      '-S740H',
      '-S930H',
      '-S940H',
      'X1400H',
      'X1500H',
      'X2400H',
      'X2500H',
      'X3400H',
      'X3500H',
      'X4300H',
      'X4400H',
      'X4500H',
      'X6300H',
      'X6400H',
      'X6500H',
      'AV7703',
      'AV7704',
      'AV7705',
      'NR1608',
      'NR1609',
      'SR5012',
      'SR5013',
      'SR6012',
      'SR6013',
      'SR7011',
      'SR7012',
      'SR7013',
      'SR8012',
    ],
  });

  static EQ_TYPES = Object.freeze({
    BASIC: {
      id: 0,
      name: 'Basic',
      specs: {
        subFilter: {
          samples: 512,
          taps: 512,
          frequency: 48000,
        },
        speakerFilter: {
          samples: 128,
          taps: 128,
          frequency: 6000,
        },
      },
    },
    XT: {
      id: 1,
      name: 'XT',
      specs: {
        subFilter: {
          samples: 512,
          taps: 512,
          frequency: 48000,
        },
        speakerFilter: {
          samples: 512,
          taps: 512,
          frequency: 6000,
        },
      },
    },
    XT32: {
      id: 2,
      name: 'XT32',
      specs: {
        subFilter: {
          samples: 16055,
          taps: 704,
          frequency: 48000,
        },
        speakerFilter: {
          samples: 16321,
          taps: 1024,
          frequency: 48000,
        },
      },
    },
  });

  /**
   * Finds and returns an EQ type by its ID
   * @param {number} id - The ID of the EQ type to find
   * @returns {Object|undefined} The matching EQ type or undefined if not found
   */
  static getTypeById(id) {
    return Object.values(this.EQ_TYPES).find(type => type.id === id);
  }

  /**
   * Generates a description string for the specified EQ type
   * @param {string} type - The type key (BASIC, XT, or XT32)
   * @returns {string} Formatted description of the EQ type
   * @throws {Error} If the type doesn't exist
   */
  static getDescription(type) {
    const config = this.EQ_TYPES[type];
    return `${config.name} (sub filter: ${config.specs.subFilter.samples} samples / ${config.specs.subFilter.taps} taps, speaker filter: ${config.specs.speakerFilter.samples} samples / ${config.specs.speakerFilter.taps} taps)`;
  }

  /**
   * Creates a new AvrCaracteristics instance
   * @param {String} targetModelName - Configuration data
   * @throws {Error} If targetModelName is invalid
   */
  constructor(targetModelName, enMultEQType) {
    if (!targetModelName) {
      throw new Error('Target model name is required');
    }
    if (!enMultEQType) {
      throw new Error('MultEQ type is required');
    }

    this.targetModelName = targetModelName;
    this.enMultEQType = enMultEQType;
    this.modelSuffix = this.targetModelName.slice(-6);
    this.validateModelConfig();
    this.hasExtendedFrequency = this.hasExtendedFreq();
    this.hasCirrusLogicDsp = this.getHasCirrusLogicDsp();
    this.hasSwitchableDacFilter = this.hasSwitchableDacFilter();
    this.hasSoftRollDac = this.hasSoftRollDac();
    this.speedOfSound = this.getSpeedOfSound();
    this.minDistAccuracy = this.getMinDistAccuracy();
    this.frequencyIndexes = this.getFrequencyIndexes(this.hasExtendedFrequency);
    this.multEQDetails = this.configureMultEQ();
    this.multEQType = this.multEQDetails.name;
    this.multEQSpecs = this.multEQDetails.specs;
    this.multEQDescription = AvrCaracteristics.getDescription(this.multEQType);
  }

  /**
   * Validates model configuration
   * @throws {Error} If model configuration is invalid
   * @private
   */
  validateModelConfig() {
    if (!this.modelSuffix) {
      throw new Error('Invalid model suffix');
    }

    if (
      !AvrCaracteristics.MODEL_LISTS.LEGACY_MODELS.includes(this.modelSuffix) &&
      !AvrCaracteristics.MODEL_LISTS.CIRRUS_LOGIC_DSP.includes(this.modelSuffix) &&
      !AvrCaracteristics.MODEL_LISTS.LEGACY_SPEED_OF_SOUND.includes(this.modelSuffix)
    ) {
      console.warn(`Unknown model: ${this.targetModelName}`);
    }
  }

  configureMultEQ() {
    return AvrCaracteristics.getTypeById(this.enMultEQType);
  }

  /**
   * Logs model specifications
   * @private
   */
  logModelSpecs() {
    console.info(`Target AV receiver model: ${this.targetModelName}`);
    console.log(`MultEQ Type:: ${AvrCaracteristics.getDescription(this.multEQType)}`);
    console.info(`Model specific speed of sound setting: ${this.speedOfSound} m/s`);
    console.info(`Model minimum distance accuracy: ${this.minDistAccuracy} m/s`);
    console.info(
      `Model is capable of setting 180Hz crossover: ${this.hasExtendedFrequency}`
    );
    console.info(`Model has Cirrus Logic DSP chip: ${this.hasCirrusLogicDsp}`);
    this.logDacSpecs();
  }

  /**
   * Logs DAC specifications
   * @private
   */
  logDacSpecs() {
    console.info(`Model has switchable DAC filter: ${this.hasSwitchableDacFilter}`);
    if (this.hasSwitchableDacFilter) {
      console.info(
        "If 'DAC filter' in your unit is not set to 'Filter 2', " +
          "use 'Remove soft roll-off' optimization option for correct high frequency reproduction"
      );
    }

    if (this.hasSoftRollDac) {
      console.info(
        'Model has DAC with high frequency soft roll - ' +
          "use 'Remove soft roll-off' optimization option for correct high frequency reproduction"
      );
    }
  }

  toJSON() {
    return {
      targetModelName: this.targetModelName,
      modelSuffix: this.modelSuffix,
      hasExtendedFreq: this.hasExtendedFrequency,
      hasCirrusLogicDsp: this.hasCirrusLogicDsp,
      hasSwitchableDacFilter: this.hasSwitchableDacFilter,
      hasSoftRollDac: this.hasSoftRollDac,
      speedOfSound: this.speedOfSound,
      minDistAccuracy: this.minDistAccuracy,
      frequencyIndexes: this.frequencyIndexes,
      multEQType: this.multEQType,
      multEQSpecs: this.multEQSpecs,
      multEQDescription: this.multEQDescription,
    };
  }

  hasExtendedFreq() {
    return !this.isLegacyModel();
  }

  getFrequencyIndexes(hasExtendedFreq) {
    return hasExtendedFreq
      ? AvrCaracteristics.FREQUENCY_INDEXES.EXTENDED
      : AvrCaracteristics.FREQUENCY_INDEXES.BASE;
  }

  hasSoftRollDac() {
    return AvrCaracteristics.DAC_MODELS.SOFT_ROLL_IDENTIFIERS.some(identifier =>
      this.targetModelName.includes(identifier)
    );
  }

  hasSwitchableDacFilter() {
    return AvrCaracteristics.DAC_MODELS.SWITCHABLE_FILTER_MODELS.some(model =>
      this.targetModelName.includes(model)
    );
  }

  getSpeedOfSound() {
    return AvrCaracteristics.MODEL_LISTS.LEGACY_SPEED_OF_SOUND.includes(this.modelSuffix)
      ? AvrCaracteristics.SPEED_OF_SOUND.LEGACY
      : AvrCaracteristics.SPEED_OF_SOUND.DEFAULT;
  }

  getHasCirrusLogicDsp() {
    return AvrCaracteristics.MODEL_LISTS.CIRRUS_LOGIC_DSP.includes(this.modelSuffix);
  }

  isLegacyModel() {
    return AvrCaracteristics.MODEL_LISTS.LEGACY_MODELS.includes(this.modelSuffix);
  }

  getMinDistAccuracy() {
    const ACCURACY_FACTOR = 0.03;
    const DIVISION_FACTOR = 2;
    const result = ACCURACY_FACTOR / this.getSpeedOfSound() / DIVISION_FACTOR;
    return Number(result.toFixed(7));
  }
}

export default AvrCaracteristics;
