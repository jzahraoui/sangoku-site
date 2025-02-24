

export default class OCAFileGenerator {

  static SPEAKERS_LENGTH_BASIC = 128; // 128 taps
  static SUB_LENGTH_BASIC = 512; // 512 taps

  static SPEAKERS_LENGTH_XT = 512; // 512 taps
  static SUB_LENGTH_XT = 512; // 512 taps

  static SPEAKERS_LENGTH_XT32 = 16321; // converted to 1024 taps after odd mangling
  static SUB_LENGTH_XT32 = 16055; // converted to 704 taps after odd mangling

  static SPEAKERS_FILTER_TAPS_BASIC = 128;
  static SUB_FILTER_TAPS_BASIC = 512;

  static SPEAKERS_FILTER_TAPS_XT = 512;
  static SUB_FILTER_TAPS_XT = 512;

  static SPEAKERS_FILTER_TAPS_XT32 = 1024;
  static SUB_FILTER_TAPS_XT32 = 704;

  static EQType_MultEQ = 0
  static EQType_MultEQXT = 1
  static EQType_MultEQXT32 = 2

  static FREQUENCY_48_KHZ = 48000;
  static FREQUENCY_6_KHZ = 6000;

  static GAIN_ADJUSTMENT_EXP = -0.44999998807907104;
  static GAIN_ADJUSTMENT_EXP_SOFT = -0.35;

  static GAIN_ADJUSTMENT = Math.pow(10, OCAFileGenerator.GAIN_ADJUSTMENT_EXP_SOFT);

  constructor(avrFileContent) {
    if (!avrFileContent) {
      throw new Error(`no avr file content provided`);
    }
    this.avrFileContent = avrFileContent;
    this.versionEvo = 'Sangoku_custom';
    this.tcName = '';
    this.bassFill = 0;
    this.softRoll = false;
    this.ocaTypeId = "OCAFILE";
    this.ocaVersion = 1;
    this.title = avrFileContent.title;
    this.model = avrFileContent.targetModelName;
    this.ifVersionMajor = 10;
    this.ifVersionMinor = 5;
    this.eqType = avrFileContent.enMultEQType;
    this.ampAssign = avrFileContent.enAmpAssignType;
    this.ampAssignBin = avrFileContent.ampAssignInfo;
    this.channels = [];
    this.enableDynamicEq = false;
    this.dynamicEqRefLevel = 0;
    this.enableDynamicVolume = false;
    this.dynamicVolumeSetting = 0;
    this.enableLowFrequencyContainment = false;
    this.lowFrequencyContainmentLevel = 3;
    this.numberOfSubwoofers = 1;
    this.subwooferOutput = "LFE";
    this.lpfForLFE = 250;
  }

  // Method to get data for saving
  toJSON() {
    return {
      versionEvo: this.versionEvo,
      tcName: this.tcName,
      bassFill: this.bassFill,
      softRoll: this.softRoll,
      ocaTypeId: this.ocaTypeId,
      ocaVersion: this.ocaVersion,
      title: this.title,
      model: this.model,
      ifVersionMajor: this.ifVersionMajor,
      ifVersionMinor: this.ifVersionMinor,
      eqType: this.eqType,
      ampAssign: this.ampAssign,
      ampAssignBin: this.ampAssignBin,
      channels: this.channels,
      enableDynamicEq: this.enableDynamicEq,
      dynamicEqRefLevel: this.dynamicEqRefLevel,
      enableDynamicVolume: this.enableDynamicVolume,
      dynamicVolumeSetting: this.dynamicVolumeSetting,
      enableLowFrequencyContainment: this.enableLowFrequencyContainment,
      lowFrequencyContainmentLevel: this.lowFrequencyContainmentLevel,
      numberOfSubwoofers: this.numberOfSubwoofers,
      subwooferOutput: this.subwooferOutput,
      lpfForLFE: this.lpfForLFE
    };
  }


  async createOCAFile(allResponses) {

    this.channels = await this.createsFilters(allResponses);
    const jsonData = JSON.stringify(this.toJSON(), null, 2);
    return jsonData;

  }

  async createsFilters(allResponses) {

    if (!allResponses) {
      throw new Error(`Cannot retreive REW measurements`);
    }

    if (Object.values(allResponses).length === 0) {
      throw new Error(`No REW measurements found`);
    }

    if (this.avrFileContent.detectedChannels.length !== allResponses.length) {
      const expectedChannels = this.avrFileContent.detectedChannels
        .map(expected => expected.commandId);
      const providedChannels = allResponses.map(item => item.channelName())
      console.debug(`Expected channels: ${JSON.stringify(expectedChannels)}`);
      console.debug(`Provided channels: ${JSON.stringify(providedChannels)}`);
      // print channels that are missing
      const missingChannels = expectedChannels
        .filter(channel => !providedChannels.includes(channel));
      throw new Error(`${missingChannels.length} channel(s) are missing or added, please ensure all AVR detected channels are present in REW,
        missing are: ${missingChannels.join(', ')}`);
    }

    const channels = [];

    // creates a for loop on dataArray
    for (const item of Object.values(allResponses)) {

      // skip if item is not an object and not have timeOfIRStartSeconds attribute
      if (!item ||
        typeof item !== 'object' ||
        !Object.prototype.hasOwnProperty.call(item, 'distanceInMeters')) {
        throw new Error("rensponses must contains extended values");
      }

      if (item.splIsAboveLimit()) {
        throw new Error(`${item.displayMeasurementTitle()} spl ${item.splForAvr()}dB is above limit`);
      }

      if (item.exceedsDistance() === 'error') {
        throw new Error(`${item.displayMeasurementTitle()} distance ${item.distanceInMeters()}M is above limit`);
      }

      let itemFilter;
      try {
        //const itemMinimumPhase =  await item.createMinimumPhaseCopy();
        itemFilter = await item.generateFilterMeasurement();
        const filterLength = this.getFilterLength(item);
        const getFilterFrequency = this.getFilterFreq(item);
        const filter = await this.computeFilterGeneration(itemFilter, filterLength, getFilterFrequency, item.inverted());

        const channelItem = {
          channelType: item.channelDetails().channelIndex,
          speakerType: item.speakerType(),
          distanceInMeters: item.distanceInMeters(),
          trimAdjustmentInDbs: item.splForAvr(),
          filter: filter,
          ...(item.crossover() !== 0 && { xover: item.crossover() })
        };

        channels.push(channelItem);

      } catch (error) {
        throw new Error(error.message);
      } finally {
        await itemFilter.delete();
      }
    }
    return channels;
  }

