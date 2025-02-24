import { CHANNEL_TYPES } from './audyssey.js';
import './lib/decimal.min.js';

class MeasurementItem {
  static AVR_MAX_GAIN = 12;
  static DEFAULT_SHIFT_IN_METERS = 2.58;
  static SPEED_OF_SOUND = 343;
  static MODEL_DISTANCE_LIMIT = 6.0;
  static MODEL_DISTANCE_CRITICAL_LIMIT = 7.35;

  static SPEAKERS_LENGTH_BASIC = 128; // 128 taps
  static SUB_LENGTH_BASIC = 512; // 512 taps

  static SPEAKERS_LENGTH_XT = 512; // 512 taps
  static SUB_LENGTH_XT = 512; // 512 taps

  static SPEAKERS_LENGTH_XT32 = 16321; // 1024 taps
  static SUB_LENGTH_XT32 = 16055; // 704 taps

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

  static GAIN_ADJUSTMENT = Math.pow(10, MeasurementItem.GAIN_ADJUSTMENT_EXP_SOFT);

  static measurementType = { SPEAKERS: 0, SUB: 1, FILTER: 2, AVERAGE: 3 }

  constructor(item, parentViewModel) {
    const self = this;
    // Validate inputs
    if (!item || !parentViewModel) {
      throw new Error('Invalid parameters for MeasurementItem creation');
    }

    self.parentViewModel = parentViewModel;
    // Original data
    self.title = ko.observable(item.title);
    self.notes = item.notes;
    self.date = item.date;
    self.uuid = item.uuid;
    self.startFreq = item.startFreq;
    self.endFreq = item.endFreq;
    self.inverted = ko.observable(item.inverted);
    self.rewVersion = item.rewVersion;
    self.splOffsetdB = ko.observable(item.splOffsetdB);
    self.alignSPLOffsetdB = ko.observable(item.alignSPLOffsetdB);
    self.cumulativeIRShiftSeconds = ko.observable(item.cumulativeIRShiftSeconds);
    self.clockAdjustmentPPM = item.clockAdjustmentPPM;
    self.timeOfIRStartSeconds = item.timeOfIRStartSeconds;
    self.timeOfIRPeakSeconds = item.timeOfIRPeakSeconds;
    self.haveImpulseResponse = Object.prototype.hasOwnProperty.call(item, 'cumulativeIRShiftSeconds');
    self.isFilter = item.isFilter || false;
    self.associatedFilter = item.associatedFilter;
    self.measurementType = MeasurementItem.measurementType.SPEAKERS;

    // store value on object creation and make it immuable
    // TODO if not retreived from saved data the newly created reference can be false
    self.initialSplOffsetdB = item.initialSplOffsetdB || item.splOffsetdB - item.alignSPLOffsetdB;

    // restore saved data
    const isSW = item.title.startsWith('SW');
    const defaultCrossover = (isSW ? 0 : item.crossover || self.parentViewModel.DEFAULT_CROSSOVER_VALUE);
    const defaultSpeakerType = (isSW ? 'E' : item.speakerType || 'S');

    // Observable properties
    self.crossover = ko.observable(defaultCrossover);
    self.speakerType = ko.observable(defaultSpeakerType);
    self.filters = ko.observableArray([]);
    self.isSub = ko.observable(isSW);

    // Computed properties
    self.channelName = ko.computed(() => CHANNEL_TYPES.getBestMatchCode(self.title()) || self.parentViewModel.UNKNOWN_GROUP_NAME);
    self.channelDetails = ko.computed(() => CHANNEL_TYPES.getByCode(self.channelName()));


    self.position = ko.computed(() => {
      const groupedMeasurements = self.parentViewModel.groupedMeasurements();
      const channelName = self.channelName();

      if (!groupedMeasurements || !groupedMeasurements[channelName]) {
        return 0;
      }

      return groupedMeasurements[channelName].items.indexOf(self) + 1;
    });

    self.numberOfpositions = ko.computed(() => {
      const groupedMeasurements = self.parentViewModel.groupedMeasurements();
      const channelName = self.channelName();

      if (!groupedMeasurements || !groupedMeasurements[channelName]) {
        return 0;
      }

      return groupedMeasurements[channelName].count;
    });

    self.associatedFilterItem = ko.computed(() => self.parentViewModel.findMeasurementByUuid(this.associatedFilter));
    self.measurementIndex = ko.computed(() => self.parentViewModel.measurements().indexOf(self) + 1);
    self.relatedLfeMeasurement = ko.computed(function () {
      if (self.parentViewModel.uniqueSubsMeasurements().length === 1) {
        return self.parentViewModel.allPredictedLfeMeasurement().find(response =>
          response?.position() === self.position());
      } else {
        return self.parentViewModel.allPredictedLfeMeasurement().find(response =>
          response?.title() === self.parentViewModel.DEFAULT_LFE_PREDICTED + self.position());
      }
    });
    self.displayMeasurementTitle = ko.computed(() => `${self.measurementIndex()}: ${self.title()}`);
    self.displayPositionText = ko.computed(() => `P. ${self.position()}/${self.numberOfpositions()}`);
    self.distanceInMeters = ko.computed(() => self._computeDistanceInMeters(self.cumulativeIRShiftSeconds()));
    self.splOffsetDeltadB = ko.computed(() => (self.splOffsetdB() - self.alignSPLOffsetdB() - self.initialSplOffsetdB) + self.alignSPLOffsetdB());
    self.splForAvr = ko.computed(() => Math.round(self.splOffsetDeltadB() * 2) / 2);
    self.splIsAboveLimit = ko.computed(() => Math.abs(self.splForAvr()) > MeasurementItem.AVR_MAX_GAIN);
    self.splresidual = ko.computed(() => self.splOffsetDeltadB() - self.splForAvr());
    self.cumulativeIRDistanceMeters = ko.computed(() => self.parentViewModel.maxDdistanceInMeters() - self.distanceInMeters());
    self.cumulativeIRDistanceSeconds = ko.computed(() => self._computeInSeconds(self.cumulativeIRDistanceMeters()));
    self.isSelected = ko.computed(() => self.parentViewModel.currentSelectedPosition() === self.position());

    // Create a computed observable for the channel detection check
    self.isChannelDetected = ko.computed(function () {
      if (!self.parentViewModel.jsonAvrData() || !self.channelDetails()) {
        return false;
      }
      if (!self.isSelected()) {
        return false;
      }
      return self.parentViewModel
        .jsonAvrData().detectedChannels
        .some(m => m.enChannelType === self.channelDetails().channelIndex);
    });
    self.exceedsDistance = ko.computed(function () {
      // Check if parent view model exists
      if (!self.parentViewModel) {
        return 'normal';
      }

      var maxErrorDistance = self.parentViewModel.maxDistanceInMetersError();
      var maxWarningDistance = self.parentViewModel.maxDistanceInMetersWarning();
      var currentDistance = self.distanceInMeters();

      // Check for invalid values
      if (isNaN(maxErrorDistance) || isNaN(maxWarningDistance)) {
        return 'normal';
      }

      // Check error threshold first
      if (currentDistance > maxErrorDistance) {
        return 'error';
      }

      // Check warning threshold
      if (currentDistance > maxWarningDistance) {
        return 'warning';
      }

      return 'normal';
    }, this);
    self.hasErrors = ko.computed(() => self.splIsAboveLimit() || self.exceedsDistance() === 'error' || !self.isChannelDetected());

    // subscriptions
    self.speakerType.subscribe((newValue) => {
      if (self.isSub()) {
        return;
      } else if (newValue === 'S') {
        if (self.crossover() === 0) {
          self.crossover(self.parentViewModel.DEFAULT_CROSSOVER_VALUE); //default value
        }
      } else {
        self.crossover(0);
      }
    });

    self.crossover.subscribe((newValue) => {
      if (self.isSub()) {
        return;
      } else if (newValue === 0) {
        self.speakerType('L');
      } else {
        if (self.speakerType() === 'L') {
          self.speakerType('S');
        }
      }
    });

  }


