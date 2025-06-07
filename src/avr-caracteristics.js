class AvrCaracteristics {
  // Constants
  static SPEED_OF_SOUND = {
    LEGACY: 300,
    DEFAULT: 343,
  };

  static DAC_MODELS = Object.freeze({
    SOFT_ROLL_IDENTIFIERS: ['NR', 'SR', 'AV7', 'AV8', 'AV1', 'CINEMA'],
    SWITCHABLE_FILTER_MODELS: ['AV10', 'CINEMA 30'],
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

  // Static set of models that use Cirrus DSP
  static GRIFFIN_LITE_MODEL_PREFIXES = [
    'Denon AVR-X8500H',
    'Denon AVC-X8500H',
    'Marantz AV8805',
    'Denon AVR-A110',
    'Denon AVC-A110',
    'Denon AVR-X6700H',
    'Denon AVC-X6700H',
    'Denon AVR-X4700H',
    'Denon AVC-X4700H',
    'Marantz AV7706',
    'Marantz SR8015',
    'Marantz SR7015',
    'Marantz AV 10',
    'Denon AVR-A1H',
    'Denon AVC-A1H',
    'Denon AVR-X3800H',
    'Denon AVC-X3800H',
    'Denon AVR-X4800H',
    'Denon AVC-X4800H',
    'Marantz CINEMA 50',
    'Marantz CINEMA 40',
    'Denon AVR-X6800H',
    'Denon AVC-X6800H',
    'Marantz CINEMA 30',
    'Denon AVR-A10H',
    'Denon AVC-A10H',
  ];

  static FOUR_SUBWOOFER_MODELS = new Set([
    'Marantz AV 10',
    'Denon AVR-A1H',
    'Denon AVC-A1H',
    'Denon AVR-X3800H',
    'Denon AVC-X3800H',
    'Denon AVR-X4800H',
    'Denon AVC-X4800H',
    'Marantz CINEMA 50',
    'Marantz CINEMA 40',
    'Denon AVC-X6800H',
    'Denon AVR-X6800H',
    'Marantz CINEMA 30',
    'Denon AVR-A10H',
    'Denon AVC-A10H',
  ]);

  static NO_ZONE2_PREOUT_MODELS = new Set([
    'Denon AVR-S960H',
    'Denon AVR-S760H',
    'Denon AVR-X1700H',
    'AVR-S970H',
  ]);

  static CIRRUS_DSP_MODELS = new Set([
    'Marantz SR6013',
    'Marantz SR6014',
    'Denon AVR-X3400H',
    'Denon AVR-X3500H',
    'Denon AVR-X3600H',
    'Marantz SR5013',
    'Marantz SR5014',
    'Marantz NR1608',
    'Marantz NR1609',
    'Denon AVR-X2400H',
    'Denon AVR-X2500H',
    'Denon AVR-X2600H',
    'Denon AVR-S930H',
    'Denon AVR-S940H',
    'Denon AVR-S950H',
    'Denon AVR-X1400H',
    'Denon AVR-X1500H',
    'Denon AVR-X1600H',
    'Denon AVR-S730H',
    'Denon AVR-S740H',
    'Denon AVR-S750H',
    'Marantz NR1710',
    'Marantz SR5012',
    '*AVR-S720W',
    '*AVR-S920W',
    '*AVR-X1300W',
    '*AVR-X2300W',
    '*AVR-X3300W',
    '*NR1607',
    '*SR5011',
    'Denon AVR-S960H',
    'Denon AVR-X2700H',
    'Marantz SR5015',
    'Marantz NR1711',
    'Denon AVR-S760H',
    'Denon AVR-X1700H',
    'Denon AVR-S970H',
    'Denon AVR-X2800H',
    'Marantz CINEMA 70s',
    'Marantz CINEMA 60',
    'Denon AVR-S770H',
    'Denon AVR-X1800H',
  ]);

  static FY20_MODELS = new Set([
    'Denon AVR-S750H',
    'Denon AVR-S950H',
    'Denon AVR-X1600H',
    'Denon AVR-X2600H',
    'Denon AVR-X3600H',
    'Marantz NR1710',
    'Marantz SR5014',
    'Marantz SR6014',
  ]);

  static FY21_MODELS = new Set([
    'Denon AVR-S960H',
    'Denon AVR-X2700H',
    'Denon AVR-X3700H',
    'Denon AVC-X3700H',
    'Denon AVR-X4700H',
    'Denon AVC-X4700H',
    'Denon AVR-X6700H',
    'Denon AVC-X6700H',
    'Marantz NR1711',
    'Marantz SR5015',
    'Marantz SR6015',
    'Marantz SR7015',
    'Marantz SR8015',
    'Marantz AV7706',
  ]);

  static FY21_FLAGSHIP_MODELS = new Set([
    'Denon AVR-X8500H',
    'Denon AVC-X8500H',
    'Marantz AV8805',
    'Denon AVR-A110',
    'Denon AVC-A110',
    'Denon AVR-X8500HA',
    'Denon AVC-X8500HA',
    'Marantz AV8805A',
  ]);

  static FY22_MODELS = new Set(['Denon AVR-S760H', 'Denon AVR-X1700H']);

  static FY23_MODELS = new Set([
    'Denon AVR-S970H',
    'Denon AVR-X2800H',
    'Denon AVR-X3800H',
    'Denon AVC-X3800H',
    'Denon AVR-X4800H',
    'Denon AVC-X4800H',
    'Marantz CINEMA 70s',
    'Marantz CINEMA 60',
    'Marantz CINEMA 50',
    'Marantz CINEMA 40',
  ]);

  static FY2023_FLAGSHIP_MODELS = new Set([
    'Marantz AV 10',
    'Denon AVR-A1H',
    'Denon AVC-A1H',
  ]);

  static CY2023_MODELS = new Set([
    'Denon AVR-S770H',
    'Denon AVR-X1800H',
    'Denon AVC-X6800H',
    'Denon AVR-X6800H',
    'Marantz CINEMA 30',
  ]);

  static CY2024_MODELS = new Set(['Denon AVR-A10H', 'Denon AVC-A10H']);

  static OLD_MODEL_DISTANCE_CONVERSION = new Set([
    '*AVR-S720W',
    '*AVR-S920W',
    '*AVR-X1300W',
    '*AVR-X2300W',
    '*AVR-X3300W',
    '*NR1607',
    '*SR5011',
    '*SR6011',
    'Denon AVC-A110',
    'Denon AVC-X3700H',
    'Denon AVC-X4700H',
    'Denon AVC-X6500H',
    'Denon AVC-X6700H',
    'Denon AVC-X8500H',
    'Denon AVR-A110',
    'Denon AVR-S730H',
    'Denon AVR-S740H',
    'Denon AVR-S750H',
    'Denon AVR-S760H',
    'Denon AVR-S930H',
    'Denon AVR-S940H',
    'Denon AVR-S950H',
    'Denon AVR-S960H',
    'Denon AVR-X1400H',
    'Denon AVR-X1500H',
    'Denon AVR-X1600H',
    'Denon AVR-X1700H',
    'Denon AVR-X2400H',
    'Denon AVR-X2500H',
    'Denon AVR-X2600H',
    'Denon AVR-X2700H',
    'Denon AVR-X3400H',
    'Denon AVR-X3500H',
    'Denon AVR-X3600H',
    'Denon AVR-X3700H',
    'Denon AVR-X4300H',
    'Denon AVR-X4400H',
    'Denon AVR-X4500H',
    'Denon AVR-X4700H',
    'Denon AVR-X6300H',
    'Denon AVR-X6400H',
    'Denon AVR-X6500H',
    'Denon AVR-X6700H',
    'Denon AVR-X8500H',
    'Marantz AV7703',
    'Marantz AV7704',
    'Marantz AV7705',
    'Marantz AV7706',
    'Marantz AV8805',
    'Marantz NR1608',
    'Marantz NR1609',
    'Marantz NR1710',
    'Marantz NR1711',
    'Marantz SR5012',
    'Marantz SR5013',
    'Marantz SR5014',
    'Marantz SR5015',
    'Marantz SR6012',
    'Marantz SR6013',
    'Marantz SR6014',
    'Marantz SR6015',
    'Marantz SR7011',
    'Marantz SR7012',
    'Marantz SR7013',
    'Marantz SR7015',
    'Marantz SR8012',
    'Marantz SR8015',
  ]);

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
    this.hasExtendedFrequency = this.hasExtendedFreq(this.targetModelName);
    this.hasCirrusLogicDsp = this.getHasCirrusLogicDsp(this.targetModelName);
    this.hasSwitchableDacFilter = this.hasSwitchableDacFilter();
    this.hasSoftRollDac = this.hasSoftRollDac();
    this.speedOfSound = this.getSpeedOfSound();
    this.minDistAccuracy = this.getMinDistAccuracy();
    this.frequencyIndexes = this.getFrequencyIndexes(this.targetModelName);
    this.lfeFrequencies = this.getLfeFrequencies(this.targetModelName);
    this.multEQDetails = this.configureMultEQ();
    this.multEQType = this.multEQDetails.name;
    this.multEQSpecs = this.multEQDetails.specs;
    this.multEQDescription = AvrCaracteristics.getDescription(this.multEQType);
    this.isFourSubwooferModel = this.isFourSubwooferModel(this.targetModelName);
  }

  /**
   * Validates model configuration
   * @throws {Error} If model configuration is invalid
   * @private
   */
  validateModelConfig() {
    if (
      !this.isFY20AboveAVR(this.targetModelName) &&
      !this.isOldModelForDistanceConversion(this.targetModelName)
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
      lfeFrequencies: this.lfeFrequencies,
      multEQType: this.multEQType,
      multEQSpecs: this.multEQSpecs,
      multEQDescription: this.multEQDescription,
      isFourSubwooferModel: this.isFourSubwooferModel,
    };
  }

  // Helper function to check if model supports additional frequencies
  hasExtendedFreq(modelName) {
    return this.isFY20AboveAVR(modelName);
  }

  getFrequencyIndexes(modelName) {
    const frequencies = [];

    // Add standard frequencies
    frequencies.push({ value: 0, text: 'N/A' });
    frequencies.push({ value: 40, text: '40Hz' });
    frequencies.push({ value: 60, text: '60Hz' });
    frequencies.push({ value: 80, text: '80Hz' });
    frequencies.push({ value: 90, text: '90Hz' });
    frequencies.push({ value: 100, text: '100Hz' });
    frequencies.push({ value: 110, text: '110Hz' });
    frequencies.push({ value: 120, text: '120Hz' });
    frequencies.push({ value: 150, text: '150Hz' });

    // Check if we need to add 180Hz option based on model type
    if (modelName && this.hasExtendedFreq(modelName)) {
      frequencies.push({ value: 180, text: '180Hz' });
    }

    // Add final frequencies
    frequencies.push({ value: 200, text: '200Hz' });
    frequencies.push({ value: 250, text: '250Hz' });

    return frequencies;
  }

  getLfeFrequencies(modelName) {
    const frequencies = this.getFrequencyIndexes(modelName);

    // remove the first 3 elements (0Hz, 40Hz, 60Hz)
    return frequencies.slice(3);
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
    return this.isOldModelForDistanceConversion(this.targetModelName)
      ? AvrCaracteristics.SPEED_OF_SOUND.LEGACY
      : AvrCaracteristics.SPEED_OF_SOUND.DEFAULT;
  }

  getHasCirrusLogicDsp(modelName) {
    if (!modelName) return false;
    return AvrCaracteristics.CIRRUS_DSP_MODELS.has(modelName);
  }

  isOldModelForDistanceConversion(modelName) {
    if (!modelName) return false;
    return AvrCaracteristics.OLD_MODEL_DISTANCE_CONVERSION.has(modelName);
  }

  getMinDistAccuracy() {
    const ACCURACY_FACTOR = 0.03;
    const DIVISION_FACTOR = 2;
    const result = ACCURACY_FACTOR / this.getSpeedOfSound() / DIVISION_FACTOR;
    return Number(result.toFixed(7));
  }

  /**
   * Checks if the model name corresponds to a Griffin Lite AVR
   * @param {string} modelName - The device model name to check
   * @returns {boolean} - True if the model is a Griffin Lite AVR, false otherwise
   */
  isGriffinLiteAVR(modelName) {
    if (!modelName) return false;

    for (const prefix of AvrCaracteristics.GRIFFIN_LITE_MODEL_PREFIXES) {
      if (modelName.startsWith(prefix)) return true;
    }

    return false;
  }

  /**
   * Determines if a model supports four subwoofers
   * @param {string} modelName - The model name to check
   * @returns {boolean} - True if the model supports four subwoofers
   */
  isFourSubwooferModel(modelName) {
    if (!modelName) return false;
    return AvrCaracteristics.FOUR_SUBWOOFER_MODELS.has(modelName);
  }

  /**
   * Determines if a model is FY20 or newer AVR
   * @param {string} modelName - The model name to check
   * @returns {boolean} - True if the model is FY20 or newer AVR
   */
  isFY20AboveAVR(modelName) {
    return (
      this.isFY20AVR(modelName) ||
      this.isFY21AVR(modelName) ||
      this.isFlagshipFY21(modelName) ||
      this.isFY22AVR(modelName) ||
      this.isFY23Model(modelName) ||
      this.isCY2023AVR(modelName) ||
      this.isFY23FlagshipAVR(modelName) ||
      this.isCY2024AVR(modelName)
    );
  }

  isFY20AVR(modelName) {
    if (!modelName) return false;
    return AvrCaracteristics.FY20_MODELS.has(modelName);
  }

  isFY21AVR(modelName) {
    if (!modelName) return false;
    return AvrCaracteristics.FY21_MODELS.has(modelName);
  }

  isFlagshipFY21(modelName) {
    if (!modelName) return false;
    return AvrCaracteristics.FY21_FLAGSHIP_MODELS.has(modelName);
  }

  isFY22AVR(modelName) {
    if (!modelName) return false;
    return AvrCaracteristics.FY22_MODELS.has(modelName);
  }

  isFY23Model(modelName) {
    if (!modelName) return false;
    return AvrCaracteristics.FY23_MODELS.has(modelName);
  }

  isCY2023AVR(modelName) {
    if (!modelName) return false;
    return AvrCaracteristics.CY2023_MODELS.has(modelName);
  }

  isFY23FlagshipAVR(modelName) {
    if (!modelName) return false;
    return AvrCaracteristics.FY2023_FLAGSHIP_MODELS.has(modelName);
  }

  isCY2024AVR(modelName) {
    if (!modelName) return false;
    return AvrCaracteristics.CY2024_MODELS.has(modelName);
  }

  isPreAmpModel(modelName) {
    if (!modelName) return false;
    return modelName.startsWith('Marantz AV');
  }

  isNoZone2PreOutAVR(modelName) {
    if (!modelName) return false;
    return AvrCaracteristics.NO_ZONE2_PREOUT_MODELS.has(modelName);
  }
}

export default AvrCaracteristics;
