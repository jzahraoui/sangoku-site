import { CHANNEL_TYPES } from './audyssey.js';
import 'decimal.js';
import ko from 'knockout';
import FrequencyResponse from './FrequencyResponse.js';
import BusinessTools from './BusinessTools.js';

class MeasurementItem {
  static AVR_MAX_GAIN = 12;
  static MODEL_DISTANCE_LIMIT = 6;
  static MODEL_DISTANCE_CRITICAL_LIMIT = 7.35;
  static DEFAULT_LFE_PREDICTED = 'LFE predicted_P';
  static DEFAULT_CROSSOVER_VALUE = 80;
  static leftWindowWidthMilliseconds = 30;
  static rightWindowWidthMilliseconds = 1000;
  static UNKNOWN_GROUP_NAME = 'UNKNOWN';

  static measurementType = { SPEAKERS: 0, SUB: 1, FILTER: 2, AVERAGE: 3 };
  static defaulEqtSettings = { manufacturer: 'Generic', model: 'Generic' };

  constructor(item, parentViewModel) {
    // Validate inputs
    if (!item || !parentViewModel) {
      throw new Error('Invalid parameters for MeasurementItem creation');
    }

    // required for calculations using speed of sound
    if (!parentViewModel.jsonAvrData()?.avr) {
      throw new Error('No AVR data loaded');
    }

    this.jsonAvrData = parentViewModel.jsonAvrData();
    this.dectedFallOffLow = -1;
    this.dectedFallOffHigh = +Infinity;

    this.parentViewModel = parentViewModel;
    // Original data
    this.title = ko.observable(item.title);
    this.notes = item.notes;
    this.date = item.date;
    this.uuid = item.uuid;
    this.startFreq = item.startFreq;
    this.endFreq = item.endFreq;
    this.inverted = ko.observable(item.inverted);
    this.rewVersion = item.rewVersion;
    this.splOffsetdB = ko.observable(item.splOffsetdB);
    this.alignSPLOffsetdB = ko.observable(item.alignSPLOffsetdB);
    this.cumulativeIRShiftSeconds = ko.observable(item.cumulativeIRShiftSeconds);
    this.clockAdjustmentPPM = item.clockAdjustmentPPM;
    this.timeOfIRStartSeconds = item.timeOfIRStartSeconds;
    this.timeOfIRPeakSeconds = item.timeOfIRPeakSeconds;
    this.haveImpulseResponse = Object.hasOwn(item, 'cumulativeIRShiftSeconds');
    this.isFilter = item.isFilter || false;
    this.associatedFilter = item.associatedFilter;
    this.measurementType = MeasurementItem.measurementType.SPEAKERS;
    this.IRPeakValue = item.IRPeakValue || 0;
    this.revertLfeFrequency = item.revertLfeFrequency || 0;

    // store value on object creation and make it immuable
    // TODO if not retreived from saved data the newly created reference can be false
    this.initialSplOffsetdB =
      item.initialSplOffsetdB || item.splOffsetdB - item.alignSPLOffsetdB;

    // Observable properties
    this.numberOfpositions = ko.observable(0);
    this.positionName = ko.observable('');
    this.displayPositionText = ko.observable('');

    // Computed properties
    this.channelName = ko.computed(
      () =>
        CHANNEL_TYPES.getBestMatchCode(this.title()) || MeasurementItem.UNKNOWN_GROUP_NAME
    );

    this.channelDetails = ko.computed(() => {
      const foundChannel = this.jsonAvrData?.detectedChannels.find(
        channel => channel.commandId === this.channelName()
      );
      if (foundChannel) {
        return CHANNEL_TYPES.getByChannelIndex(foundChannel.enChannelType);
      }
    });

    this.groupName = ko.computed(() => this.channelDetails()?.group || 'Unknown');
    this.crossover = ko.computed(() =>
      this.parentViewModel.measurementsByGroup()[this.groupName()]?.crossover()
    );
    this.speakerType = ko.computed(() =>
      this.parentViewModel.measurementsByGroup()[this.groupName()]?.speakerType()
    );
    this.isSub = ko.computed(
      () => this.parentViewModel.measurementsByGroup()[this.groupName()]?.isSub
    );

    this.position = ko.computed(() => {
      const groupedMeasurements = this.parentViewModel.groupedMeasurements();
      const channelName = this.channelName();

      if (!groupedMeasurements?.[channelName]) {
        return 0;
      }

      const position = groupedMeasurements[channelName].items.indexOf(this) + 1;
      const numberOfPositions = groupedMeasurements[channelName].count;
      const displayPositionText = this.isAverage
        ? 'Average'
        : `Pos. ${position}/${numberOfPositions}`;

      this.numberOfpositions(numberOfPositions);
      this.displayPositionText(displayPositionText);

      return position;
    });

    this.associatedFilterItem = ko.computed(() =>
      this.parentViewModel.findMeasurementByUuid(this.associatedFilter)
    );
    this.measurementIndex = ko.computed(
      () => this.parentViewModel.measurements().indexOf(this) + 1
    );
    this.relatedLfeMeasurement = ko.computed(() => {
      return this.parentViewModel
        .allPredictedLfeMeasurement()
        .find(
          response =>
            response?.title() ===
            `${MeasurementItem.DEFAULT_LFE_PREDICTED}${this.position()}`
        );
    });
    this.displayMeasurementTitle = ko.computed(
      () => `${this.measurementIndex()}: ${this.title()}`
    );
    this.distanceInMeters = ko.computed(() =>
      this._computeDistanceInMeters(this.cumulativeIRShiftSeconds())
    );
    this.distanceInMilliSeconds = ko.computed(() =>
      (this.cumulativeIRShiftSeconds() * 1000).toFixed(2)
    );
    this.distanceInUnits = ko.computed(() => {
      if (this.parentViewModel.distanceUnit() === 'M') {
        return this.distanceInMeters();
      } else if (this.parentViewModel.distanceUnit() === 'ms') {
        return this.distanceInMilliSeconds();
      } else if (this.parentViewModel.distanceUnit() === 'ft') {
        return (this.distanceInMeters() * 3.28084).toFixed(2); // Convert meters to feet
      }
      throw new Error(`Unknown distance unit: ${this.parentViewModel.distanceUnit()}`);
    });

    this.splOffsetdBUnaligned = ko.computed(
      () => this.splOffsetdB() - this.alignSPLOffsetdB()
    );
    this.splOffsetdBManual = ko.computed(
      () => this.splOffsetdBUnaligned() - this.initialSplOffsetdB
    );
    this.splOffsetDeltadB = ko.computed(
      () => this.splOffsetdBManual() + this.alignSPLOffsetdB()
    );
    this.splForAvr = ko.computed(() => Math.round(this.splOffsetDeltadB() * 2) / 2);
    this.splIsAboveLimit = ko.computed(
      () => Math.abs(this.splForAvr()) > MeasurementItem.AVR_MAX_GAIN
    );
    this.splresidual = ko.computed(() => this.splOffsetDeltadB() - this.splForAvr());
    this.cumulativeIRDistanceMeters = ko.computed(
      () => this.parentViewModel.maxDdistanceInMeters() - this.distanceInMeters()
    );
    this.cumulativeIRDistanceSeconds = ko.computed(() =>
      this._computeInSeconds(this.cumulativeIRDistanceMeters())
    );
    this.isSelected = ko.computed(
      () => this.parentViewModel.currentSelectedPosition() === this.position()
    );
    this.getOtherGroupMember = ko.computed(() =>
      CHANNEL_TYPES.getGroupMembers(this.channelDetails()?.group)
    );

    // Create a computed observable for the channel detection check
    this.isChannelDetected = ko.computed(() => {
      if (!this.jsonAvrData || !this.channelDetails()) {
        return false;
      }
      if (!this.isSelected()) {
        return false;
      }
      return this.jsonAvrData.detectedChannels.some(
        m => m.enChannelType === this.channelDetails().channelIndex
      );
    });
    this.exceedsDistance = ko.computed(() => {
      // Check if parent view model exists
      if (!this.parentViewModel) {
        return 'normal';
      }

      const maxErrorDistance = this.parentViewModel.maxDistanceInMetersError();
      const maxWarningDistance = this.parentViewModel.maxDistanceInMetersWarning();
      const currentDistance = this.distanceInMeters();

      // Check for invalid values
      if (Number.isNaN(maxErrorDistance) || Number.isNaN(maxWarningDistance)) {
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
    });
    this.hasErrors = ko.computed(
      () =>
        this.splIsAboveLimit() ||
        this.exceedsDistance() === 'error' ||
        !this.isChannelDetected()
    );

    this.buttonCreateFilter = async () => {
      if (parentViewModel.isProcessing()) return;
      try {
        parentViewModel.isProcessing(true);

        await this.createStandardFilter();
      } catch (error) {
        parentViewModel.handleError(`Filter creation failed: ${error.message}`);
      } finally {
        parentViewModel.isProcessing(false);
      }
    };

    this.previewMeasurement = async () => {
      if (parentViewModel.isProcessing()) return;
      try {
        parentViewModel.isProcessing(true);
        if (this.isSub()) {
          await parentViewModel.produceSumProcess([this]);
        } else {
          await parentViewModel.businessTools.createMeasurementPreview(this);
        }
        await this.copyAllToOther();
      } catch (error) {
        parentViewModel.handleError(`Preview creation failed: ${error.message}`);
      } finally {
        parentViewModel.isProcessing(false);
      }
    };
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
    const failSafeValue = Number.isFinite(valueInSeconds) ? valueInSeconds : 0;
    return failSafeValue * this.jsonAvrData.avr.speedOfSound;
  }

  _computeInSeconds(valueInMeters) {
    const failSafeValue = Number.isFinite(valueInMeters) ? valueInMeters : 0;
    return failSafeValue / this.jsonAvrData.avr.speedOfSound;
  }

  _computeDistanceInMeters(valueInSeconds) {
    const valueInMeters =
      this._computeInMeters(valueInSeconds) + this.parentViewModel.shiftInMeters();
    if (valueInMeters === undefined || valueInMeters === null) {
      throw new Error(
        `Failed to compute distance in meters for ${this.displayMeasurementTitle()}`
      );
    }
    return MeasurementItem.cleanFloat32Value(valueInMeters, 2);
  }

  _computeDistanceInSeconds(valueInMeters) {
    return this._computeInSeconds(valueInMeters - this.parentViewModel.shiftInMeters());
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
      await this.resetFilters();
    } catch (error) {
      throw new Error(
        `Failed to reset for response ${this.displayMeasurementTitle()}: ${
          error.message
        }`,
        { cause: error }
      );
    }
  }

