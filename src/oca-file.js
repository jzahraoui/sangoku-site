import { CHANNEL_TYPES } from './audyssey.js';

export default class OCAFileGenerator {
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
    this.ocaTypeId = 'OCAFILE';
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
    this.subwooferOutput = 'LFE';
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
      lpfForLFE: this.lpfForLFE,
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

    const expectedChannels = this.avrFileContent.detectedChannels.map(
      expected => expected.enChannelType
    );
    const providedChannels = allResponses.map(
      item => item.channelDetails()?.channelIndex
    );

    const missingChannels = expectedChannels.filter(
      channel => !providedChannels.includes(channel)
    );

    if (missingChannels.length) {
      const codesLabels = missingChannels.map(channel => {
        const missingChannel = CHANNEL_TYPES.getByChannelIndex(channel);
        const missingCode = missingChannel ? missingChannel.code : channel;
        return missingCode;
      });
      throw new Error(`${missingChannels.length} channel(s) are missing or added, please ensure all AVR detected channels are present in REW,
        missing are: ${codesLabels.join(', ')}`);
    }

    // group allResponses by item.channelDetails().group and check if they have the same crossover value
    const groupedResponses = allResponses.reduce((acc, item) => {
      const group = item.channelDetails().group;
      if (!acc[group]) {
        acc[group] = [];
      }
      acc[group].push(item);
      return acc;
    }, {});
    for (const group in groupedResponses) {
      const items = groupedResponses[group];
      if (!items || items.length === 0) {
        continue; // Skip empty groups
      }
      // Skip crossover check for Subwoofer group
      if (group === 'Subwoofer') {
        continue;
      }
      const crossover = items[0].crossover();
      if (items.some(item => item.crossover() !== crossover)) {
        throw new Error(
          `Crossover value is different for items in group ${group}, please ensure all REW measurements have the same crossover value`
        );
      }
    }

    const channels = [];

    // check if any of the items is above limit
    const anyItemAboveLimit = allResponses.some(item => item.splIsAboveLimit());
    if (anyItemAboveLimit) {
      // Find the specific item that is above limit to display correct information
      const itemAboveLimit = allResponses.find(item => item.splIsAboveLimit());
      throw new Error(
        `${itemAboveLimit.displayMeasurementTitle()} spl ${itemAboveLimit.splForAvr()}dB is above limit`
      );
    }

    const anyItemExceedsDistance = allResponses.some(
      item => item.exceedsDistance() === 'error'
    );
    if (anyItemExceedsDistance) {
      const itemExceedsDistance = allResponses.find(
        item => item.exceedsDistance() === 'error'
      );
      throw new Error(
        `${itemExceedsDistance.displayMeasurementTitle()} distance ${itemExceedsDistance.distanceInMeters()}M exceeds limit`
      );
    }

    // check if 180Hz crossover is used into allResponses item
    const anyItemHas180HzCrossover = allResponses.some(item => item.crossover() === 180);
    if (anyItemHas180HzCrossover && !this.avrFileContent.avr.hasExtendedFreq) {
      throw new Error(`180Hz crossover is not supported by your AVR`);
    }

    // creates a for loop on dataArray
    for (const item of Object.values(allResponses)) {
      // skip if item is not an object and not have timeOfIRStartSeconds attribute
      if (
        !item ||
        typeof item !== 'object' ||
        !Object.hasOwn(item, 'distanceInMeters')
      ) {
        throw new Error('rensponses must contains extended values');
      }

      let itemFilter;
      try {
        itemFilter = await item.generateFilterMeasurement();
        let filterCaracteristics;
        if (item.isSub()) {
          filterCaracteristics = this.avrFileContent.avr.multEQSpecs.subFilter;
        } else {
          filterCaracteristics = this.avrFileContent.avr.multEQSpecs.speakerFilter;
        }
        const filterLength = filterCaracteristics.samples;
        const getFilterFrequency = filterCaracteristics.frequency;
        const filter = await this.computeFilterGeneration(
          itemFilter,
          filterLength,
          getFilterFrequency,
          item.inverted()
        );

        const channelItem = {
          channelType: item.channelDetails().channelIndex,
          speakerType: item.speakerType(),
          distanceInMeters: item.distanceInMeters(),
          trimAdjustmentInDbs: item.splForAvr(),
          filter: filter,
          ...(item.crossover() !== 0 && { xover: item.crossover() }),
        };

        channels.push(channelItem);
      } catch (error) {
        throw new Error(`Creates filters failed: ${error.message}`, { cause: error });
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
      const rightWindowWidthRaw = ((sampleCount - 1) * 1000) / freq;
      const rightWindowWidth = this.cleanFloat32Value(rightWindowWidthRaw);

      // Blackman window tested. Provide worse ETC graph.
      // moving IR to center of the window is totally worse because of mangling the IR by odd
      await filterItem.setIrWindows({
        leftWindowType: 'Rectangular',
        rightWindowType: 'Rectangular',
        leftWindowWidthms: '0',
        rightWindowWidthms: rightWindowWidth,
        refTimems: '0',
        addFDW: false,
        addMTW: false,
      });

      // makes sure the filter was not inverted by user
      await filterItem.setInverted(false);
      let trimmedFilter = null;
      let filterImpulseResponse = null;
      let filter = null;

      try {
        trimmedFilter = await filterItem.genericCommand('Trim IR to windows');
        filterImpulseResponse = await trimmedFilter.getImpulseResponse(freq);

        filter = this.transformIR(filterImpulseResponse, sampleCount, invert);
      } finally {
        if (trimmedFilter) {
          await trimmedFilter.delete();
        }
      }

      return filter;
    } catch (error) {
      throw new Error(`Filter generation failed: ${error.message}`, { cause: error });
    }
  }

  transformIR(filterImpulseResponse, sampleCount, invert = false) {
    if (!filterImpulseResponse?.length || !Array.isArray(filterImpulseResponse)) {
      throw new Error('Invalid impulse response data');
    }
    if (!Number.isFinite(sampleCount) || sampleCount !== filterImpulseResponse.length) {
      throw new Error(
        `Sample count mismatch: expected ${sampleCount}, got ${filterImpulseResponse.length}`
      );
    }

    const operands = new Float32Array([
      OCAFileGenerator.GAIN_ADJUSTMENT,
      invert ? -1 : 1,
      0,
    ]);

    // multiply each impulse response value by gain adjustment and inversion factor
    return filterImpulseResponse.map(value => {
      operands[2] = value;
      return this.cleanFloat32Value(operands[0] * operands[1] * operands[2]);
    });
  }

  cleanFloat32Value(value, precision = 7) {
    // Use toFixed for direct string conversion to desired precision
    // Then convert back to number for consistent output
    return Number(value.toFixed(precision));
  }
}