  async refresh() {

    const item = await this.parentViewModel.apiService.fetchREW(this.uuid, 'GET', null, 0);

    if (!item) {
      throw new Error(`Failed to refresh ${this.displayMeasurementTitle()}`);
    }

    this.title(item.title);
    this.notes = item.notes;
    this.date = item.date;
    this.startFreq = item.startFreq;
    this.endFreq = item.endFreq;
    this.inverted(item.inverted);
    this.rewVersion = item.rewVersion;
    this.splOffsetdB(item.splOffsetdB);
    this.alignSPLOffsetdB(item.alignSPLOffsetdB);
    this.cumulativeIRShiftSeconds(item.cumulativeIRShiftSeconds);
    this.clockAdjustmentPPM = item.clockAdjustmentPPM;
    this.timeOfIRStartSeconds = item.timeOfIRStartSeconds;
    this.timeOfIRPeakSeconds = item.timeOfIRPeakSeconds;
  }

  // Compute methods
  _computeInMeters(valueInSeconds) {
    const failSafeValue = typeof valueInSeconds === 'number' && isFinite(valueInSeconds)
      ? valueInSeconds : 0;
    return failSafeValue * MeasurementItem.SPEED_OF_SOUND;
  }

  _computeInSeconds(valueInMeters) {
    const failSafeValue = typeof valueInMeters === 'number' && isFinite(valueInMeters)
      ? valueInMeters : 0;
    return failSafeValue / MeasurementItem.SPEED_OF_SOUND;
  }