  async resetSmoothing() {
    await this.genericCommand('Smooth', { smoothing: 'None' });
  }

  async defaultSmoothing() {
    // actually not possible to check current smoothing method
    await this.genericCommand('Smooth', {
      smoothing: this.parentViewModel.selectedSmoothingMethod(),
    });
  }

  async resetIrWindows() {
    await this.setIrWindows({
      leftWindowType: 'Rectangular',
      rightWindowType: 'Rectangular',
      leftWindowWidthms: MeasurementItem.leftWindowWidthMilliseconds,
      rightWindowWidthms: MeasurementItem.rightWindowWidthMilliseconds,
      refTimems: this.timeOfIRPeakSeconds * 1000,
      addFDW: false,
      addMTW: false,
    });
  }

  async resetTargetSettings() {
    const commandResult = await this.parentViewModel.apiService.fetchSafe(
      'target-settings',
      this.uuid
    );

    const defaultSettings = { shape: 'None' };

    // compare commandResult with defaultSettings
    if (commandResult.shape === defaultSettings.shape) {
      return true;
    }

    await this.setTargetSettings(defaultSettings);
  }

  async resetRoomCurveSettings() {
    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/room-curve-settings`,
      { addRoomCurve: false }
    );
  }

  async isdefaultEqualiser() {
    const commandResult = await this.parentViewModel.apiService.fetchSafe(
      'equaliser',
      this.uuid
    );

    // compare commandResult with defaultSettings
    return (
      commandResult.manufacturer === MeasurementItem.defaulEqtSettings.manufacturer &&
      commandResult.model === MeasurementItem.defaulEqtSettings.model
    );
  }

  async ResetEqualiser() {
    // compare commandResult with defaultSettings
    if (await this.isdefaultEqualiser()) {
      return true;
    }

    await this.parentViewModel.apiService.postSafe(
      `measurements/${this.uuid}/equaliser`,
      MeasurementItem.defaulEqtSettings
    );
  }

  static arraysMatchWithTolerance(arr1, arr2, tolerance = 0.01) {
    return (
      Array.isArray(arr1) &&
      Array.isArray(arr2) &&
      arr1.length === arr2.length &&
      arr1.every((val, i) => Math.abs(val - arr2[i]) < tolerance)
    );
  }

  compareIwWindows(source, target) {
    if (!source || !target) return false;

    return (
      target.leftWindowType &&
      target.leftWindowType === source.leftWindowType &&
      target.rightWindowType &&
      target.rightWindowType === source.rightWindowType &&
      target.leftWindowWidthms === undefined &&
      target.leftWindowWidthms.toFixed(2) === source.leftWindowWidthms.toFixed(2) &&
      target.rightWindowWidthms === undefined &&
      target.rightWindowWidthms.toFixed(2) === source.rightWindowWidthms.toFixed(2) &&
      target.refTimems === undefined &&
      target.refTimems.toFixed(2) === source.refTimems.toFixed(2) &&
      target.addFDW === undefined &&
      source.addFDW === target.addFDW &&
      target.addMTW === undefined &&
      source.addMTW === target.addMTW &&
      target.mtwTimesms &&
      MeasurementItem.arraysMatchWithTolerance(source.mtwTimesms, target.mtwTimesms)
    );
  }

  async setIrWindows(irWindowsObject) {
    // Check if cumulative IR distance exists and is valid
    if (!this.haveImpulseResponse) {
      return true;
    }

    const commandResult = await this.parentViewModel.apiService.fetchSafe(
      'ir-windows',
      this.uuid
    );

    if (this.compareIwWindows(commandResult, irWindowsObject)) return true;

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
    await this.setAssociatedFilter(filter);
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

    // Create a CommandResult object from the raw API response
    const frequencyResponse = new FrequencyResponse(commandResult);

    // Process the frequency response data
    const res = frequencyResponse.processFrequencyResponse(ppo);

    return res;
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
    if (!targetCurveData?.freqs?.length || !measurementData?.freqs?.length) {
      return isLowFreq ? -1 : +Infinity;
    }

    const freqLimit = isLowFreq ? 500 : 50;
    const indices = [...new Array(targetCurveData.freqs.length).keys()];

    if (!isLowFreq) indices.reverse();

    for (const i of indices) {
      const freq = targetCurveData.freqs[i];
      if ((isLowFreq && freq > freqLimit) || (!isLowFreq && freq < freqLimit)) continue;

      const measurementIdx = measurementData.freqs.reduce((bestIdx, measureFreq, idx) => {
        const diff = Math.abs(measureFreq - freq);
        return diff < Math.abs(measurementData.freqs[bestIdx] - freq) ? idx : bestIdx;
      }, 0);

      if (measurementIdx === -1) continue;

      const measurementDataAtFreq = measurementData.magnitude[measurementIdx];
      const targetCurveDataAtFreq = targetCurveData.magnitude[i];
      const magnitudeDiff = Math.round(measurementDataAtFreq - targetCurveDataAtFreq);

      if (magnitudeDiff >= threshold) {
        return Math.round(freq);
      }
    }

    return isLowFreq ? -1 : +Infinity;
  }

  async getTargetResponse(unit = 'SPL', ppo = 96) {
    let url = `target-response?unit=${unit}&ppo=${ppo}`;
    const commandResult = await this.parentViewModel.apiService.fetchSafe(url, this.uuid);

    const startFreq = commandResult.startFreq;
    const magnitude = MeasurementItem.decodeRewBase64(commandResult.magnitude);

    const freqs = Array.from({ length: magnitude.length }, (_, i) =>
      MeasurementItem.cleanFloat32Value(startFreq * Math.pow(2, i / ppo))
    );

    const endFreq = freqs.at(-1);

    return { freqs, magnitude, startFreq, endFreq };
  }

  async delete() {
    await this.parentViewModel.removeMeasurement(this);
  }

  async setInverted(inverted) {
    // refreshed every seconds when connected
    //this.refresh();
    if (inverted === this.inverted()) {
      return false;
    }
    await this.toggleInversion();
    return true;
  }

  async setTitle(newTitle, notescontent) {
    if (newTitle === this.title()) {
      return false;
    }
    await this.parentViewModel.apiService.fetchREW(this.uuid, 'PUT', {
      title: newTitle,
      ...(notescontent && { notes: notescontent }),
    });
    this.title(newTitle);

    // TODO if is sub ?

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
    amountToAdd = MeasurementItem.cleanFloat32Value(amountToAdd, 10);
    if (amountToAdd === 0) {
      return false;
    }
    await this.genericCommand('Offset t=0', {
      offset: amountToAdd,
      unit: 'seconds',
    });
    await this.refresh();
    console.debug(
      `Offset t=${(amountToAdd * 1000).toFixed(2)}ms added to ${this.title()}`
    );
    return true;
  }

  async setZeroAtIrPeak() {
    await this.addIROffsetSeconds(this.timeOfIRPeakSeconds);
    return true;
  }

  static getAlignSPLOffsetdBByUUID(responseData, targetUUID) {
    try {
      if (!responseData?.results) {
        throw new Error('Invalid response data');
      }
      // Find the result with matching UUID
      const result = Object.values(responseData.results).find(
        item => item.UUID === targetUUID
      );

      if (!result) {
        throw new Error(`No result found for UUID: ${targetUUID}`);
      }

      const alignSPLOffset = Number(result.alignSPLOffsetdB);

      if (Number.isNaN(alignSPLOffset)) {
        throw new TypeError('Invalid alignSPLOffsetdB value');
      }

      return alignSPLOffset;
    } catch (error) {
      throw new Error(`Failed to get align SPL offset: ${error.message}`, {
        cause: error,
      });
    }
  }

  // TODO: sometime a bug that move to 75dB
  async setSPLOffsetDB(newValue) {
    // check if the value is a number
    if (Number.isNaN(newValue)) {
      throw new TypeError(`Invalid SPL offset: ${newValue}`);
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
    //check results
    const finalAlignSPLOffsetdB = MeasurementItem.getAlignSPLOffsetdBByUUID(
      finalAlignResult,
      this.uuid
    );
    if (finalAlignSPLOffsetdB !== newValue) {
      throw new Error(
        `Failed to set SPL offset to ${newValue} dB, current value is ${finalAlignSPLOffsetdB}`
      );
    }
    // Apply changes to local object
    this.splOffsetdB(this.splOffsetdBUnaligned() + newValue);
    this.alignSPLOffsetdB(newValue);
  }

  async addSPLOffsetDB(amountToAdd) {
    this.setSPLOffsetDB(this.splOffsetDeltadB() + amountToAdd);
  }

  async setSPLOffsetDBOld(newValue) {
    await this.addSPLOffsetDB(newValue - this.splOffsetDeltadB());
  }

  async addSPLOffsetDBOld(amountToAdd) {
    amountToAdd = MeasurementItem.cleanFloat32Value(amountToAdd, 2);
    if (amountToAdd === 0) {
      return false;
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
      'Generate minimum phase',
    ];
    if (!allowedCommands.includes(commandName)) {
      throw new Error(`Command ${commandName} is not allowed`);
    }

    try {
      const commandResult = await this.parentViewModel.apiService.postNext(
        commandName,
        this.uuid,
        commandData,
        2
      );

      if (!withoutResultCommands.includes(commandName)) {
        const operationResultUuid = Object.values(commandResult.results || {})[0]?.UUID;
        const measurement = await this.parentViewModel.addMeasurementApi(
          operationResultUuid
        );
        measurement.isFilter = commandName === 'Generate filters measurement';
        measurement.parentAttr = this.toJSON();
        // Save to persistent storage
        return measurement;
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

    if (!allowedCommands.includes(commandName)) {
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

      if (!withoutResultCommands.includes(commandName)) {
        const operationResultUuid = Object.values(operationResult.results || {})[0]?.UUID;
        const measurement = await this.parentViewModel.addMeasurementApi(
          operationResultUuid
        );
        measurement.isFilter = commandName === 'Generate filters measurement';
        measurement.parentAttr = this.toJSON();
        // Save to persistent storage
        return measurement;
      }
      return operationResult;
    } catch (error) {
      throw new Error(`Failed to create ${commandName} operation: ${error.message}`, {
        cause: error,
      });
    }
  }

  async getFilters() {
    const autoDisableTypes = new Set(['LP', 'HP', 'HS', 'LS', 'All pass']);
    const measurementFilters = await this.parentViewModel.apiService.fetchSafe(
      'filters',
      this.uuid
    );
    for (const filter of measurementFilters) {
      if (autoDisableTypes.has(filter.type)) {
        filter.isAuto = false;
      }
    }
    return measurementFilters;
  }

  async setFilters(filters, overwrite = true) {
    if (!filters) {
      throw new Error(`Invalid filter: ${filters}`);
    }
    if (filters.length !== 22) {
      console.debug(`Invalid filter length: ${filters.length} expected 22`);
    }

    const allFilters = await this.getFilters();

    if (this.compareObjects(allFilters, filters)) {
      return false;
    }

    const currentFilters = overwrite ? allFilters : allFilters.filter(f => f.isAuto);

    const filtersCleaned = [];
    for (const filter of filters) {
      const index = filter.index;
      const found = currentFilters.find(f => f.index === index);
      if (!found) {
        console.warn(`Filter with index ${index} not found in current filters`);
        continue;
      }
      // set auto to false if type is all pass
      if (filter.type === 'All pass' || index > 20) {
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

    const filters = await this.getFilters();
    const found = filters.find(f => f.index === filter.index);
    if (!found) {
      throw new Error(`Filter with index ${filter.index} not found`);
    }
    if (this.compareObjects(filter, found)) {
      return false;
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
    const freeIndex = [20, 21].find(i => filters[i]?.type === 'None');

    if (freeIndex === undefined) {
      throw new Error(`No free filter index found: ${this.displayMeasurementTitle()}`);
    }

    return freeIndex + 1;
  }

  compareObjects(obj1, obj2) {
    const sortedStringify = obj =>
      JSON.stringify(
        Object.keys(obj)
          .sort((a, b) => a.localeCompare(b))
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

  async copyTargetLevelToAll() {
    const targets = this.parentViewModel.validMeasurements();

    if (!targets.length) {
      return false;
    }

    const currentLevel = await this.getTargetLevel();
    for (const otherItem of targets) {
      await otherItem.setTargetLevel(currentLevel);
    }

    await this.parentViewModel.updateTargetCurve(this);

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
      throw new TypeError(`Invalid level: ${level}`);
    }
    level = Number(level.toFixed(2));
    if (Number.isNaN(level)) {
      throw new TypeError(`Invalid level: ${level}`);
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
    const emptyFilter = {
      filters: Array.from({ length: 22 }, (_, i) => ({
        index: i + 1,
        type: 'None',
        enabled: true,
        isAuto: true,
      })),
    };

    await this.setFilters(emptyFilter.filters);

    await this.deleteAssociatedFilter();
    return true;
  }

  async getAssociatedFilterItem() {
    if (this.associatedFilterItem()) {
      return this.associatedFilterItem();
    }

    console.warn(
      `Associated filter not found: ${this.displayMeasurementTitle()}, creating a new one`
    );
    return await this.createUserFilter();
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
      this,
      filter,
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
    // save current IR shift
    const currentCumulativeIRShift = this.cumulativeIRShiftSeconds();
    await this.resetcumulativeIRShiftSeconds();

    const PredictedFiltered = await this.eqCommands('Generate predicted measurement');
    if (!PredictedFiltered) {
      throw new Error('Cannot generate predicted measurement');
    }
    if (wasInverted) {
      await this.setInverted(true);
      await PredictedFiltered.setInverted(true);
    }

    await PredictedFiltered.setcumulativeIRShiftSeconds(currentCumulativeIRShift);
    await this.setcumulativeIRShiftSeconds(currentCumulativeIRShift);

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
    await this.defaultSmoothing();
    await this.resetRoomCurveSettings();
    await this.setIrWindows(this.parentViewModel.selectedIrWindowsConfig());
  }

  async removeWorkingSettings() {
    if (this.isFilter) {
      throw new Error(
        `Operation not permitted on a filter ${this.displayMeasurementTitle()}`
      );
    }
    await this.resetIrWindows();
    await this.resetSmoothing();
  }

  async checkFilterGain() {
    const filters = await this.getFilters();
    for (const filter of filters) {
      if (filter.type === 'PK') {
        // check if PK filters are inside limits -25dB to +25dB
        if (filter.gaindB < -25 || filter.gaindB > 25) {
          return `${this.displayMeasurementTitle()} Filter ${
            filter.index
          } gain is out of limits: ${Math.round(
            filter.gaindB
          )}dB. Please add High Pass to X1 or X2 filter`;
        }
        // check if PK filters are inside limits 0.1 to 20
        if (filter.q < 0.1 || filter.q > 20) {
          return `${this.displayMeasurementTitle()} Filter ${
            filter.index
          } Q is out of limits: ${filter.q}.`;
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
    const stopFrequency = 2000;
    const toBeDeleted = [];

    try {
      await this.removeWorkingSettings();

      await this.createStandardFilter(false, false);
      const preview = await this.producePredictedMeasurement();
      toBeDeleted.push(preview.uuid);

      const amplitudeCorrection = await this.eqCommands('Generate filters measurement');
      toBeDeleted.push(amplitudeCorrection.uuid);

      await preview.setZeroAtIrPeak();
      await preview.resetSmoothing();
      await preview.setIrWindows({
        leftWindowType: 'Rectangular',
        rightWindowType: 'Rectangular',
        leftWindowWidthms: MeasurementItem.leftWindowWidthMilliseconds,
        rightWindowWidthms: MeasurementItem.rightWindowWidthMilliseconds,
        refTimems: this.timeOfIRPeakSeconds * 1000,
        addFDW: true,
        addMTW: false,
        fdwWidthCycles: 6,
      });

      const excessPhase = await preview.createExcessPhaseCopy();
      toBeDeleted.push(excessPhase.uuid);

      await excessPhase.resetSmoothing();

      const phaseCorrection = await this.parentViewModel.doArithmeticOperation(
        excessPhase,
        this,
        {
          function: 'Invert A phase',
          lowerLimit: startFrequency,
          upperLimit: stopFrequency,
        }
      );
      toBeDeleted.push(phaseCorrection.uuid);

      const finalFIR = await this.parentViewModel.doArithmeticOperation(
        phaseCorrection,
        amplitudeCorrection,
        { function: 'A * B' }
      );

      // TODO: add spl residual to filter but do not overpass the max allowed boost
      const cxText = this.crossover() ? `X@${this.crossover()}Hz` : 'FB';
      await finalFIR.setTitle(`Filter ${this.title()} ${cxText}`);

      finalFIR.isFilter = true;

      await this.setAssociatedFilter(finalFIR);

      return true;
    } catch (error) {
      throw new Error(`Filter creation failed: ${error.message}`, { cause: error });
    } finally {
      await this.applyWorkingSettings();
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

  async createStandardFilter(useWokingSettings = true, copyFiltersToOther = true) {
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
    } else {
      await this.removeWorkingSettings();
    }

    // must have only lower band filter to be able to use the high pass filter
    await this.resetFilters();
    await this.resetTargetSettings();
    await this.copyTargetLevelToAll();
    await this.detectFallOff(-6);

    const customStartFrequency = Math.max(
      this.parentViewModel.lowerFrequencyBound(),
      this.dectedFallOffLow
    );
    // do not use min because dectedFallOffHigh can be -1 if not detected
    const customEndFrequency = Math.min(
      this.parentViewModel.upperFrequencyBound(),
      this.dectedFallOffHigh
    );

    // must be set seaparatly to be taken into account
    await this.parentViewModel.apiService.postSafe(`eq/match-target-settings`, {
      endFrequency: customEndFrequency,
    });
    await this.parentViewModel.apiService.postSafe(`eq/match-target-settings`, {
      startFrequency: customStartFrequency,
      endFrequency: customInterPassFrequency * 2,
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
      startFrequency: customInterPassFrequency / 2,
      endFrequency: customEndFrequency,
      individualMaxBoostdB: this.parentViewModel.individualMaxBoostValue(),
      overallMaxBoostdB: this.parentViewModel.overallBoostValue(),
    });

    await this.eqCommands('Match target');

    // retore filters auto to on for next iteration
    await this.setAllFiltersAuto(true);

    if (!useWokingSettings) {
      await this.applyWorkingSettings();
    }

    const isFiltersOk = await this.checkFilterGain();
    if (isFiltersOk !== 'OK') {
      throw new Error(isFiltersOk);
    }

    if (copyFiltersToOther) {
      await this.copyFiltersToOther();
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
      bytes[i] = binaryString.codePointAt(i);
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
        const num = Number.parseFloat(element);

        // Throw specific error for invalid conversions
        if (!Number.isFinite(num)) {
          throw new TypeError(`Invalid numeric value: ${element}`);
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
      throw new TypeError('Input must be an array of numbers');
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
      initialSplOffsetdB: this.initialSplOffsetdB,
      isFilter: this.isFilter,
      haveImpulseResponse: this.haveImpulseResponse,
      associatedFilter: this.associatedFilter,
      IRPeakValue: this.IRPeakValue,
    };
  }

  get isAverage() {
    return this.title().endsWith(BusinessTools.AVERAGE_SUFFIX);
  }

  get isPredicted() {
    return this.title().startsWith(BusinessTools.RESULT_PREFIX);
  }

  get isLfePredicted() {
    return this.title().startsWith(MeasurementItem.DEFAULT_LFE_PREDICTED);
  }

  get isUnknownChannel() {
    return this.channelName() === MeasurementItem.UNKNOWN_GROUP_NAME;
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