  async computeFilterGeneration(filterItem, sampleCount, freq, invert) {

    try {
      if (!filterItem.isFilter) {
        throw new Error(`${filterItem.displayMeasurementTitle()} is not a filter`);
      }

      if (!filterItem.haveImpulseResponse) {
        return;
      }

      if (!sampleCount || !Number.isFinite(sampleCount)) {
        throw new Error(`Invalid sample count: ${sampleCount}`);
      }
      if (!freq || !Number.isFinite(freq)) {
        throw new Error(`Invalid frequency: ${freq}`);
      }
      const rightWindowWidthRaw = (sampleCount - 1) * 1000 / freq;
      const rightWindowWidth = this.cleanFloat32Value(rightWindowWidthRaw);

      await filterItem.setIrWindows(
        {
          leftWindowType: "Rectangular",
          rightWindowType: "Rectangular",
          leftWindowWidthms: "0",
          rightWindowWidthms: rightWindowWidth,
          refTimems: "0",
          addFDW: false,
          addMTW: false
        });

      // makes sure the filter was not inverted by user
      await filterItem.setInverted(false);
      let trimmedFilter = null;
      let filterImpulseResponse = null;
      let filter = null;

      try {
        trimmedFilter = await filterItem.genericCommand("Trim IR to windows");
        filterImpulseResponse = await trimmedFilter.getImpulseResponse(freq);

        filter = this.transformIR(filterImpulseResponse, sampleCount, invert);
      } finally {
        if (trimmedFilter) {
          await trimmedFilter.delete();
        }
      }

      return filter;
    } catch (error) {
      throw new Error(`Filter generation failed: ${error.message}`);
    }
  }

  transformIR(filterImpulseResponse, sampleCount, invert = false) {

    if (!filterImpulseResponse?.length || !Array.isArray(filterImpulseResponse)) {
      throw new Error('Invalid impulse response data');
    }
    if (!Number.isFinite(sampleCount) || sampleCount !== filterImpulseResponse.length) {
      throw new Error(`Sample count mismatch: expected ${sampleCount}, got ${filterImpulseResponse.length}`);
    }

    const operands = new Float32Array([
      OCAFileGenerator.GAIN_ADJUSTMENT,
      invert ? -1 : 1,
      0
    ]);

    // multiply each impulse response value by gain adjustment and inversion factor
    return filterImpulseResponse.map((value) => {
      operands[2] = value;
      return this.cleanFloat32Value(operands[0] * operands[1] * operands[2]);
    });
  }

  cleanFloat32Value(value, precision = 7) {
    // Use toFixed for direct string conversion to desired precision
    // Then convert back to number for consistent output
    return Number(value.toFixed(precision));
  }

  /**
   * Get the filter length based on the EQ type.
   * @returns {number} The filter length.
   */
  getFilterLength(item) {
    if (!item.haveImpulseResponse) {
      return;
    }
    if (!this.eqType) {
      throw new Error(`Invalid EQ type: ${this.eqType}`);
    }

    switch (this.eqType) {
      case OCAFileGenerator.EQType_MultEQ:
        return item.isSub() ? OCAFileGenerator.SUB_LENGTH_BASIC : OCAFileGenerator.SPEAKERS_LENGTH_BASIC;
      case OCAFileGenerator.EQType_MultEQXT:
        return item.isSub() ? OCAFileGenerator.SUB_LENGTH_XT : OCAFileGenerator.SPEAKERS_LENGTH_XT;
      case OCAFileGenerator.EQType_MultEQXT32:
        return item.isSub() ? OCAFileGenerator.SUB_LENGTH_XT32 : OCAFileGenerator.SPEAKERS_LENGTH_XT32;
      default:
        throw new Error(`Invalid EQ type: ${this.eqType}`);
    }
  }

  getFilterFreq(item) {
    if (!item.haveImpulseResponse) {
      return;
    }
    if (!this.eqType) {
      throw new Error(`Invalid EQ type: ${this.eqType}`);
    }

    switch (this.eqType) {
      case OCAFileGenerator.EQType_MultEQ:
        return item.isSub() ? OCAFileGenerator.FREQUENCY_48_KHZ : OCAFileGenerator.FREQUENCY_6_KHZ;
      case OCAFileGenerator.EQType_MultEQXT:
        return item.isSub() ? OCAFileGenerator.FREQUENCY_48_KHZ : OCAFileGenerator.FREQUENCY_6_KHZ;
      case OCAFileGenerator.EQType_MultEQXT32:
        return OCAFileGenerator.FREQUENCY_48_KHZ;
      default:
        throw new Error(`Invalid EQ type: ${this.eqType}`);
    }
  }
}
