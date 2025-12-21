import { CHANNEL_TYPES } from './audyssey.js';
import 'decimal.js';
import ko from 'knockout';
import BusinessTools from './BusinessTools.js';
import lm from './logs.js';

class MeasurementItem {
  static AVR_MAX_GAIN = 12;
  static MODEL_DISTANCE_LIMIT = 6;
  static MODEL_DISTANCE_CRITICAL_LIMIT = 7.35;
  static DEFAULT_LFE_PREDICTED = 'LFE predicted_P';
  static DEFAULT_CROSSOVER_VALUE = 80;
  static UNKNOWN_GROUP_NAME = 'UNKNOWN';
  static DEFAULT_TARGET_LEVEL = 75;

  static measurementType = { SPEAKERS: 0, SUB: 1, FILTER: 2, AVERAGE: 3 };

  constructor(item, parentViewModel) {
    // Validate inputs
    if (!item || !parentViewModel) {
      throw new Error('Invalid parameters for MeasurementItem creation');
    }

    // required for calculations using speed of sound
    if (!parentViewModel.jsonAvrData()?.avr) {
      throw new Error('No AVR data loaded');
    }

    this.speedOfSound = parentViewModel.jsonAvrData().avr.speedOfSound;
    this.detectedChannels = parentViewModel.jsonAvrData().detectedChannels;

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
    this.timeOfIRPeakSeconds = ko.observable(item.timeOfIRPeakSeconds);
    this.haveImpulseResponse = Object.hasOwn(item, 'cumulativeIRShiftSeconds');
    this.isFilter = item.isFilter || false;
    this.associatedFilter = item.associatedFilter;
    this.measurementType = MeasurementItem.measurementType.SPEAKERS;
    this.IRPeakValue = item.IRPeakValue || 0;
    this.revertLfeFrequency = item.revertLfeFrequency || 0;
    this.isSubOperationResult = item.isSubOperationResult || false;
    this.parentAttr = item.parentAttr || null;
    this.shiftDelay = ko.observable(item.shiftDelay || Infinity);

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
      const foundChannel = this.detectedChannels.find(
        channel => channel.commandId === this.channelName()
      );
      return CHANNEL_TYPES.getByChannelIndex(foundChannel?.enChannelType);
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

    this.leftWindowWidthMilliseconds = this.isSub() ? 70 : 30;
    this.rightWindowWidthMilliseconds = 1000;

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
    this.absoluteIRPeakSeconds = ko.computed(() => {
      if (!this.haveImpulseResponse) return 0;
      return this.timeOfIRPeakSeconds() + this.cumulativeIRShiftSeconds();
    });
    this.displayMeasurementTitle = ko.computed(
      () => `${this.measurementIndex()}: ${this.title()}`
    );
    this.distanceInMeters = ko.computed(() => {
      if (!this.haveImpulseResponse) return 0;
      return (
        this._computeInMeters(this.cumulativeIRShiftSeconds()) +
        this.parentViewModel.shiftInMeters()
      );
    });
    this.distanceInUnits = ko.computed(() => {
      if (!this.haveImpulseResponse) return 0;
      const unit = this.parentViewModel.distanceUnit();
      if (unit === 'M') {
        return this.distanceInMeters();
      } else if (unit === 'ms') {
        return this.cumulativeIRShiftSeconds() * 1000;
      } else if (unit === 'ft') {
        return this.distanceInMeters() * 3.28084;
      }

      throw new Error(`Unknown distance unit: ${unit}`);
    });

    this.splOffsetDeltadB = ko.computed(() =>
      MeasurementItem.cleanFloat32Value(this.splOffsetdB() - this.initialSplOffsetdB, 2)
    );
    this.splForAvr = ko.computed(() => Math.round(this.splOffsetDeltadB() * 2) / 2);
    this.splIsAboveLimit = ko.computed(
      () => Math.abs(this.splForAvr()) > MeasurementItem.AVR_MAX_GAIN
    );
    this.splresidual = ko.computed(() => this.splOffsetDeltadB() - this.splForAvr());
    this.cumulativeIRDistanceMeters = ko.computed(
      () => this.parentViewModel.maxDistanceInMeters() - this.distanceInMeters()
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
      const details = this.channelDetails();
      return (
        this.isSelected() &&
        this.detectedChannels &&
        details &&
        this.detectedChannels.some(m => m.enChannelType === details.channelIndex)
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
        await parentViewModel.setProcessing(true);

        await this.createStandardFilter();
      } catch (error) {
        parentViewModel.handleError(`Filter creation failed: ${error.message}`, error);
      } finally {
        await parentViewModel.setProcessing(false);
      }
    };

    this.previewMeasurement = async () => {
      if (parentViewModel.isProcessing()) return;
      try {
        await parentViewModel.setProcessing(true);
        if (this.isSub()) {
          await parentViewModel.produceSumProcess([this]);
        } else {
          await parentViewModel.businessTools.createMeasurementPreview(this);
        }
        // if filters was manually tunned, copy them to other positions
        await this.copyFiltersToOther();
      } catch (error) {
        parentViewModel.handleError(`Preview creation failed: ${error.message}`, error);
      } finally {
        await parentViewModel.setProcessing(false);
      }
    };

    this.otherPositionMeasurements = ko.computed(() => {
      return this.parentViewModel
        .validMeasurements()
        .filter(
          response =>
            response?.channelName() === this.channelName() &&
            response.uuid !== this.uuid &&
            response.position() !== this.position()
        );
    });

    // Subscribe to changes in inverted to to apply to all other positions
    this.inverted.subscribe(async () => {
      if (!this.isSelected()) return;
      await this.copyInversionToOtherPositions();
    });

    this.cumulativeIRShiftSeconds.subscribe(async () => {
      this.shiftDelay(Infinity);
      if (!this.isSelected()) return;
      await this.copyCumulativeIRShiftToOther();
    });
  }

