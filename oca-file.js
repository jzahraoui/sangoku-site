

export default class OCAFileGenerator {
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

      try {
        //const itemMinimumPhase =  await item.createMinimumPhaseCopy();
        const itemFilter = await item.getAssociatedFilterItem();
        const filterLength = await item.getFilterLength(this.eqType);
        const getFilterFrequency = await item.getFilterFreq(this.eqType);
        const filter = await itemFilter.computeFilterGeneration(filterLength, getFilterFrequency, item.inverted());

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
      }
    }
    return channels;
  }

}
