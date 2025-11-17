import { CHANNEL_TYPES } from './audyssey.js';
import ampAssignType from './amp-type.js';

export default class OCAFileGenerator {
  static GAIN_ADJUSTMENT_EXP = -0.44999998807907104;
  static GAIN_ADJUSTMENT_EXP_SOFT = -0.35;

  static GAIN_ADJUSTMENT = Math.pow(10, OCAFileGenerator.GAIN_ADJUSTMENT_EXP_SOFT);

  constructor(avrFileContent) {
    if (!avrFileContent) {
      throw new Error(`no avr file content provided`);
    }
    this.fileFormat = 'odd';
    this.avrFileContent = avrFileContent;
    this.versionEvo = 'Sangoku_custom';
    this.tcName = '';
    this.bassFill = 0;
    this.softRoll = false;
    this.ocaTypeId = 'OCAFILE';
    this.ocaVersion = 1;
    this.ifVersionMajor = 10;
    this.ifVersionMinor = 5;
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
      model: this.avrFileContent.targetModelName,
      eqType: this.avrFileContent.enMultEQType,
      ...(this.fileFormat === 'odd' && {
        versionEvo: this.versionEvo,
        tcName: this.tcName,
        bassFill: this.bassFill,
        softRoll: this.softRoll,
        ocaTypeId: this.ocaTypeId,
        ocaVersion: this.ocaVersion,
        title: this.avrFileContent.title,
        ifVersionMajor: this.ifVersionMajor,
        ifVersionMinor: this.ifVersionMinor,
        ampAssign: this.avrFileContent.enAmpAssignType,
        ampAssignBin: this.avrFileContent.ampAssignInfo,
        enableDynamicEq: this.enableDynamicEq,
        dynamicEqRefLevel: this.dynamicEqRefLevel,
        enableDynamicVolume: this.enableDynamicVolume,
        dynamicVolumeSetting: this.dynamicVolumeSetting,
        enableLowFrequencyContainment: this.enableLowFrequencyContainment,
        lowFrequencyContainmentLevel: this.lowFrequencyContainmentLevel,
        subwooferOutput: this.subwooferOutput,
      }),
      ...(this.fileFormat === 'a1' && {
        A1EvoAcoustica: '0.0.11',
        hasGriffinLiteDSP: this.avrFileContent.avr.isGriffinLiteAVR,
        isNewModel: !this.avrFileContent.avr.isOldModelForDistanceConversion,
        ampAssign: ampAssignType.getByIndex(this.avrFileContent.enAmpAssignType),
        ampAssignInfo: this.avrFileContent.ampAssignInfo,
        bassMode: this.subwooferOutput,
      }),
      channels: this.channels,
      numberOfSubwoofers: this.numberOfSubwoofers,
      lpfForLFE: this.lpfForLFE,
    };
  }

  async createOCAFile(allResponses) {
    this.channels = await this.createsFilters(allResponses);
    const jsonData = JSON.stringify(this.toJSON(), null, 2);
    return jsonData;
  }

  async createsFilters(allResponses) {
    if (!allResponses || Object.values(allResponses).length === 0) {
      throw new Error('Cannot retreive REW measurements');
    }

    this._validateChannels(allResponses);
    this._validateCrossoverConsistency(allResponses);
    this._validateMeasurementLimits(allResponses);

    const channels = [];
    // creates a for loop on dataArray
    for (const item of Object.values(allResponses)) {
      // skip if item is not an object and not have timeOfIRStartSeconds attribute
      if (!item.haveImpulseResponse) {
        throw new Error('rensponses must contains extended values');
      }

      let itemFilter;
      try {
        itemFilter = await item.generateFilterMeasurement();
        const filterCaracteristics = item.isSub()
          ? this.avrFileContent.avr.multEQSpecs.subFilter
          : this.avrFileContent.avr.multEQSpecs.speakerFilter;

        const filter = await this.computeFilterGeneration(
          itemFilter,
          filterCaracteristics.samples,
          filterCaracteristics.frequency,
          item.inverted()
        );

        channels.push({
          channelType: item.channelDetails().channelIndex,
          speakerType: item.speakerType(),
          distanceInMeters: item.distanceInMeters(),
          trimAdjustmentInDbs: item.splForAvr(),
          filter: filter,
          ...(this.fileFormat === 'a1' && {
            filterLV: filter,
            commandId: item.channelName(),
          }),
          ...(item.crossover() !== 0 && { xover: item.crossover() }),
        });
      } catch (error) {
        throw new Error(`Creates filters failed: ${error.message}`, { cause: error });
      } finally {
        await itemFilter.delete();
      }
    }
    return channels;
  }

  _validateChannels(allResponses) {
    const expectedChannels = this.avrFileContent.detectedChannels.map(
      ch => ch.enChannelType
    );
    const providedChannels = new Set(
      allResponses.map(item => item.channelDetails()?.channelIndex)
    );
    const missingChannels = expectedChannels.filter(ch => !providedChannels.has(ch));

    if (missingChannels.length) {
      const codesLabels = missingChannels.map(channel => {
        const missingChannel = CHANNEL_TYPES.getByChannelIndex(channel);
        return missingChannel ? missingChannel.code : channel;
      });
      throw new Error(
        `${
          missingChannels.length
        } channel(s) are missing or added, please ensure all AVR detected channels are present in REW, missing are: ${codesLabels.join(
          ', '
        )}`
      );
    }
  }

  _validateCrossoverConsistency(allResponses) {
    const groupedResponses = allResponses.reduce((acc, item) => {
      const group = item.channelDetails().group;
      if (!acc[group]) {
        acc[group] = [];
      }
      acc[group].push(item);
      return acc;
    }, {});

    for (const [group, items] of Object.entries(groupedResponses)) {
      // Skip crossover check for Subwoofer group
      if (group === 'Subwoofer' || !items?.length) continue;

      const crossover = items[0].crossover();
      if (items.some(item => item.crossover() !== crossover)) {
        throw new Error(
          `Crossover value is different for items in group ${group}, please ensure all REW measurements have the same crossover value`
        );
      }
    }
  }

  _validateMeasurementLimits(allResponses) {
    const itemAboveLimit = allResponses.find(item => item.splIsAboveLimit());
    if (itemAboveLimit) {
      throw new Error(
        `${itemAboveLimit.displayMeasurementTitle()} spl ${itemAboveLimit.splForAvr()}dB is above limit`
      );
    }

    const itemExceedsDistance = allResponses.find(
      item => item.exceedsDistance() === 'error'
    );
    if (itemExceedsDistance) {
      throw new Error(
        `${itemExceedsDistance.displayMeasurementTitle()} distance ${itemExceedsDistance.distanceInMeters()}M exceeds limit`
      );
    }

    if (
      allResponses.some(item => item.crossover() === 180) &&
      !this.avrFileContent.avr.hasExtendedFreq
    ) {
      throw new Error('180Hz crossover is not supported by your AVR');
    }
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
        filterImpulseResponse = await trimmedFilter.getImpulseResponse(
          freq,
          'percent',
          true,
          true
        );

        // first value must be 1
        if (filterImpulseResponse[0] <= 0.9) {
          throw new Error(
            `Unexpected impulse response start value: ${
              filterImpulseResponse[0]
            } for ${filterItem.displayMeasurementTitle()}`
          );
        }

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