  async refresh() {
    const item = await this.rewMeasurements.get(this.uuid);

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
    this.timeOfIRPeakSeconds(item.timeOfIRPeakSeconds);
  }

  // Compute methods
  _computeInMeters(valueInSeconds) {
    if (!Number.isFinite(valueInSeconds)) return 0;
    return valueInSeconds * this.speedOfSound;
  }

  _computeInSeconds(valueInMeters) {
    if (!Number.isFinite(valueInMeters)) return 0;
    return valueInMeters / this.speedOfSound;
  }

  // funtion is accessible from the UI
  async toggleInversion() {
    try {
      const allreadyProcessing = this.parentViewModel.isProcessing();
      if (!allreadyProcessing) await this.parentViewModel.setProcessing(true);
      await this.rewMeasurements.invert(this.uuid);
      if (!allreadyProcessing) await this.parentViewModel.setProcessing(false);

      // Important to do refresh after allreadyProcessing check
      await this.refresh();
    } catch (error) {
      this.parentViewModel.handleError(
        `Failed to toggle inversion for ${this.displayMeasurementTitle()}: ${
          error.message
        }`,
        error
      );
    }
  }

  async resetAll(targetLevel = MeasurementItem.DEFAULT_TARGET_LEVEL) {
    try {
      await this.resetSmoothing();
      await this.resetIrWindows();
      await this.resetTargetSettings();
      await this.resetRoomCurveSettings();
      await this.resetEqualiser();
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
    lm.debug(`${this.displayMeasurementTitle()}: Resetting smoothing`);
    return this.rewMeasurements.removeSmoothing([this.uuid]);
  }

  async defaultSmoothing() {
    // actually not possible to check current smoothing method
    return this.rewMeasurements.smoothMeasurements(
      [this.uuid],
      this.parentViewModel.selectedSmoothingMethod()
    );
  }

  async setSmoothing(smoothingMethod) {
    // actually not possible to check current smoothing method
    return this.rewMeasurements.smooth([this.uuid], smoothingMethod);
  }

  async resetIrWindows() {
    return this.setIrWindows({
      leftWindowType: 'Rectangular',
      rightWindowType: 'Rectangular',
      leftWindowWidthms: this.leftWindowWidthMilliseconds,
      rightWindowWidthms: this.rightWindowWidthMilliseconds,
      refTimems: this.timeOfIRPeakSeconds() * 1000,
      addFDW: false,
      addMTW: false,
    });
  }

  async resetTargetSettings() {
    lm.debug(`${this.displayMeasurementTitle()}: Resetting target settings`);
    return this.rewMeasurements.resetTargetSettings(this.uuid);
  }

  async resetRoomCurveSettings() {
    lm.debug(`${this.displayMeasurementTitle()}: Resetting room curve settings`);
    await this.rewMeasurements.resetRoomCurveSettings(this.uuid);
  }

  async getEqualiser() {
    return this.rewMeasurements.getEqualiser(this.uuid);
  }

  async isdefaultEqualiser() {
    const commandResult = await this.getEqualiser();
    const defaultSettings = this.rewEq.defaulEqtSettings;

    // compare commandResult with defaultSettings
    return (
      commandResult.manufacturer === defaultSettings.manufacturer &&
      commandResult.model === defaultSettings.model
    );
  }

  async resetEqualiser() {
    const defaultSettings = this.rewEq.defaulEqtSettings;
    // compare commandResult with defaultSettings
    if (await this.isdefaultEqualiser()) {
      return true;
    }
    lm.debug(`${this.displayMeasurementTitle()}: Resetting equaliser to Generic EQ`);
    await this.rewMeasurements.setEqualiser(this.uuid, defaultSettings);
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

    // Helper: si target a l'attribut défini, vérifier qu'il est égal à source
    // Si target n'a pas l'attribut, accepter n'importe quelle valeur de source
    const matches = (sourceVal, targetVal) => {
      if (targetVal === undefined) return true; // Target n'a pas l'attribut → OK
      return sourceVal === targetVal;
    };

    // Helper pour les valeurs numériques avec tolérance
    const numbersMatch = (sourceVal, targetVal) => {
      if (targetVal === undefined) return true; // Target n'a pas l'attribut → OK
      if (sourceVal === undefined) return false; // Target a l'attribut mais pas source → KO
      return sourceVal.toFixed(2) === targetVal.toFixed(2);
    };

    return (
      matches(source.leftWindowType, target.leftWindowType) &&
      matches(source.rightWindowType, target.rightWindowType) &&
      numbersMatch(source.leftWindowWidthms, target.leftWindowWidthms) &&
      numbersMatch(source.rightWindowWidthms, target.rightWindowWidthms) &&
      numbersMatch(source.refTimems, target.refTimems) &&
      matches(source.addFDW, target.addFDW) &&
      matches(source.addMTW, target.addMTW) &&
      (!target.mtwTimesms ||
        MeasurementItem.arraysMatchWithTolerance(source.mtwTimesms, target.mtwTimesms))
    );
  }

  async setIrWindows(irWindowsObject) {
    // Check if cumulative IR distance exists and is valid
    if (!this.haveImpulseResponse) {
      return;
    }

    const commandResult = await this.rewMeasurements.getIRWindows(this.uuid);

    if (this.compareIwWindows(commandResult, irWindowsObject)) return true;

    lm.debug(`${this.displayMeasurementTitle()}: Setting IR windows`);
    return this.rewMeasurements.setIRWindows(this.uuid, irWindowsObject);
  }

  async trimIRToWindows() {
    // Check if cumulative IR distance exists and is valid
    if (!this.haveImpulseResponse) {
      return;
    }
    const result = await this.rewMeasurements.trimIRToWindows(this.uuid);
    const newMeasurement = await this.parentViewModel.analyseApiResponse(result);
    if (!newMeasurement) {
      throw new Error(`trimIRToWindows failed for ${this.displayMeasurementTitle()}`);
    }
    return newMeasurement;
  }

  async responseCopy() {
    return this.rewMeasurements.responseCopy(this.uuid);
  }

  async setTargetSettings(targetSettings) {
    return this.rewMeasurements.postTargetSettings(this.uuid, targetSettings);
  }

  async generateFilterMeasurement() {
    if (this.associatedFilterItem()) {
      return this.associatedFilterItem();
    }

    const response = await this.rewMeasurements.generateFiltersMeasurement(this.uuid);
    const filter = await this.parentViewModel.analyseApiResponse(response);
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
    const options = { unit, windowed, normalised, ...(freq && { samplerate: freq }) };
    const reponseBody = await this.rewMeasurements.getImpulseResponse(this.uuid, options);

    return reponseBody.dataArray;
  }

  async getFilterImpulseResponse(freq, sampleCount) {
    if (!freq || !sampleCount) {
      throw new Error(
        `Invalid frequency or sample count for ${this.displayMeasurementTitle()}`
      );
    }
    const options = { length: sampleCount, samplerate: freq };
    const reponseBody = await this.rewMeasurements.getFiltersImpulseResponse(
      this.uuid,
      options
    );

    return reponseBody.dataArray;
  }

  async getPredictedImpulseResponse(
    freq,
    unit = 'percent',
    windowed = true,
    normalised = true
  ) {
    const options = { unit, windowed, normalised, ...(freq && { samplerate: freq }) };
    const reponseBody = await this.rewMeasurements.getPredictedImpulseResponse(
      this.uuid,
      options
    );

    return reponseBody.dataArray;
  }

  async getFrequencyResponse(unit = 'SPL', smoothing = 'None', ppo = null) {
    const options = { unit, smoothing, ...(ppo && { ppo }) };

    return this.rewMeasurements.getFrequencyResponse(this.uuid, options);
  }

  /**
   * Use the target curve frequency response to detect the frequency cutoff points.
   * Strore them in this.dectedFallOffLow and this.dectedFallOffHigh
   */
  async detectFallOff(threshold = -3, ppo = 12) {
    // Reset detection values
    this.dectedFallOffLow = -1;
    this.dectedFallOffHigh = +Infinity;

    // Get measurement and target curve data
    const measurementData = await this.getFrequencyResponse('SPL', '1/12', ppo);

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
    const options = { unit, ppo };

    return this.rewMeasurements.getTargetResponse(this.uuid, options);
  }

  async delete() {
    await this.parentViewModel.removeMeasurement(this);
  }

  async setInverted(inverted) {
    // refreshed every seconds when connected
    if (inverted === this.inverted()) return;
    lm.debug(`${this.displayMeasurementTitle()}: Setting inverted to ${inverted}`);
    return this.toggleInversion();
  }

  async setTitle(newTitle, notescontent) {
    if (newTitle === this.title()) {
      return false;
    }
    await this.rewMeasurements.update(this.uuid, {
      title: newTitle,
      notes: notescontent,
    });
    await this.refresh();

    return true;
  }

  async resetcumulativeIRShiftSeconds() {
    lm.debug(`${this.displayMeasurementTitle()}: Resetting cumulative IR shift to 0s`);
    await this.setcumulativeIRShiftSeconds(0);
  }

  async setcumulativeIRShiftSeconds(newValue) {
    await this.addIROffsetSeconds(newValue - this.cumulativeIRShiftSeconds());
  }

  async addIROffsetSeconds(amountToAdd) {
    if (!this.haveImpulseResponse) {
      return;
    }
    // 2 decimals on ms value
    amountToAdd = MeasurementItem.cleanFloat32Value(amountToAdd, 10);
    if (amountToAdd === 0) {
      return false;
    }
    await this.rewMeasurements.offsetTZero(this.uuid, amountToAdd);
    await this.refresh();
    lm.debug(`Offset t=${(amountToAdd * 1000).toFixed(2)}ms added to ${this.title()}`);
    return true;
  }

  async setZeroAtIrPeak() {
    await this.addIROffsetSeconds(this.timeOfIRPeakSeconds());
    return true;
  }

  /**
   * parse the response data to get the alignSPLOffsetdB for the targetUUID
   */
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

  // TODO: sometime a bug that move to 75dB when frequencyHz is out of range
  async setSPLOffsetDB(newValue) {
    // check if the value is a number
    if (Number.isNaN(newValue)) {
      throw new TypeError(`Invalid SPL offset: ${newValue}`);
    }
    // round the value to 2 decimal places
    newValue = MeasurementItem.cleanFloat32Value(newValue, 2);

    // Check if the new value is the same as the current value
    if (newValue === this.splOffsetDeltadB()) {
      return true;
    }
    lm.debug(
      `Setting SPL offset to ${newValue} dB for ${this.displayMeasurementTitle()}`
    );
    // refence level is 75 dB just for the align command
    const referenceLevel = MeasurementItem.DEFAULT_TARGET_LEVEL;
    // frequency must be in the mid range
    const frequencyHz = 100;
    const spanOctaves = 0;
    // first align the SPL to get the reference level
    const alignResult = await this.rewMeasurements.alignSPL(
      [this.uuid],
      referenceLevel,
      frequencyHz,
      spanOctaves
    );

    const referenceAlignSPLOffsetdB = MeasurementItem.getAlignSPLOffsetdBByUUID(
      alignResult,
      this.uuid
    );

    const offset = newValue - referenceAlignSPLOffsetdB;

    // align a second time to get the rigth level
    const finalAlignResult = await this.rewMeasurements.alignSPL(
      [this.uuid],
      referenceLevel + offset,
      frequencyHz,
      spanOctaves
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
    return this.refresh();
  }

  async addSPLOffsetDB(amountToAdd) {
    return this.setSPLOffsetDB(this.splOffsetDeltadB() + amountToAdd);
  }

  async getFilters() {
    const autoDisableTypes = new Set(['LP', 'HP', 'HS', 'LS', 'All pass']);
    const measurementFilters = await this.rewMeasurements.getFilters(this.uuid);
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
      lm.debug(`Invalid filter length: ${filters.length} expected 22`);
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
        lm.warn(
          `Filter with index ${index} not found in current filters, make sure Generic EQ is selected`
        );
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

    await this.deleteAssociatedFilter();
    lm.debug(
      `${this.displayMeasurementTitle()}: Setting ${filtersCleaned.length} filters`
    );
    return this.rewMeasurements.postFilters(this.uuid, {
      filters: filtersCleaned,
    });
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

    await this.rewMeasurements.setFilters(this.uuid, filter);

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
    const targets = this.otherPositionMeasurements();
    if (!targets.length) return;

    lm.info(`Copying filters to other positions of ${this.displayMeasurementTitle()}...`);
    const measurementFilters = await this.getFilters();
    for (const otherItem of targets) {
      await otherItem.setFilters(measurementFilters);
      otherItem.associatedFilter = this.associatedFilter;
    }
  }

  async copySplOffsetDeltadBToOther() {
    const targets = this.otherPositionMeasurements();
    if (!targets.length) return;

    lm.info(
      `Copying SPL offset to other positions of ${this.displayMeasurementTitle()}...`
    );
    const splOffset = this.splOffsetDeltadB();
    for (const otherItem of targets) {
      await otherItem.setSPLOffsetDB(splOffset);
    }
  }

  async copyCumulativeIRShiftToOther() {
    if (!this.haveImpulseResponse) return;
    const targets = this.otherPositionMeasurements();
    if (!targets.length) return;

    lm.info(
      `Copying Cumulative IR Shift to other positions of ${this.displayMeasurementTitle()}...`
    );
    const irShift = this.cumulativeIRShiftSeconds();
    for (const otherItem of targets) {
      await otherItem.setcumulativeIRShiftSeconds(irShift);
    }
  }

  async copyInversionToOtherPositions() {
    const targets = this.otherPositionMeasurements();
    if (!targets.length) return;

    const allreadyProcessing = this.parentViewModel.isProcessing();
    const inverted = this.inverted();

    if (!allreadyProcessing) await this.parentViewModel.setProcessing(true);

    lm.info(
      `Copying Inversion to other positions of ${this.displayMeasurementTitle()}...`
    );
    for (const otherItem of targets) {
      await otherItem.setInverted(inverted);
    }

    if (!allreadyProcessing) await this.parentViewModel.setProcessing(false);
  }

  async copyAllToOther() {
    await this.copySplOffsetDeltadBToOther();
    await this.copyCumulativeIRShiftToOther();
    await this.copyFiltersToOther();
    await this.copyInversionToOtherPositions();

    return true;
  }

  async getTargetLevel() {
    const level = await this.rewMeasurements.getTargetLevel(this.uuid);
    return MeasurementItem.cleanFloat32Value(level, 2);
  }

  async setTargetLevel(level) {
    // Check if level is undefined/null, but allow zero
    if (level === undefined || level === null) {
      throw new TypeError(`Invalid level: ${level}`);
    }
    level = MeasurementItem.cleanFloat32Value(level, 2);

    const currentLevel = await this.getTargetLevel();
    if (level.toFixed(2) === currentLevel.toFixed(2)) {
      return true;
    }

    lm.debug(
      `${this.displayMeasurementTitle()}: Target level set to ${level.toFixed(1)} dB`
    );
    await this.rewMeasurements.setTargetLevel(this.uuid, level);

    return this.resetFilters();
  }

  get emptyFilters() {
    return Array.from({ length: 22 }, (_, i) => ({
      index: i + 1,
      type: 'None',
      enabled: true,
      isAuto: true,
    }));
  }

  async resetFilters() {
    await this.deleteAssociatedFilter();
    return this.setFilters(this.emptyFilters);
  }

  async getAssociatedFilterItem() {
    if (this.associatedFilterItem()) {
      return this.associatedFilterItem();
    }

    lm.warn(
      `Associated filter not found: ${this.displayMeasurementTitle()}, creating a new one`
    );
    return this.createUserFilter();
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

    const predictedResult = await this.arithmeticConvolution(filter);

    predictedResult.setTitle(`predicted ${this.title()}`);

    return predictedResult;
  }

  async producePredictedMeasurement() {
    if (this.isFilter) {
      throw new Error(
        `action can not be done on a Filter: ${this.displayMeasurementTitle()}`
      );
    }

    const apiResponse = await this.rewMeasurements.generatePredictedMeasurement(
      this.uuid
    );
    const PredictedFiltered = await this.parentViewModel.analyseApiResponse(apiResponse);
    if (!PredictedFiltered) {
      throw new Error('Cannot generate predicted measurement');
    }

    await PredictedFiltered.setTitle(`predicted ${this.title()}`);

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
      if (filter.type !== 'PK') continue;
      // check if PK filters are inside limits -25dB to +25dB
      if (filter.gaindB < -25 || filter.gaindB > 25) {
        throw new Error(
          `${this.displayMeasurementTitle()} Filter ${
            filter.index
          } gain is out of limits: ${Math.round(
            filter.gaindB
          )}dB. Please add High Pass to X1 or X2 filter`
        );
      }
      // check if PK filters are inside limits 0.1 to 20
      if (filter.q < 0.1 || filter.q > 20) {
        throw new Error(
          `${this.displayMeasurementTitle()} Filter ${filter.index} Q is out of limits: ${
            filter.q
          }.`
        );
      }
    }
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
    const startFrequency = Math.max(400, this.parentViewModel.lowerFrequencyBound());
    const stopFrequency = Math.min(2000, this.parentViewModel.upperFrequencyBound());
    const toBeDeleted = [];

    try {
      await this.removeWorkingSettings();

      await this.createStandardFilter(false, false);
      const preview = await this.producePredictedMeasurement();
      toBeDeleted.push(preview);

      const amplitudeCorrection = await this.generateFilterMeasurement();
      toBeDeleted.push(amplitudeCorrection);

      await preview.setZeroAtIrPeak();
      await preview.resetSmoothing();
      await preview.setIrWindows(this.parentViewModel.irWindowsChoices[1].config);

      const excessPhase = await preview.createExcessPhaseCopy();
      toBeDeleted.push(excessPhase);

      await excessPhase.resetSmoothing();

      const phaseCorrection = await excessPhase.arithmeticInvertAPhase(
        this,
        startFrequency,
        stopFrequency
      );
      toBeDeleted.push(phaseCorrection);

      const finalFIR = await phaseCorrection.arithmeticConvolution(amplitudeCorrection);

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
      await this.parentViewModel.removeMeasurements(toBeDeleted);
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

    await this.parentViewModel.setTargetLevelFromMeasurement(this);

    // must have only lower band filter to be able to use the high pass filter
    await this.resetFilters();
    await this.resetTargetSettings();
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
    await this.rewEq.setMatchTargetSettings({
      endFrequency: customEndFrequency,
    });
    await this.rewEq.setMatchTargetSettings({
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

    await this.rewMeasurements.matchTarget(this.uuid);

    // set filters auto to off to prevent overwriting by the second pass
    await this.setAllFiltersAuto(false);

    const filters = await this.getFilters();
    const availableSlots = this.countFiltersSlotsAvailable(filters);
    if (availableSlots < 2) {
      throw new Error(
        `Not enough filter slots available for ${this.displayMeasurementTitle()}. Please remove some filters.`
      );
    }

    await this.rewEq.setMatchTargetSettings({
      startFrequency: customInterPassFrequency / 2,
      endFrequency: customEndFrequency,
      individualMaxBoostdB: this.parentViewModel.individualMaxBoostValue(),
      overallMaxBoostdB: this.parentViewModel.overallBoostValue(),
    });

    await this.rewMeasurements.matchTarget(this.uuid);

    // retore filters auto to on for next iteration
    await this.setAllFiltersAuto(true);

    if (!useWokingSettings) {
      await this.applyWorkingSettings();
    }

    await this.checkFilterGain();

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
    const minimumPhase = await this.rewMeasurements.minimumPhaseVersion(this.uuid, {
      'include cal': true,
      'append lf tail': false,
      'append hf tail': false,
      'frequency warping': false,
      'replicate data': true,
    });

    return minimumPhase;
  }

  async createExcessPhaseCopy() {
    return await this.rewMeasurements.excessPhaseVersion(this.uuid, {
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
      lm.warn(`Invalid numeric value: ${value}`);
      return 0;
    }
    // Round to desired precision using Math.round (faster than toFixed)
    const multiplier = 10 ** precision;
    return Math.round(num * multiplier) / multiplier;
  }

  // Method to get data for saving
  toJSON() {
    return {
      title: this.title(),
      displayMeasurementTitle: this.displayMeasurementTitle(),
      channelName: this.channelName(),
      position: this.position(),
      distance: this.distanceInMeters(),
      splForAvr: this.splForAvr(),
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
      timeOfIRPeakSeconds: this.timeOfIRPeakSeconds(),
      crossover: this.crossover(),
      initialSplOffsetdB: this.initialSplOffsetdB,
      isFilter: this.isFilter,
      haveImpulseResponse: this.haveImpulseResponse,
      associatedFilter: this.associatedFilter,
      IRPeakValue: this.IRPeakValue,
      isSubOperationResult: this.isSubOperationResult,
      parentAttr: this.parentAttr,
      shiftDelay: this.shiftDelay(),
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

  get rewMeasurements() {
    return this.parentViewModel.rewMeasurements;
  }

  get rewEq() {
    return this.parentViewModel.rewEq;
  }

  async arithmeticSum(otherMeasurement) {
    const apiResponse = await this.rewMeasurements.arithmeticAPlusB(
      this.uuid,
      otherMeasurement.uuid
    );
    return this.parentViewModel.analyseApiResponse(apiResponse);
  }

  async arithmeticConvolution(otherMeasurement) {
    const apiResponse = await this.rewMeasurements.arithmeticATimesB(
      this.uuid,
      otherMeasurement.uuid
    );
    return this.parentViewModel.analyseApiResponse(apiResponse);
  }

  async arithmeticADividedByB(
    otherMeasurement,
    maxGain = null,
    lowerLimit = null,
    upperLimit = null
  ) {
    const apiResponse = await this.rewMeasurements.arithmeticADividedByB(
      this.uuid,
      otherMeasurement.uuid,
      maxGain,
      lowerLimit,
      upperLimit
    );
    return this.parentViewModel.analyseApiResponse(apiResponse);
  }

  async arithmeticInvertAPhase(otherMeasurement, lowerLimit = null, upperLimit = null) {
    const apiResponse = await this.rewMeasurements.arithmeticInvertAPhase(
      this.uuid,
      otherMeasurement.uuid,
      lowerLimit,
      upperLimit
    );
    return this.parentViewModel.analyseApiResponse(apiResponse);
  }

  dispose() {
    // Disposer tous les computed observables
    this.cumulativeIRDistanceMeters?.dispose();
    this.cumulativeIRDistanceSeconds?.dispose();
    this.isSelected?.dispose();
    this.getOtherGroupMember?.dispose();
    this.isChannelDetected?.dispose();
    this.exceedsDistance?.dispose();
    this.hasErrors?.dispose();
    this.otherPositionMeasurements?.dispose();
    // Disposer les subscriptions
    this.inverted?.subscription?.dispose();
    this.cumulativeIRShiftSeconds?.subscription?.dispose();
  }
}

export default MeasurementItem;
