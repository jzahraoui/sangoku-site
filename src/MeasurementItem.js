import { CHANNEL_TYPES } from './audyssey.js';
import 'decimal.js';
import ko from 'knockout';

class MeasurementItem {
  static AVR_MAX_GAIN = 12;
  static MODEL_DISTANCE_LIMIT = 6.0;
  static MODEL_DISTANCE_CRITICAL_LIMIT = 7.35;

  static measurementType = { SPEAKERS: 0, SUB: 1, FILTER: 2, AVERAGE: 3 };

  constructor(item, parentViewModel) {
    const self = this;
    // Validate inputs
    if (!item || !parentViewModel) {
      throw new Error('Invalid parameters for MeasurementItem creation');
    }

    // required for calculations using speed of sound
    if (!parentViewModel.jsonAvrData()?.avr) {
      throw new Error('No AVR data loaded');
    }

    self.jsonAvrData = parentViewModel.jsonAvrData();
    self.upperFrequencyBound = 16000;
    self.lowerFrequencyBound = 15;
    self.leftWindowWidthMilliseconds = 30;
    self.rightWindowWidthMilliseconds = 1000;
    self.individualMaxBoostValue = 6;
    self.overallBoostValue = 6;
    self.defaulEqtSettings = { manufacturer: 'Generic', model: 'Generic' };
    self.dectedFallOffLow = -1;
    self.dectedFallOffHigh = +Infinity;

    self.defaultSmoothingValue = 'Psy';

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
    self.haveImpulseResponse = Object.prototype.hasOwnProperty.call(
      item,
      'cumulativeIRShiftSeconds'
    );
    self.isFilter = item.isFilter || false;
    self.associatedFilter = item.associatedFilter;
    self.measurementType = MeasurementItem.measurementType.SPEAKERS;
    self.IRPeakValue = item.IRPeakValue || 0;

    // store value on object creation and make it immuable
    // TODO if not retreived from saved data the newly created reference can be false
    self.initialSplOffsetdB =
      item.initialSplOffsetdB || item.splOffsetdB - item.alignSPLOffsetdB;

    // restore saved data
    const isSW = item.title.startsWith('SW');
    const defaultCrossover = isSW
      ? 0
      : item.crossover || self.parentViewModel.DEFAULT_CROSSOVER_VALUE;
    const defaultSpeakerType = isSW ? 'E' : item.speakerType || 'S';

    // Observable properties
    self.crossover = ko.observable(defaultCrossover);
    self.speakerType = ko.observable(defaultSpeakerType);
    self.isSub = ko.observable(isSW);
    self.numberOfpositions = ko.observable(0);
    self.positionName = ko.observable('');
    self.displayPositionText = ko.observable('');

    // Computed properties
    self.channelName = ko.computed(
      () =>
        CHANNEL_TYPES.getBestMatchCode(self.title()) ||
        self.parentViewModel.UNKNOWN_GROUP_NAME
    );

    self.channelDetails = ko.computed(() => {
      const foundChannel = self.jsonAvrData?.detectedChannels.find(
        channel => channel.commandId === self.channelName()
      );
      if (foundChannel) {
        return CHANNEL_TYPES.getByChannelIndex(foundChannel.enChannelType);
      }
    });

    self.position = ko.computed(() => {
      const groupedMeasurements = self.parentViewModel.groupedMeasurements();
      const channelName = self.channelName();

      if (!groupedMeasurements || !groupedMeasurements[channelName]) {
        return 0;
      }

      const position = groupedMeasurements[channelName].items.indexOf(self) + 1;
      const numberOfPositions = groupedMeasurements[channelName].count;
      const displayPositionText = self.isAverage
        ? 'Average'
        : `Pos. ${position}/${numberOfPositions}`;

      self.numberOfpositions(numberOfPositions);
      self.displayPositionText(displayPositionText);

      return position;
    });

    self.associatedFilterItem = ko.computed(() =>
      self.parentViewModel.findMeasurementByUuid(this.associatedFilter)
    );
    self.measurementIndex = ko.computed(
      () => self.parentViewModel.measurements().indexOf(self) + 1
    );
    self.relatedLfeMeasurement = ko.computed(function () {
      const predictedLfeMeasurements = self.parentViewModel.allPredictedLfeMeasurement();
      const hasSingleSub = self.parentViewModel.uniqueSubsMeasurements().length === 1;

      return predictedLfeMeasurements.find(response =>
        hasSingleSub
          ? response?.position() === self.position()
          : response?.title() ===
            self.parentViewModel.DEFAULT_LFE_PREDICTED + self.position()
      );
    });
    self.displayMeasurementTitle = ko.computed(
      () => `${self.measurementIndex()}: ${self.title()}`
    );
    self.distanceInMeters = ko.computed(() =>
      self._computeDistanceInMeters(self.cumulativeIRShiftSeconds())
    );
    self.splOffsetdBUnaligned = ko.computed(
      () => self.splOffsetdB() - self.alignSPLOffsetdB()
    );
    self.splOffsetdBManual = ko.computed(
      () => self.splOffsetdBUnaligned() - self.initialSplOffsetdB
    );
    self.splOffsetDeltadB = ko.computed(
      () => self.splOffsetdBManual() + self.alignSPLOffsetdB()
    );
    self.splForAvr = ko.computed(() => Math.round(self.splOffsetDeltadB() * 2) / 2);
    self.splIsAboveLimit = ko.computed(
      () => Math.abs(self.splForAvr()) > MeasurementItem.AVR_MAX_GAIN
    );
    self.splresidual = ko.computed(() => self.splOffsetDeltadB() - self.splForAvr());
    self.cumulativeIRDistanceMeters = ko.computed(
      () => self.parentViewModel.maxDdistanceInMeters() - self.distanceInMeters()
    );
    self.cumulativeIRDistanceSeconds = ko.computed(() =>
      self._computeInSeconds(self.cumulativeIRDistanceMeters())
    );
    self.isSelected = ko.computed(
      () => self.parentViewModel.currentSelectedPosition() === self.position()
    );
    self.getOtherGroupMember = ko.computed(() =>
      CHANNEL_TYPES.getGroupMembers(self.channelDetails()?.group)
    );

    // Create a computed observable for the channel detection check
    self.isChannelDetected = ko.computed(function () {
      if (!self.jsonAvrData || !self.channelDetails()) {
        return false;
      }
      if (!self.isSelected()) {
        return false;
      }
      return self.jsonAvrData.detectedChannels.some(
        m => m.enChannelType === self.channelDetails().channelIndex
      );
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
      if (currentDistance > maxErrorDistance || currentDistance < 0) {
        return 'error';
      }

      // Check warning threshold
      if (currentDistance > maxWarningDistance) {
        return 'warning';
      }

      return 'normal';
    }, this);
    self.hasErrors = ko.computed(
      () =>
        self.splIsAboveLimit() ||
        self.exceedsDistance() === 'error' ||
        !self.isChannelDetected()
    );

    // subscriptions
    self.speakerType.subscribe(newValue => {
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

    self.crossover.subscribe(newValue => {
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
    const item = await this.parentViewModel.apiService.fetchREW(
      this.uuid,
      'GET',
      null,
      0
    );

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
    const failSafeValue =
      typeof valueInSeconds === 'number' && isFinite(valueInSeconds) ? valueInSeconds : 0;
    return failSafeValue * this.jsonAvrData.avr.speedOfSound;
  }

  _computeInSeconds(valueInMeters) {
    const failSafeValue =
      typeof valueInMeters === 'number' && isFinite(valueInMeters) ? valueInMeters : 0;
    return failSafeValue / this.jsonAvrData.avr.speedOfSound;
  }

  _computeDistanceInMeters(valueInSeconds) {
    const valueInMeters =
      this._computeInMeters(valueInSeconds) +
      this.parentViewModel.DEFAULT_SHIFT_IN_METERS;
    if (valueInMeters === undefined || valueInMeters === null) {
      throw new Error(
        `Failed to compute distance in meters for ${this.displayMeasurementTitle()}`
      );
    }
    return MeasurementItem.cleanFloat32Value(valueInMeters, 2);
  }

  _computeDistanceInSeconds(valueInMeters) {
    return this._computeInSeconds(
      valueInMeters - this.parentViewModel.DEFAULT_SHIFT_IN_METERS
    );
  }

  async toggleInversion() {
    await this.parentViewModel.apiService.postSafe(`measurements/${this.uuid}/command`, {
      command: 'Invert',
    });
    this.inverted(!this.inverted());
  }

  async resetAll(targetLevel = 75) {
    try {
      await this.resetSmoothing();
      await this.resetIrWindows();
      await this.resetTargetSettings();
      await this.resetRoomCurveSettings();
      await this.ResetEqualiser();
      await this.resetcumulativeIRShiftSeconds();
      await this.setInverted(false);
      await this.setTargetLevel(targetLevel);
    } catch (error) {
      throw new Error(
        `Failed to reset for response ${this.displayMeasurementTitle()}: ${error.message}`,
        { cause: error }
      );
    }
  }

  async resetSmoothing() {
    await this.genericCommand('Smooth', { smoothing: 'None' });
  }

  async defaultSmoothing() {
    await this.genericCommand('Smooth', { smoothing: this.defaultSmoothingValue });
  }

  async resetIrWindows() {
    // Check if cumulative IR distance exists and is valid
    if (!this.haveImpulseResponse) {
      return true;
    }

    const commandResult = await this.parentViewModel.apiService.fetchSafe(
      '/ir-windows',
      this.uuid
    );

    const defaultSettings = {
      leftWindowType: 'Rectangular',
      rightWindowType: 'Rectangular',
      leftWindowWidthms: this.leftWindowWidthMilliseconds,
      rightWindowWidthms: this.rightWindowWidthMilliseconds,
      addFDW: false,
      addMTW: false,
    };

    // compare commandResult with defaultSettings
    if (
      commandResult.leftWindowType === defaultSettings.leftWindowType &&
      commandResult.rightWindowType === defaultSettings.rightWindowType &&
      commandResult.leftWindowWidthms === defaultSettings.leftWindowWidthms &&
      commandResult.rightWindowWidthms === defaultSettings.rightWindowWidthms &&
      commandResult.addFDW === defaultSettings.addFDW &&
      commandResult.addMTW === defaultSettings.addMTW
    ) {
      return true;
    }

    await this.setIrWindows(defaultSettings);
  }

  async resetTargetSettings() {
    const commandResult = await this.parentViewModel.apiService.fetchSafe(
      '/target-settings',
      this.uuid
    );

    const defaultSettings = { shape: 'None' };

    // compare commandResult with defaultSettings
    if (commandResult.shape === defaultSettings.shape) {
      return true;
    }

    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/target-settings`,
      defaultSettings
    );
  }

  async resetRoomCurveSettings() {
    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/room-curve-settings`,
      { addRoomCurve: false }
    );
  }

  async isdefaultEqualiser() {
    const commandResult = await this.parentViewModel.apiService.fetchSafe(
      '/equaliser',
      this.uuid
    );

    // compare commandResult with defaultSettings
    if (
      commandResult.manufacturer === this.defaulEqtSettings.manufacturer &&
      commandResult.model === this.defaulEqtSettings.model
    ) {
      return true;
    }
    return false;
  }

  async ResetEqualiser() {
    // compare commandResult with defaultSettings
    if (await this.isdefaultEqualiser()) {
      return true;
    }

    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/equaliser`,
      this.defaulEqtSettings
    );
  }

  async setIrWindows(irWindowsObject) {
    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/ir-windows`,
      irWindowsObject
    );
  }

  async setTargetSettings(targetSettings) {
    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/target-settings`,
      targetSettings
    );
  }

  async generateFilterMeasurement() {
    if (this.associatedFilterItem()) {
      return this.associatedFilterItem();
    }

    const filter = await this.eqCommands('Generate filters measurement');
    filter.isFilter = true;

    if (!filter) {
      throw new Error(`filters reponse failed for ${this.displayMeasurementTitle()}`);
    }

    // add spl residual to filter
    await filter.addSPLOffsetDB(this.splresidual());
    const cxText = this.crossover() ? `X@${this.crossover()}Hz` : 'FB';
    await filter.setTitle(`Filter ${this.title()} ${cxText}`);
    this.setAssociatedFilter(filter);
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

    const reponseBody = await this.parentViewModel.apiService.fetchSafe(url, this.uuid);

    return MeasurementItem.decodeRewBase64(reponseBody.data);
  }

  async getFilterImpulseResponse(freq, sampleCount) {
    if (!freq || !sampleCount) {
      throw new Error(
        `Invalid frequency or sample count for ${this.displayMeasurementTitle()}`
      );
    }
    const url = `filters-impulse-response?length=${sampleCount}&samplerate=${freq}`;

    const reponseBody = await this.parentViewModel.apiService.fetchSafe(url, this.uuid);

    return MeasurementItem.decodeRewBase64(reponseBody.data);
  }

  async getPredictedImpulseResponse(
    freq,
    unit = 'percent',
    windowed = true,
    normalised = true
  ) {
    let url = `eq/impulse-response?unit=${unit}&windowed=${windowed}&normalised=${normalised}`;
    if (freq) {
      // default is the rate of the data being exported
      url += `&samplerate=${freq}`;
    }
    const reponseBody = await this.parentViewModel.apiService.fetchSafe(url, this.uuid);

    return MeasurementItem.decodeRewBase64(reponseBody.data);
  }

  async getFrequencyResponse(unit = 'SPL', smoothing = 'None', ppo = null) {
    let url = `frequency-response?unit=${unit}&smoothing=${smoothing}`;
    if (ppo) {
      // default is the rate of the data being exported
      url += `&ppo=${ppo}`;
    }
    const commandResult = await this.parentViewModel.apiService.fetchSafe(url, this.uuid);

    const startFreq = commandResult.startFreq;
    const freqStep = commandResult.freqStep;
    const magnitude = MeasurementItem.decodeRewBase64(commandResult.magnitude);
    let phase;
    if (commandResult.phase) {
      phase = MeasurementItem.decodeRewBase64(commandResult.phase);
    }

    let freqs;
    if (freqStep) {
      freqs = Array.from({ length: magnitude.length }, (_, i) =>
        MeasurementItem.cleanFloat32Value(startFreq + i * freqStep)
      );
    } else if (ppo) {
      freqs = Array.from({ length: magnitude.length }, (_, i) =>
        MeasurementItem.cleanFloat32Value(startFreq * Math.pow(2, i / ppo))
      );
    }

    const endFreq = freqs[freqs.length - 1];

    return { freqs, magnitude, phase, startFreq, endFreq, freqStep };
  }

  /**
   * Use the target curve frequency response to detect the frequency cutoff points.
   * Strore them in this.dectedFallOffLow and this.dectedFallOffHigh
   *
   * @returns {boolean} true if the cutoff points are detected, false otherwise
   */
  async detectFallOff(threshold = -3, ppo = 12) {
    // Reset detection values
    this.dectedFallOffLow = -1;
    this.dectedFallOffHigh = +Infinity;

    // Get measurement and target curve data
    const measurementData = await this.getFrequencyResponse('SPL', 'None', ppo);

    if (!measurementData.freqs?.length || !measurementData.magnitude?.length) {
      throw new Error(`Invalid frequency response data for ${this.title()}`);
    }

    const targetCurveData = await this.getTargetResponse('SPL', ppo);

    // Find low and high frequency cutoffs
    this.dectedFallOffLow = MeasurementItem.findCutoff(
      true,
      targetCurveData,
      measurementData,
      threshold
    );
    this.dectedFallOffHigh = MeasurementItem.findCutoff(
      false,
      targetCurveData,
      measurementData,
      threshold
    );

    return this.dectedFallOffLow !== -1 && this.dectedFallOffHigh !== +Infinity;
  }

  // Find cutoff points by comparing measurement to target curve
  static findCutoff(isLowFreq, targetCurveData, measurementData, threshold = -3) {
    const freqLimit = isLowFreq ? 500 : 100;
    const indices = [...Array(targetCurveData.freqs.length).keys()];

    if (!isLowFreq) indices.reverse();

    for (const i of indices) {
      const freq = targetCurveData.freqs[i];
      if ((isLowFreq && freq > freqLimit) || (!isLowFreq && freq < freqLimit)) continue;

      const measurementIdx = measurementData.freqs.findIndex(
        measureFreq => Math.abs(measureFreq - freq) / freq < 0.1
      );

      if (measurementIdx === -1) continue;

      if (
        measurementData.magnitude[measurementIdx] - targetCurveData.magnitude[i] >
        threshold
      ) {
        return Math.round(freq);
      }
    }

    return isLowFreq ? -1 : +Infinity;
  }

  async getTargetResponse(unit = 'SPL', ppo = 96) {
    let url = `target-response?unit=${unit}`;
    if (ppo) {
      // default is 96 PPO
      url += `&ppo=${ppo}`;
    }
    const commandResult = await this.parentViewModel.apiService.fetchSafe(url, this.uuid);

    const startFreq = commandResult.startFreq;
    const freqStep = commandResult.freqStep;
    const magnitude = MeasurementItem.decodeRewBase64(commandResult.magnitude);

    let freqs;
    if (freqStep) {
      freqs = Array.from({ length: magnitude.length }, (_, i) =>
        MeasurementItem.cleanFloat32Value(startFreq + i * freqStep)
      );
    } else if (ppo) {
      freqs = Array.from({ length: magnitude.length }, (_, i) =>
        MeasurementItem.cleanFloat32Value(startFreq * Math.pow(2, i / ppo))
      );
    }

    const endFreq = freqs[freqs.length - 1];

    return { freqs, magnitude, startFreq, endFreq };
  }

  async delete() {
    await this.parentViewModel.removeMeasurement(this);
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
    await this.parentViewModel.apiService.fetchREW(this.uuid, 'PUT', {
      title: newTitle,
      ...(notescontent && { notes: notescontent }),
    });
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
      unit: 'seconds',
    });
    this.cumulativeIRShiftSeconds(this.cumulativeIRShiftSeconds() + amountToAdd);
    this.timeOfIRPeakSeconds = this.timeOfIRPeakSeconds - amountToAdd;
    this.timeOfIRStartSeconds = this.timeOfIRStartSeconds - amountToAdd;
    const after = (this.cumulativeIRShiftSeconds() * 1000).toFixed(2);
    console.debug(
      `Offset t=${(amountToAdd * 1000).toFixed(2)}ms added to ${this.title()} from ${before} to ${after}`
    );
    return true;
  }

  async setZeroAtIrPeak() {
    await this.addIROffsetSeconds(this.timeOfIRPeakSeconds);
    return true;
  }

  static getAlignSPLOffsetdBByUUID(responseData, targetUUID) {
    try {
      // Find the result with matching UUID
      const result = Object.values(responseData.results).find(
        item => item.UUID === targetUUID
      );

      if (!result) {
        throw new Error(`No result found for UUID: ${targetUUID}`);
      }

      const alignSPLOffset = Number(result.alignSPLOffsetdB);

      if (isNaN(alignSPLOffset)) {
        throw new Error('Invalid alignSPLOffsetdB value');
      }

      return alignSPLOffset;
    } catch (error) {
      console.error('Error extracting alignSPLOffsetdB:', error);
      return null;
    }
  }

  // TODO: sometime a bug that move to 75dB
  async setSPLOffsetDB(newValue) {
    // check if the value is a number
    if (isNaN(newValue)) {
      throw new Error(`Invalid SPL offset: ${newValue}`);
    }
    // round the value to 2 decimal places
    newValue = MeasurementItem.cleanFloat32Value(newValue, 2);
    const currentValue = MeasurementItem.cleanFloat32Value(this.splOffsetDeltadB(), 2);

    // Check if the new value is the same as the current value
    if (newValue === currentValue) {
      return true;
    }
    console.debug(
      `Setting SPL offset to ${newValue} dB for ${this.displayMeasurementTitle()}`
    );
    // refence level is 75 dB just for the align command
    const referenceLevel = 75;
    const defaulParameters = {
      frequencyHz: 1000,
      spanOctaves: 0,
    };
    // first align the SPL to get the reference level
    const alignResult = await this.parentViewModel.processCommands(
      'Align SPL',
      [this.uuid],
      {
        ...defaulParameters,
        targetdB: referenceLevel,
      }
    );

    const referenceAlignSPLOffsetdB = MeasurementItem.getAlignSPLOffsetdBByUUID(
      alignResult,
      this.uuid
    );

    const offset = newValue - referenceAlignSPLOffsetdB;

    // align a second time to get the rigth level
    const finalAlignResult = await this.parentViewModel.processCommands(
      'Align SPL',
      [this.uuid],
      {
        ...defaulParameters,
        targetdB: referenceLevel + offset,
      }
    );
    const finalAlignSPLOffsetdB = MeasurementItem.getAlignSPLOffsetdBByUUID(
      finalAlignResult,
      this.uuid
    );
    if (finalAlignSPLOffsetdB !== newValue) {
      throw new Error(
        `Failed to set SPL offset to ${newValue} dB, current value is ${finalAlignSPLOffsetdB}`
      );
    }
    this.splOffsetdB(this.splOffsetdBUnaligned() + newValue);
    this.alignSPLOffsetdB(newValue);
  }

  async addSPLOffsetDB(amountToAdd) {
    const initalOffset = this.splOffsetDeltadB();
    const newLevel = initalOffset + amountToAdd;
    this.setSPLOffsetDB(newLevel);
  }

  async setSPLOffsetDBOld(newValue) {
    await this.addSPLOffsetDB(newValue - this.splOffsetDeltadB());
  }

  async addSPLOffsetDBOld(amountToAdd) {
    amountToAdd = MeasurementItem.cleanFloat32Value(amountToAdd, 2);
    if (amountToAdd === 0) {
      return true;
    }
    await this.genericCommand('Add SPL offset', { offset: amountToAdd });
    this.splOffsetdB(this.splOffsetdB() + amountToAdd);
    return true;
  }

  async genericCommand(commandName, commandData) {
    const withoutResultCommands = [
      'Save',
      'Mic in box correction',
      'Merge cal data to IR',
      'Smooth',
      'Generate waterfall',
      'Generate equalised waterfall',
      'Generate spectrogram',
      'Generate equalised spectrogram',
      'Estimate IR delay',
      'Offset t=0',
      'Add SPL offset',
      'Generate RT60',
      'Invert',
      'Wrap phase',
      'Unwrap phase',
    ];

    const allowedCommands = [
      ...withoutResultCommands,
      'Trim IR to windows',
      'Minimum phase version',
      'Excess phase version',
      'Response copy',
      'Response magnitude copy',
    ];
    if (allowedCommands.indexOf(commandName) === -1) {
      throw new Error(`Command ${commandName} is not allowed`);
    }

    try {
      const commandResult = await this.parentViewModel.apiService.postNext(
        commandName,
        this.uuid,
        commandData,
        0
      );

      if (withoutResultCommands.indexOf(commandName) === -1) {
        const operationResultUuid = Object.values(commandResult.results || {})[0]?.UUID;
        // Save to persistent storage
        return await this.parentViewModel.addMeasurementApi(operationResultUuid);
      }
      return commandResult;
    } catch (error) {
      throw new Error(`Failed to create ${commandName} operation: ${error.message}`, {
        cause: error,
      });
    }
  }

  async eqCommands(commandName) {
    const withoutResultCommands = [
      'Calculate target level',
      'Match target',
      'Optimise gains',
      'Optimise gains and Qs',
      'Optimise gains, Qs and Fcs',
    ];

    const allowedCommands = [
      ...withoutResultCommands,
      'Generate predicted measurement',
      'Generate filters measurement',
      'Generate target measurement',
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
      throw new Error(`Failed to create ${commandName} operation: ${error.message}`, {
        cause: error,
      });
    }
  }

  async getFilters() {
    const measurementFilters = await this.parentViewModel.apiService.fetchSafe(
      'filters',
      this.uuid
    );
    return measurementFilters;
  }

  async setFilters(filters) {
    if (!filters) {
      throw new Error(`Invalid filter: ${filters}`);
    }
    if (filters.length !== 22) {
      console.debug(`Invalid filter length: ${filters.length} expected 22`);
    }
    const currentFilters = await this.getFilters();

    const filtersCleaned = [];
    for (const filter of filters) {
      const index = filter.index;
      const found = currentFilters.find(f => f.index === index);
      if (!found) {
        throw new Error(`Invalid filter index: ${index}`);
      }
      // set auto to false if type is all pass
      if (filter.type === 'All pass' || filter.index > 20) {
        filter.isAuto = false;
        found.isAuto = false;
      }
      if (!this.compareObjects(filter, found)) {
        filtersCleaned.push(filter);
      }
    }
    if (filtersCleaned.length === 0) {
      return true;
    }
    await this.parentViewModel.apiService.postSafe(`measurements/${this.uuid}/filters`, {
      filters: filtersCleaned,
    });

    await this.deleteAssociatedFilter();
    return true;
  }

  async setSingleFilter(filter) {
    if (!filter) {
      throw new Error(`Invalid filter: ${filter}`);
    }

    await this.parentViewModel.apiService.putSafe(
      `measurements/${this.uuid}/filters`,
      filter
    );

    await this.deleteAssociatedFilter();
    return true;
  }

  async getFreeXFilterIndex() {
    if (!(await this.isdefaultEqualiser())) {
      throw new Error(`Invalid Equaliser: ${this.displayMeasurementTitle()}`);
    }

    const filters = await this.getFilters();

    if (filters[20]?.type === 'None') {
      return 21;
    } else if (filters[21]?.type === 'None') {
      return 22;
    }

    return -1;
  }

  compareObjects(obj1, obj2) {
    const sortedStringify = obj =>
      JSON.stringify(
        Object.keys(obj)
          .sort()
          .reduce((sorted, key) => {
            sorted[key] = obj[key];
            return sorted;
          }, {})
      );

    return sortedStringify(obj1) === sortedStringify(obj2);
  }

  async copyFiltersToOther() {
    const targets = this.parentViewModel
      .notUniqueMeasurements()
      .filter(response => response?.channelName() === this.channelName());

    if (!targets.length) {
      return false;
    }

    const measurementFilters = await this.getFilters();
    for (const otherItem of targets) {
      await otherItem.setFilters(measurementFilters);
      otherItem.associatedFilter = this.associatedFilter;
    }

    return true;
  }

  copyCrossoverToOther() {
    const targets = this.parentViewModel
      .notUniqueMeasurements()
      .filter(response => response?.channelName() === this.channelName());

    if (!targets.length) {
      return false;
    }

    for (const otherItem of targets) {
      otherItem.crossover(this.crossover());
      otherItem.speakerType(this.speakerType());
    }

    return true;
  }

  async copySplOffsetDeltadBToOther() {
    const targets = this.parentViewModel
      .notUniqueMeasurements()
      .filter(response => response?.channelName() === this.channelName());

    if (!targets.length) {
      return false;
    }

    for (const otherItem of targets) {
      await otherItem.setSPLOffsetDB(this.splOffsetDeltadB());
    }

    return true;
  }

  async copyCumulativeIRShiftToOther() {
    const targets = this.parentViewModel
      .notUniqueMeasurements()
      .filter(response => response?.channelName() === this.channelName());

    if (!targets.length) {
      return false;
    }

    for (const otherItem of targets) {
      await otherItem.setcumulativeIRShiftSeconds(this.cumulativeIRShiftSeconds());
      await otherItem.setInverted(this.inverted());
    }

    return true;
  }

  async copyAllToOther() {
    await this.copySplOffsetDeltadBToOther();
    await this.copyCumulativeIRShiftToOther();
    await this.copyFiltersToOther();
    this.copyCrossoverToOther();

    return true;
  }

  async getTargetLevel() {
    const level = await this.parentViewModel.apiService.fetchSafe(
      'target-level',
      this.uuid
    );
    return Number(level.toFixed(2));
  }

  async setTargetLevel(level) {
    // Check if level is undefined/null, but allow zero
    if (level === undefined || level === null) {
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
    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/target-level`,
      level
    );
    return true;
  }

  async resetFilters() {
    const currentFilters = await this.getFilters();

    const emptyFilter = {
      filters: Array.from({ length: 22 }, (_, i) => ({
        index: i + 1,
        type: 'None',
        enabled: true,
        isAuto: true,
      })),
    };

    if (this.compareObjects(currentFilters, emptyFilter.filters)) {
      return true;
    }

    await this.setFilters(emptyFilter.filters);

    await this.deleteAssociatedFilter();
    return true;
  }

  async getAssociatedFilterItem() {
    if (!this.associatedFilterItem()) {
      console.warn(
        `Associated filter not found: ${this.displayMeasurementTitle()}, creating a new one`
      );
      return await this.createUserFilter();
    }

    return this.associatedFilterItem();
  }

  async setAssociatedFilter(filter) {
    if (!filter.isFilter) {
      throw new Error(`Invalid filter: ${filter}`);
    }
    // check if the filter is already associated
    if (this.associatedFilter === filter.uuid) {
      return true;
    }
    await this.deleteAssociatedFilter();
    this.associatedFilter = filter.uuid;
    return true;
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
    if (this.associatedFilter === null) {
      return true;
    }
    if (this.associatedFilterItem()) {
      await this.parentViewModel.removeMeasurementUuid(this.associatedFilter);
      this.associatedFilter = null;
      return true;
    }
    return false;
  }

  async producePredictedMeasurementWithAssociatedFilter() {
    if (this.isFilter) {
      throw new Error(
        `action can not be done on a Filter: ${this.displayMeasurementTitle()}`
      );
    }

    const filter = await this.getAssociatedFilterItem();

    const predictedResult = await this.parentViewModel.doArithmeticOperation(
      this.uuid,
      filter.uuid,
      { function: 'A * B' }
    );

    predictedResult.setTitle(`predicted ${this.title()}`);

    return predictedResult;
  }

  async producePredictedMeasurement() {
    if (this.isFilter) {
      throw new Error(
        `action can not be done on a Filter: ${this.displayMeasurementTitle()}`
      );
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
      throw new Error(
        `Operation not permitted on a filter ${this.displayMeasurementTitle()}`
      );
    }
    await this.resetSmoothing();
    await this.resetRoomCurveSettings();
    await this.setIrWindows({
      leftWindowType: 'Rectangular',
      rightWindowType: 'Rectangular',
      leftWindowWidthms: this.leftWindowWidthMilliseconds,
      rightWindowWidthms: this.rightWindowWidthMilliseconds,
      refTimems: this.timeOfIRPeakSeconds * 1000,
      addFDW: false,
      addMTW: true,
      mtwTimesms: [9000, 3000, 450, 120, 30, 7.7, 2.6, 0.9, 0.4, 0.1],
    });
  }

  async removeWorkingSettings() {
    if (this.isFilter) {
      throw new Error(
        `Operation not permitted on a filter ${this.displayMeasurementTitle()}`
      );
    }
    await this.resetIrWindows();
    await this.defaultSmoothing();
  }

  async checkFilterGain() {
    const filters = await this.getFilters();
    for (const filter of filters) {
      if (filter.type === 'PK') {
        // check if PK filters are inside limits -25dB to +25dB
        if (filter.gaindB < -25 || filter.gaindB > 25) {
          return `${this.displayMeasurementTitle()} Filter ${filter.index} gain is out of limits: ${Math.round(filter.gaindB)}dB. Please add High Pass to X1 or X2 filter`;
        }
        // check if PK filters are inside limits 0.1 to 20
        if (filter.q < 0.1 || filter.q > 20) {
          return `${this.displayMeasurementTitle()} Filter ${filter.index} Q is out of limits: ${filter.q}.`;
        }
      }
    }
    return 'OK';
  }

  /**
   * !!! WARNING !!! set IR oversampling to None in the Analysis settings
   *
   * Creates a FIR (Finite Impulse Response) filter from the measurement.
   * This method performs several operations including smoothing, phase correction,
   * and amplitude correction to generate an appropriate filter.
   *
   * @throws {Error} If the operation is attempted on an existing filter
   * @throws {Error} If the operation is attempted on a sub-measurement
   * @throws {Error} If the filter creation process fails
   *
   * The process includes:
   * - Smoothing the measurement
   * - Creating a predicted measurement
   * - Generating amplitude correction
   * - Setting IR windows
   * - Creating and applying phase correction
   * - Combining phase and amplitude corrections
   *
   * @returns {Promise<boolean>} Returns true if the filter was successfully created
   */
  async createFIR() {
    if (this.isFilter) {
      throw new Error(
        `Operation not permitted on a filter ${this.displayMeasurementTitle()}`
      );
    }

    if (this.isSub()) {
      throw new Error(
        `Operation not permitted on a sub ${this.displayMeasurementTitle()}`
      );
    }

    // phase correction to lower frequency can cause ringing fil
    const startFrequency = 400;
    const stopFrequency = 20000;
    const toBeDeleted = [];

    try {
      await this.removeWorkingSettings();
      await this.genericCommand('Smooth', { smoothing: 'Var' });

      await this.createStandardFilter(false);
      const preview = await this.producePredictedMeasurement();
      toBeDeleted.push(preview.uuid);

      const amplitudeCorrection = await this.eqCommands('Generate filters measurement');
      toBeDeleted.push(amplitudeCorrection.uuid);

      await preview.setZeroAtIrPeak();
      await preview.resetSmoothing();
      await preview.setIrWindows({
        leftWindowType: 'Rectangular',
        rightWindowType: 'Rectangular',
        leftWindowWidthms: this.leftWindowWidthMilliseconds,
        rightWindowWidthms: this.rightWindowWidthMilliseconds,
        addFDW: true,
        addMTW: false,
        fdwWidthCycles: 6,
      });

      const excessPhase = await preview.createExcessPhaseCopy();
      toBeDeleted.push(excessPhase.uuid);

      await excessPhase.resetSmoothing();

      const phaseCorrection = await this.parentViewModel.doArithmeticOperation(
        excessPhase.uuid,
        this.uuid,
        {
          function: 'Invert A phase',
          lowerLimit: startFrequency,
          upperLimit: stopFrequency,
        }
      );
      toBeDeleted.push(phaseCorrection.uuid);

      const finalFIR = await this.parentViewModel.doArithmeticOperation(
        phaseCorrection.uuid,
        amplitudeCorrection.uuid,
        { function: 'A * B' }
      );

      // TODO: add spl residual to filter but do not overpass the max allowed boost
      const cxText = this.crossover() ? `X@${this.crossover()}Hz` : 'FB';
      await finalFIR.setTitle(`Filter ${this.title()} ${cxText}`);

      finalFIR.isFilter = true;

      this.setAssociatedFilter(finalFIR);

      return true;
    } catch (error) {
      throw new Error(`Filter creation failed: ${error.message}`, { cause: error });
    } finally {
      await this.removeWorkingSettings();
      // clean up temporary measurements
      for (const uuid of toBeDeleted) {
        await this.parentViewModel.removeMeasurementUuid(uuid);
      }
    }
  }

  countFiltersSlotsAvailable(filters) {
    if (!filters || !Array.isArray(filters)) {
      throw new Error(`Invalid filters: ${filters}`);
    }

    // count the number of filters that are not None
    const slots = filters.filter(
      filter => filter.isAuto === true && filter.index <= 20
    ).length;

    return slots;
  }

  async createStandardFilter(useWokingSettings = true) {
    if (this.isFilter) {
      throw new Error(
        `Operation not permitted on a filter ${this.displayMeasurementTitle()}`
      );
    }

    if (this.isSub()) {
      throw new Error(
        `Operation not permitted on a sub ${this.displayMeasurementTitle()}`
      );
    }

    const customInterPassFrequency = 120;

    // target level is supposed to already be adjusted by SPL alignment
    if (useWokingSettings) {
      await this.applyWorkingSettings();
    }

    // must have only lower band filter to be able to use the high pass filter
    await this.resetFilters();
    await this.resetTargetSettings();
    await this.detectFallOff(-5);

    const customStartFrequency = Math.max(
      this.lowerFrequencyBound,
      this.dectedFallOffLow
    );
    // do not use min because dectedFallOffHigh can be -1 if not detected
    const customEndFrequency = Math.min(this.upperFrequencyBound, this.dectedFallOffHigh);

    // must be set seaparatly to be taken into account
    await this.parentViewModel.apiService.postSafe(`eq/match-target-settings`, {
      endFrequency: customEndFrequency,
    });
    await this.parentViewModel.apiService.postSafe(`eq/match-target-settings`, {
      startFrequency: customStartFrequency,
      endFrequency: customEndFrequency,
      individualMaxBoostdB: 0,
      overallMaxBoostdB: 0,
      flatnessTargetdB: 1,
      allowNarrowFiltersBelow200Hz: false,
      varyQAbove200Hz: false,
      allowLowShelf: false,
      allowHighShelf: false,
    });

    await this.eqCommands('Match target');

    // set filters auto to off to prevent overwriting by the second pass
    await this.setAllFiltersAuto(false);

    const filters = await this.getFilters();
    const availableSlots = this.countFiltersSlotsAvailable(filters);
    if (availableSlots < 2) {
      throw new Error(
        `Not enough filter slots available for ${this.displayMeasurementTitle()}. Please remove some filters.`
      );
    }

    await this.parentViewModel.apiService.postSafe(`eq/match-target-settings`, {
      startFrequency: customInterPassFrequency,
      endFrequency: customEndFrequency,
      individualMaxBoostdB: this.individualMaxBoostValue,
      overallMaxBoostdB: this.overallBoostValue,
    });

    await this.eqCommands('Match target');

    // retore filters auto to on for next iteration
    await this.setAllFiltersAuto(true);

    if (useWokingSettings) {
      await this.removeWorkingSettings();
    }

    const isFiltersOk = await this.checkFilterGain();
    if (isFiltersOk !== 'OK') {
      throw new Error(isFiltersOk);
    }

    return true;
  }

  async setAllFiltersAuto(requiredState = true) {
    const filters = await this.getFilters();
    for (const filter of filters) {
      if (filter.type === 'PK' && filter.index <= 20 && filter.isAuto !== requiredState) {
        filter.isAuto = requiredState;
      }
    }
    await this.setFilters(filters);
    return true;
  }

  async createMinimumPhaseCopy() {
    const minimumPhase = await this.genericCommand('Minimum phase version', {
      'include cal': true,
      'append lf tail': false,
      'append hf tail': false,
      'frequency warping': false,
      'replicate data': true,
    });

    return minimumPhase;
  }

  async createExcessPhaseCopy() {
    return await this.genericCommand('Excess phase version', {
      'include cal': true,
      'append lf tail': false,
      'append hf tail': false,
      'frequency warping': false,
      'replicate data': true,
    });
  }

  static cleanFloat32Value(value, precision = 7) {
    // Handle non-numeric values and NaN
    const num = Number(value);
    if (!Number.isFinite(num)) {
      console.warn(`Invalid numeric value: ${value}`);
      return 0;
    }
    // Use toFixed for direct string conversion to desired precision
    // Then convert back to number for consistent output
    return Number(num.toFixed(precision));
  }

  static decodeRewBase64(encodedData, isLittleEndian = false) {
    if (!encodedData) {
      throw new Error(`Invalid encoded data: ${encodedData}`);
    }
    try {
      const bytes = MeasurementItem.decodeBase64ToBinary(encodedData);
      const dataView = new DataView(bytes.buffer);
      const sampleCount = dataView.byteLength / Float32Array.BYTES_PER_ELEMENT;
      const result = new Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        const value = dataView.getFloat32(
          i * Float32Array.BYTES_PER_ELEMENT,
          isLittleEndian
        );

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
    if (
      float32Array.some(
        element => Number.isFinite(element) && typeof element !== 'string'
      )
    ) {
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
          false // use big-endian to match the decoder
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
      throw new Error(`Error encoding data to base64: ${error.message}`, {
        cause: error,
      });
    }
  }

  // Method to get data for saving
  toJSON() {
    return {
      title: this.title(),
      displayMeasurementTitle: this.displayMeasurementTitle(),
      channelName: this.channelName(),
      position: this.position(),
      distance: this.distanceInMeters(),
      splForAvr: this.splForAvr().toFixed(1),
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
      associatedFilter: this.associatedFilter,
      IRPeakValue: this.IRPeakValue,
    };
  }

  get isAverage() {
    return this.title().endsWith(this.parentViewModel.businessTools.AVERAGE_SUFFIX);
  }

  get isPredicted() {
    return this.title().startsWith(this.parentViewModel.businessTools.RESULT_PREFIX);
  }

  get isLfePredicted() {
    return this.title().startsWith(this.parentViewModel.businessTools.LFE_PREDICTED);
  }

  get isUnknownChannel() {
    return this.channelName() === this.parentViewModel.UNKNOWN_GROUP_NAME;
  }

  get isValidPosition() {
    return Boolean(this.position());
  }

  // Getters for computed values
  get isValid() {
    return (
      this.isValidPosition &&
      !this.isPredicted &&
      !this.isUnknownChannel &&
      !this.isLfePredicted
    );
  }
}

export default MeasurementItem;