  _computeDistanceInMeters(valueInSeconds) {
    const valueInMeters = this._computeInMeters(valueInSeconds)
      + MeasurementItem.DEFAULT_SHIFT_IN_METERS;
    return MeasurementItem.cleanFloat32Value(valueInMeters, 2);
  }

  _computeDistanceInSeconds(valueInMeters) {
    return this._computeInSeconds(valueInMeters - MeasurementItem.DEFAULT_SHIFT_IN_METERS);
  }

  async toggleInversion() {
    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/command`,
      { command: 'Invert' }
    );
    this.inverted(!this.inverted());
  }

  async resetAll() {
    try {
      await this.resetSmoothing();
      await this.resetIrWindows();
      await this.resetTargetSettings();
      await this.resetRoomCurveSettings();
      await this.ResetEqualiser();
      await this.resetcumulativeIRShiftSeconds();
      await this.setInverted(false);
    } catch (error) {
      throw new Error(
        `Failed to reset for response ${this.displayMeasurementTitle()}: ${error.message}`, { cause: error });
    }
  }

  async resetSmoothing() {
    await this.genericCommand('Smooth', { smoothing: "None" });
  }

  async resetIrWindows() {
    // Check if cumulative IR distance exists and is valid
    if (!this.haveImpulseResponse) {
      return true;
    }

    const commandResult = await this.parentViewModel.apiService.fetchSafe(
      '/ir-windows',
      this.uuid);

    const defaultSettings = {
      leftWindowType: "Rectangular",
      rightWindowType: "Rectangular",
      leftWindowWidthms: 30,
      rightWindowWidthms: 1000,
      addFDW: false,
      addMTW: false
    };

    // compare commandResult with defaultSettings
    if (commandResult.leftWindowType === defaultSettings.leftWindowType &&
      commandResult.rightWindowType === defaultSettings.rightWindowType &&
      commandResult.leftWindowWidthms === defaultSettings.leftWindowWidthms &&
      commandResult.rightWindowWidthms === defaultSettings.rightWindowWidthms &&
      commandResult.addFDW === defaultSettings.addFDW &&
      commandResult.addMTW === defaultSettings.addMTW) {
      return true;
    }

    await this.setIrWindows(defaultSettings);
  }

  async resetTargetSettings() {
    const commandResult = await this.parentViewModel.apiService.fetchSafe(
      '/target-settings',
      this.uuid);

    const defaultSettings = { shape: "None" };

    // compare commandResult with defaultSettings
    if (commandResult.shape === defaultSettings.shape) {
      return true;
    }

    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/target-settings`, defaultSettings);
  }

  async resetRoomCurveSettings() {
    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/room-curve-settings`, { addRoomCurve: false });
  }

  async ResetEqualiser() {

    const commandResult = await this.parentViewModel.apiService.fetchSafe(
      '/equaliser',
      this.uuid);

    const defaultSettings = { manufacturer: "Generic", model: "Generic" };

    // compare commandResult with defaultSettings
    if (commandResult.manufacturer === defaultSettings.manufacturer &&
      commandResult.model === defaultSettings.model
    ) {
      return true;
    }

    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/equaliser`,
      defaultSettings);
  }

  async setIrWindows(irWindowsObject) {
    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/ir-windows`,
      irWindowsObject);
  }

  async setTargetSettings(targetSettings) {
    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/target-settings`, targetSettings);
  }

  async generateFilterMeasurement() {
    const filter = await this.eqCommands('Generate filters measurement');
    filter.isFilter = true;

    if (!filter) {
      throw new Error(`filters reponse failed for ${this.displayMeasurementTitle()}`);
    }

    // add spl residual to filter
    await filter.addSPLOffsetDB(this.splresidual());
    const cxText = this.crossover() ? `X@${this.crossover()}Hz` : 'FB'
    await filter.setTitle(`Filter ${this.title()} ${cxText}`)
    return filter;
  }

  async getImpulseResponse(freq, unit = 'percent', windowed = true, normalised = true) {
    let url = `impulse-response?unit=${unit}&windowed=${windowed}&normalised=${normalised}`;
    if (freq) {
      // default is the rate of the data being exported
      url += `&samplerate=${freq}`;
    }
    // repsonse example
    // {
    //   "unit": "dBFS",
    //   "startTime": -0.03053968516398206,
    //   "sampleInterval": 0.000020833333333333333,
    //   "sampleRate": 48000,
    //   "timingReference": "Acoustic reference",
    //   "timingRefTime": -0.01318170882936498,
    //   "timingOffset": 0,
    //   "delay": 0.01015496119789816,
    //   "data": ...
    // }

    const reponseBody = await this.parentViewModel.apiService.fetchSafe(
      url,
      this.uuid);

    return MeasurementItem.decodeRewBase64(reponseBody.data);
  }

  async getFilterImpulseResponse(freq, sampleCount) {
    if (!freq || !sampleCount) {
      throw new Error(`Invalid frequency or sample count for ${this.displayMeasurementTitle()}`);
    }
    const url = `filters-impulse-response?length=${sampleCount}&samplerate=${freq}`;

    const reponseBody = await this.parentViewModel.apiService.fetchSafe(
      url,
      this.uuid);

    return MeasurementItem.decodeRewBase64(reponseBody.data);
  }

  async getPredictedImpulseResponse(freq, unit = 'percent', windowed = true, normalised = true) {
    let url = `eq/impulse-response?unit=${unit}&windowed=${windowed}&normalised=${normalised}`;
    if (freq) {
      // default is the rate of the data being exported
      url += `&samplerate=${freq}`;
    }
    const reponseBody = await this.parentViewModel.apiService.fetchSafe(
      url,
      this.uuid);

    return MeasurementItem.decodeRewBase64(reponseBody.data);
  }

  async getFrequencyResponse(unit = 'SPL', smoothing = 'None', ppo = null) {

    let url = `frequency-response?unit=${unit}&smoothing=${smoothing}`;
    if (ppo) {
      // default is the rate of the data being exported
      url += `&ppo=${ppo}`;
    }
    const commandResult = await this.parentViewModel.apiService.fetchSafe(
      url,
      this.uuid
    )

    const startFreq = commandResult.startFreq;
    const freqStep = commandResult.freqStep;
    const magnitude = MeasurementItem.decodeRewBase64(commandResult.magnitude);
    const phase = MeasurementItem.decodeRewBase64(commandResult.phase);
    const endFreq = startFreq + (magnitude.length - 1) * freqStep;
    const freqs = Array.from({ length: magnitude.length }, (_, i) => Number((startFreq + i * freqStep).toFixed(7)));

    return { freqs, magnitude, phase, startFreq, endFreq, freqStep };
  }

  async delete() {
    await this.parentViewModel.removeMeasurement(
      this
    );
  }

  async setInverted(inverted) {
    // refreshed every seconds when connected
    //this.refresh();
    if (inverted === this.inverted()) {
      return true;
    }
    await this.toggleInversion();
    return true;
  }

  async setTitle(newTitle, notescontent) {
    if (newTitle === this.title()) {
      return true;
    }
    await this.parentViewModel.apiService.fetchREW(
      this.uuid,
      'PUT',
      {
        "title": newTitle,
        ...(notescontent && { "notes": notescontent })
      }
    );
    this.title(newTitle);

    if (newTitle.startsWith('SW')) {
      this.isSub(true);
      this.crossover(0);
      this.speakerType('E');
    }
    return true;
  }

  async resetcumulativeIRShiftSeconds() {
    if (!this.haveImpulseResponse) {
      return;
    }
    await this.setcumulativeIRShiftSeconds(0);
  }

  async setcumulativeIRShiftSeconds(newValue) {
    await this.addIROffsetSeconds(newValue - this.cumulativeIRShiftSeconds());
  }

  async addIROffsetSeconds(amountToAdd) {
    // 2 decimals on ms value
    amountToAdd = MeasurementItem.cleanFloat32Value(amountToAdd, 5);
    if (amountToAdd === 0) {
      return true;
    }
    const before = (this.cumulativeIRShiftSeconds() * 1000).toFixed(2);
    await this.genericCommand('Offset t=0', {
      offset: amountToAdd,
      unit: "seconds"
    });
    this.cumulativeIRShiftSeconds(this.cumulativeIRShiftSeconds() + amountToAdd);
    this.timeOfIRPeakSeconds = this.timeOfIRPeakSeconds - amountToAdd;
    this.timeOfIRStartSeconds = this.timeOfIRStartSeconds - amountToAdd;
    const after = (this.cumulativeIRShiftSeconds() * 1000).toFixed(2);
    console.debug(`Offset t=${(amountToAdd * 1000).toFixed(2)}ms added to ${this.title()} from ${before} to ${after}`);
    return true;
  }

  async setSPLOffsetDB(newValue) {
    await this.addSPLOffsetDB(newValue - this.splOffsetDeltadB());
  }

  async addSPLOffsetDB(amountToAdd) {
    amountToAdd = MeasurementItem.cleanFloat32Value(amountToAdd, 2);
    if (amountToAdd === 0) {
      return true;
    }
    await this.genericCommand(
      'Add SPL offset',
      { offset: amountToAdd });
    this.splOffsetdB(this.splOffsetdB() + amountToAdd);
    return true;
  }

  async genericCommand(commandName, commandData) {

    const withoutResultCommands = [
      "Save",
      "Mic in box correction",
      "Merge cal data to IR",
      "Smooth",
      "Generate waterfall",
      "Generate equalised waterfall",
      "Generate spectrogram",
      "Generate equalised spectrogram",
      "Estimate IR delay",
      "Offset t=0",
      "Add SPL offset",
      "Generate RT60",
      "Invert",
      "Wrap phase",
      "Unwrap phase"
    ];

    const allowedCommands = [
      ...withoutResultCommands,
      "Trim IR to windows",
      "Minimum phase version",
      "Excess phase version",
      "Response copy",
      "Response magnitude copy"
    ];
    if (allowedCommands.indexOf(commandName) === -1) {
      throw new Error(`Command ${commandName} is not allowed`);
    }

    try {
      const commandResult = await this.parentViewModel.apiService.postNext(
        commandName,
        this.uuid,
        commandData,
        0);

      if (withoutResultCommands.indexOf(commandName) === -1) {
        const operationResultUuid = Object.values(commandResult.results || {})[0]?.UUID;
        // Save to persistent storage
        return await this.parentViewModel.addMeasurementApi(operationResultUuid);
      }
      return commandResult;

    } catch (error) {
      throw new Error(`Failed to create ${commandName} operation: ${error.message}`, { cause: error });
    }
  }

  async eqCommands(commandName) {

    const withoutResultCommands = [
      "Calculate target level",
      "Match target",
      "Optimise gains",
      "Optimise gains and Qs",
      "Optimise gains, Qs and Fcs"
    ];

    const allowedCommands = [
      ...withoutResultCommands,
      "Generate predicted measurement",
      "Generate filters measurement",
      "Generate target measurement"
    ];

    if (allowedCommands.indexOf(commandName) === -1) {
      throw new Error(`Command ${commandName} is not allowed`);
    }

    try {

      const operationResult = await this.parentViewModel.apiService.postNext(
        commandName,
        this.uuid,
        null,
        0,
        'eq/command'
      );

      if (withoutResultCommands.indexOf(commandName) === -1) {

        const operationResultUuid = Object.values(operationResult.results || {})[0]?.UUID;
        // Save to persistent storage
        return await this.parentViewModel.addMeasurementApi(operationResultUuid);
      }
      return operationResult;

    } catch (error) {
      throw new Error(`Failed to create ${commandName} operation: ${error.message}`, { cause: error });
    }
  }

  async getFilters() {
    this.filters(await this.parentViewModel.apiService.fetchSafe("filters", this.uuid));
    return this.filters();
  }

  async setFilters(filters) {
    if (!filters) {
      throw new Error(`Invalid filter: ${filters}`);
    }
    if (filters.length !== 22) {
      console.warn(`Invalid filter length: ${filters.length} expected 22`);
    }
    const currentFilters = await this.getFilters();
    if (filters === currentFilters) {
      return true;
    }
    // TODO: creates a new filter array containing only the different filters
    await this.parentViewModel.apiService.postSafe(`measurements/${this.uuid}/filters`,
      { filters: filters });

    this.filters(filters);
    this.parentViewModel.removeMeasurementUuid(this.associatedFilter);
    this.associatedFilter = null;
    await this.parentViewModel.copyFilters();
    return true;
  }

  async getTargetLevel() {
    const level = await this.parentViewModel.apiService.fetchSafe("target-level", this.uuid);
    return Number(level.toFixed(2));
  }

  async setTargetLevel(level) {
    if (!level) {
      throw new Error(`Invalid level: ${level}`);
    }
    level = Number(level.toFixed(2));
    if (isNaN(level)) {
      throw new Error(`Invalid level: ${level}`);
    }
    const currentLevel = await this.getTargetLevel();
    if (level === currentLevel) {
      return true;
    }
    await this.parentViewModel.apiService.postSafe(`measurements/${this.uuid}/target-level`, level);
    return true;
  }

  async resetFilters() {

    const currentFilters = await this.getFilters();

    const emptyFilter = {
      filters: Array.from({ length: 22 }, (_, i) => ({
        index: i + 1,
        type: "None",
        enabled: true,
        isAuto: true
      }))
    };

    if (JSON.stringify(currentFilters) === JSON.stringify(emptyFilter.filters)) {
      return true;
    }

    await this.parentViewModel.apiService.postSafe(`measurements/${this.uuid}/filters`,
      emptyFilter);
    this.filters(emptyFilter);
    this.parentViewModel.removeMeasurementUuid(this.associatedFilter);
    this.associatedFilter = null;
    await this.parentViewModel.copyFilters();
    return true;
  }

  async getAssociatedFilterItem() {

    if (!this.associatedFilterItem()) {
      console.warn(`Associated filter not found: ${this.displayMeasurementTitle()}, creating a new one`);
      return await this.createUserFilter();
    }

    return this.associatedFilterItem();
  }

  async setAssociatedFilter(filter) {
    if (!filter.isFilter) {
      throw new Error(`Invalid filter: ${filter}`);
    }
    this.associatedFilter = filter.uuid;
    await this.parentViewModel.copyFilters();
    this.parentViewModel.saveMeasurements();
  }

  async setAssociatedFilterUuid(filterUuid) {
    if (!filterUuid) {
      return true;
    }
    const item = this.parentViewModel.findMeasurementByUuid(filterUuid);
    if (!item) {
      throw new Error(`filter do not exists: ${filterUuid}`);
    }
    await this.setAssociatedFilter(item);
  }

  async deleteAssociatedFilter() {
    if (this.associatedFilterItem()) {
      await this.parentViewModel.removeMeasurementUuid(this.associatedFilter);
      this.associatedFilter = null;
      await this.parentViewModel.copyFilters();
      this.parentViewModel.saveMeasurements();
      return true;
    }
    return false;
  }

  /**
   * Get the filter length based on the EQ type.
   * @param {number} EQType - The type of EQ (0 for MultEQ, 1 for MultEQXT, 2 for MultEQXT32).
   * @returns {number} The filter length.
   */
  getFilterLength(EQType) {
    if (!this.haveImpulseResponse) {
      return;
    }
    if (!EQType) {
      throw new Error(`Invalid EQ type: ${EQType}`);
    }

    switch (EQType) {
      case MeasurementItem.EQType_MultEQ:
        return this.isSub() ? MeasurementItem.SUB_LENGTH_BASIC : MeasurementItem.SPEAKERS_LENGTH_BASIC;
      case MeasurementItem.EQType_MultEQXT:
        return this.isSub() ? MeasurementItem.SUB_LENGTH_XT : MeasurementItem.SPEAKERS_LENGTH_XT;
      case MeasurementItem.EQType_MultEQXT32:
        return this.isSub() ? MeasurementItem.SUB_LENGTH_XT32 : MeasurementItem.SPEAKERS_LENGTH_XT32;
      default:
        throw new Error(`Invalid EQ type: ${EQType}`);
    }
  }

  getFilterFreq(EQType) {
    if (!this.haveImpulseResponse) {
      return;
    }
    if (!EQType) {
      throw new Error(`Invalid EQ type: ${EQType}`);
    }

    switch (EQType) {
      case MeasurementItem.EQType_MultEQ:
        return this.isSub() ? MeasurementItem.FREQUENCY_48_KHZ : MeasurementItem.FREQUENCY_6_KHZ;
      case MeasurementItem.EQType_MultEQXT:
        return this.isSub() ? MeasurementItem.FREQUENCY_48_KHZ : MeasurementItem.FREQUENCY_6_KHZ;
      case MeasurementItem.EQType_MultEQXT32:
        return MeasurementItem.FREQUENCY_48_KHZ;
      default:
        throw new Error(`Invalid EQ type: ${EQType}`);
    }
  }

  async producePredictedMeasurement() {
    if (this.isFilter) {
      throw new Error(`action can not be done on a Filter: ${this.displayMeasurementTitle()}`);
    }

    const filter = await this.getAssociatedFilterItem();

    const predictedResult = await this.parentViewModel.doArithmeticOperation(
      this.uuid,
      filter.uuid,
      { function: "A * B" });

    predictedResult.setTitle(`predicted ${this.title()}`);

    return predictedResult;
  }

  async producePredictedMeasurementFromEQ() {
    if (this.isFilter) {
      throw new Error(`action can not be done on a Filter: ${this.displayMeasurementTitle()}`);
    }

    // to preserve invertion info in the result
    const wasInverted = this.inverted();
    if (wasInverted) {
      await this.setInverted(false);
    }
    const PredictedFiltered = await this.eqCommands('Generate predicted measurement');
    if (wasInverted) {
      await this.setInverted(true);
      await PredictedFiltered.setInverted(true);
    }

    PredictedFiltered.setTitle(`predicted ${this.title()}`);

    return PredictedFiltered;
  }

  async createUserFilter() {
    if (this.isFilter) {
      throw new Error(`Already a Filter: ${this.displayMeasurementTitle()}`);
    }
    await this.deleteAssociatedFilter();

    const filterResponse = await this.generateFilterMeasurement();

    await this.setAssociatedFilter(filterResponse);
    return filterResponse;
  }

  async applyWorkingSettings() {
    if (this.isFilter) {
      throw new Error(`Operation not permitted on a filter ${this.displayMeasurementTitle()}`);
    }
    await this.resetSmoothing();
    await this.resetRoomCurveSettings();
    await this.setIrWindows(
      {
        "leftWindowType": "Rectangular",
        "rightWindowType": "Rectangular",
        "leftWindowWidthms": 20,
        "rightWindowWidthms": 500,
        "refTimems": this.timeOfIRPeakSeconds * 1000,
        "addFDW": false,
        "addMTW": true,
        "mtwTimesms": [
          1900,
          1000,
          160,
          45,
          13,
          3.2,
          0.8,
          0.7,
          0.2,
          0.1
        ]
      });
  }

  async removeWorkingSettings() {
    if (this.isFilter) {
      throw new Error(`Operation not permitted on a filter ${this.displayMeasurementTitle()}`);
    }
    await this.resetIrWindows();
  }

  async createStandardFilter(maxBoost = 0) {

    if (this.isFilter) {
      throw new Error(`Operation not permitted on a filter ${this.displayMeasurementTitle()}`);
    }

    if (this.isSub()) {
      throw new Error(`Operation not permitted on a sub ${this.displayMeasurementTitle()}`);
    }

    await this.deleteAssociatedFilter();

    await this.applyWorkingSettings();

    if (this.crossover()) {

      await this.setTargetSettings(
        {
          "shape": "Driver",
          "lowPassCrossoverType": "None",
          "highPassCrossoverType": "BU2",
          "highPassCutoffHz": this.crossover()
        }
      );
    } else {
      await this.resetTargetSettings();
    }

    //const allpassQ = Math.sqrt(2) / 3;
    // if (this.isSub() && sameXover) {
    //   await mp.setFilters(
    //     [{
    //       index: 20,
    //       type: "All pass",
    //       enabled: true,
    //       isAuto: false,
    //       frequency: this.crossover(),
    //       q: allpassQ
    //     }]);
    // }


    // apply high pass filter at cuttOffFrequency
    const speakerFilter = [{
      "index": 21,
      "enabled": true,
      "isAuto": false,
      "frequency": this.crossover(),
      "shape": "BU",
      "slopedBPerOctave": 12,
      "type": "High pass"
    },
    {
      "index": 22,
      "type": "None",
      "enabled": true,
      "isAuto": false,
    }];
    await this.setFilters(speakerFilter);

    await this.parentViewModel.apiService.postSafe(`eq/match-target-settings`,
      {
        startFrequency: 10,
        endFrequency: 500,
        individualMaxBoostdB: 0,
        overallMaxBoostdB: maxBoost,
        flatnessTargetdB: 1,
        allowNarrowFiltersBelow200Hz: false,
        varyQAbove200Hz: false,
        allowLowShelf: false,
        allowHighShelf: false
      });

    await this.eqCommands('Match target');

    const filterResponse = await this.generateFilterMeasurement();

    await this.setAssociatedFilter(filterResponse);
    await this.removeWorkingSettings();

    return filterResponse;
  }

  async createMinimumPhaseCopy() {
    const minimumPhase = await this.genericCommand('Minimum phase version',
      {
        "include cal": true,
        "append lf tail": false,
        "append hf tail": false,
        "frequency warping": false,
        "replicate data": true
      });

    return minimumPhase;
  }

  async computeFilterGeneration(sampleCount, freq, invert) {

    if (!this.isFilter) {
      throw new Error(`${this.displayMeasurementTitle()} is not a filter`);
    }

    if (!this.haveImpulseResponse) {
      return;
    }

    if (!sampleCount) {
      throw new Error(`Invalid sample count: ${sampleCount}`);
    }
    if (!freq) {
      throw new Error(`Invalid frequency: ${freq}`);
    }

    const rightWindowWidth = MeasurementItem.cleanFloat32Value((sampleCount - 1) * 1000 / freq);

    await this.setIrWindows(
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
    await this.setInverted(false);
    const trimmedFilter = await this.genericCommand("Trim IR to windows");
    const filterImpulseResponse = await trimmedFilter.getImpulseResponse(freq);

    const filter = this.transformIR(filterImpulseResponse, sampleCount, invert);
    await trimmedFilter.delete();
    return filter;
  }

  static cleanFloat32Value(value, precision = 7) {
    // Use toFixed for direct string conversion to desired precision
    // Then convert back to number for consistent output
    return Number(value.toFixed(precision));
  }

  transformIR(filterImpulseResponse, sampleCount, invert = false) {

    if (!filterImpulseResponse || !Array.isArray(filterImpulseResponse)) {
      throw new Error('filterImpulseResponse must be a valid array');
    }
    if (sampleCount !== filterImpulseResponse.length) {
      throw new Error(`Invalid sample count: filterImpulseResponse contains ${filterImpulseResponse.length} samples, expected ${sampleCount}`);
    }

    const operands = new Float32Array(3);
    operands[0] = MeasurementItem.GAIN_ADJUSTMENT;
    operands[1] = invert ? -1 : 1;

    // multiply each impulse response value by gain adjustment and inversion factor
    const filter = filterImpulseResponse.map((value) => {
      operands[2] = value;
      return MeasurementItem.cleanFloat32Value(operands[0] * operands[1] * operands[2]);
    });

    return filter;
  }

  static decodeRewBase64(encodedData) {
    if (!encodedData) {
      throw new Error(`Invalid encoded data: ${encodedData}`);
    }
    try {
      const bytes = MeasurementItem.decodeBase64ToBinary(encodedData);
      const dataView = new DataView(bytes.buffer);
      const sampleCount = dataView.byteLength / Float32Array.BYTES_PER_ELEMENT;
      const result = new Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {

        const value = dataView.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, false);

        result[i] = MeasurementItem.cleanFloat32Value(value);

      }
      return result;
    } catch (error) {
      throw new Error(`Error decoding base64 data: ${error.message}`, { cause: error });
    }
  }

  // Decode to binary data
  static decodeBase64ToBinary(base64String) {
    const binaryString = atob(base64String);
    const bytes = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes;
  }

  /**
   * Validates and converts array elements to numbers
   * @param {Float32Array} float32Array - The array to validate
   * @returns {Float32Array} The validated array with numeric values
   * @throws {Error} If any element cannot be converted to a valid number
   */
  static validateArrayElements(float32Array) {
    // Check if array contains any NaN values
    if (float32Array.some(element =>
      Number.isFinite(element) && typeof element !== 'string')) {
      return float32Array;
    }
    let convertedArray = new Float32Array(float32Array.length);
    let index = 0;
    try {
      // Convert array to numbers and validate
      for (const element of float32Array) {
        const num = parseFloat(element);

        // Throw specific error for invalid conversions
        if (!Number.isFinite(num)) {
          throw new Error(`Invalid numeric value: ${element}`);
        }

        convertedArray[index++] = num;
      }

      // Create new Float32Array from converted values
      return convertedArray;

    } catch (error) {
      throw new Error(`Array validation failed:${error.message}`, { cause: error });
    }

  }

  static encodeRewToBase64(floatArray) {
    if (!Array.isArray(floatArray)) {
      throw new Error('Input must be an array of numbers');
    }

    try {
      // Create a buffer to hold the Float32 values
      const buffer = new ArrayBuffer(floatArray.length * Float32Array.BYTES_PER_ELEMENT);
      const dataView = new DataView(buffer);

      // Write each float value to the buffer
      for (let i = 0; i < floatArray.length; i++) {
        dataView.setFloat32(
          i * Float32Array.BYTES_PER_ELEMENT,
          floatArray[i],
          false  // use big-endian to match the decoder
        );
      }

      // Convert the buffer to a Uint8Array
      const bytes = new Uint8Array(buffer);

      // Convert to base64 using chunks to avoid call stack size exceeded
      const CHUNK_SIZE = 0x8000; // 32k
      let binaryString = '';

      for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.slice(i, i + CHUNK_SIZE);
        binaryString += String.fromCharCode.apply(null, chunk);
      }

      const base64String = btoa(binaryString);

      return base64String;

    } catch (error) {
      throw new Error(`Error encoding data to base64: ${error.message}`, { cause: error });
    }
  }

  // Method to get data for saving
  toJSON() {
    return {
      title: this.title(),
      notes: this.notes,
      date: this.date,
      uuid: this.uuid,
      startFreq: this.startFreq,
      endFreq: this.endFreq,
      inverted: this.inverted(),
      rewVersion: this.rewVersion,
      splOffsetdB: this.splOffsetdB(),
      alignSPLOffsetdB: this.alignSPLOffsetdB(),
      cumulativeIRShiftSeconds: this.cumulativeIRShiftSeconds(),
      clockAdjustmentPPM: this.clockAdjustmentPPM,
      timeOfIRStartSeconds: this.timeOfIRStartSeconds,
      timeOfIRPeakSeconds: this.timeOfIRPeakSeconds,
      crossover: this.crossover(),
      speakerType: this.speakerType(),
      initialSplOffsetdB: this.initialSplOffsetdB,
      isFilter: this.isFilter,
      haveImpulseResponse: this.haveImpulseResponse,
      associatedFilter: this.associatedFilter
    };
  }

  // Getters for computed values
  get isValid() {
    return this.speakerType() === 'S' ?
      this.crossover() >= 40 && this.crossover() <= 250 :
      true;
  }


}

export default MeasurementItem;





