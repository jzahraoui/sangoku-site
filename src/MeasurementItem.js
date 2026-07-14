import { CHANNEL_TYPES } from './audyssey.js';
import ko from 'knockout';
import BusinessTools from './BusinessTools.js';
import lm from './logs.js';
import { createPhaseMatchCalculator } from './autoeq/phase-match-calculator.js';
import {
  cleanFloat32Value,
  metersToSeconds,
  secondsToMeters,
} from './measurement/measurement-calculations.js';
import {
  MODEL_DISTANCE_CRITICAL_LIMIT,
  MODEL_DISTANCE_LIMIT,
} from './measurement/measurement-export.js';
import {
  AVR_MAX_GAIN,
  DEFAULT_LFE_PREDICTED,
  UNKNOWN_GROUP_NAME,
  channelDetailsFor,
  channelNameFromTitle,
  distanceInUnit,
  distanceSeverity,
  groupNameFor,
  isSubChannel,
  leftWindowWidthMilliseconds,
  predictedLfeTitle,
  speakerTypeFor,
  splForAvr,
  splIsAboveLimit,
} from './measurement/measurement-info.js';
import MeasurementRecord from './measurement/measurement-record.js';
import { createMeasurementOperations } from './services/measurement-operations.js';

// Simple REW wrappers live in src/services/measurement-operations.js;
// the methods below are thin adapters keeping the public API unchanged.
const ops = createMeasurementOperations({ log: lm });

class MeasurementItem {
  static AVR_MAX_GAIN = AVR_MAX_GAIN;
  static MODEL_DISTANCE_LIMIT = MODEL_DISTANCE_LIMIT;
  static MODEL_DISTANCE_CRITICAL_LIMIT = MODEL_DISTANCE_CRITICAL_LIMIT;
  static DEFAULT_LFE_PREDICTED = DEFAULT_LFE_PREDICTED;
  static DEFAULT_CROSSOVER_VALUE = 80;
  static UNKNOWN_GROUP_NAME = UNKNOWN_GROUP_NAME;
  static DEFAULT_TARGET_LEVEL = 75;

  static measurementType = { SPEAKERS: 0, SUB: 1, FILTER: 2, AVERAGE: 3 };

  constructor(item, parentViewModel) {
    // Validate inputs
    if (!item || !parentViewModel) {
      throw new Error('Invalid parameters for MeasurementItem creation');
    }

    this.speedOfSound = parentViewModel.jsonAvrData()?.avr?.speedOfSound || 343; // default to 343 m/s if not available
    this.detectedChannels = parentViewModel.jsonAvrData()?.detectedChannels || [];

    this.parentViewModel = parentViewModel;

    // ADR 002 — the flat REW/application state lives on the record; this
    // adapter exposes it through accessors and mirror observables.
    this.record = new MeasurementRecord(item, {
      onInvalidNumber: raw => lm.warn(`Invalid numeric value: ${raw}`),
    });

    for (const field of MeasurementRecord.PLAIN_FIELDS) {
      Object.defineProperty(this, field, {
        get: () => this.record[field],
        set: value => {
          this.record[field] = value;
        },
        enumerable: true,
        configurable: true,
      });
    }

    this.title = ko.observable(this.record.title);
    this.inverted = ko.observable(this.record.inverted);
    this.splOffsetdB = ko.observable(this.record.splOffsetdB);
    this.alignSPLOffsetdB = ko.observable(this.record.alignSPLOffsetdB);
    this.cumulativeIRShiftSeconds = ko.observable(this.record.cumulativeIRShiftSeconds);
    this.timeOfIRPeakSeconds = ko.observable(this.record.timeOfIRPeakSeconds);
    this.shiftDelay = ko.observable(this.record.shiftDelay);

    // Direct observable writes (UI bindings, subscriptions) flow back to the
    // record so it stays the single source of truth during the transition.
    this._recordMirrorSubscriptions = MeasurementRecord.OBSERVABLE_FIELDS.map(field =>
      this[field].subscribe(value => {
        this.record[field] = value;
      }),
    );

    this.measurementType = MeasurementItem.measurementType.SPEAKERS;

    // required for calculations using speed of sound
    if (!parentViewModel.jsonAvrData()?.avr && this.haveImpulseResponse) {
      throw new Error(
        'No AVR data loaded. please remove all measurements or load AVR information',
      );
    }

    // Observable properties
    this.numberOfpositions = ko.observable(0);
    this.positionName = ko.observable('');
    this.displayPositionText = ko.observable('');

    // Computed properties — derivations delegate to src/measurement/measurement-info.js
    this.channelName = ko.computed(() => channelNameFromTitle(this.title()));

    this.channelDetails = ko.computed(() =>
      channelDetailsFor(this.channelName(), this.detectedChannels, this.haveImpulseResponse),
    );

    this.groupName = ko.computed(() => groupNameFor(this.channelDetails()));
    this.crossover = ko.computed(() =>
      this.parentViewModel.measurementsByGroup()[this.groupName()]?.crossover(),
    );
    this.isSub = ko.computed(() => isSubChannel(this.channelDetails()));
    // Le crossover est une propriété de GROUPE : les contrôles de groupe (find best
    // crossover) ne s'affichent que sur le représentant, la 1re enceinte du groupe.
    this.isFirstOfGroup = ko.pureComputed(() => {
      if (this.isSub()) return false;
      const members = this.parentViewModel
        .uniqueSpeakersMeasurements()
        .filter(m => m.groupName() === this.groupName());
      return members.length > 0 && members[0].uuid === this.uuid;
    });
    this.speakerType = ko.pureComputed(() =>
      speakerTypeFor(this.isSub(), this.crossover()),
    );

    this.leftWindowWidthMilliseconds = ko.computed(() =>
      leftWindowWidthMilliseconds(this.isSub()),
    );
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

    this.measurementIndex = ko.computed(
      () => this.parentViewModel.measurements().indexOf(this) + 1,
    );
    this.relatedLfeMeasurement = ko.computed(() => {
      return this.parentViewModel
        .allPredictedLfeMeasurement()
        .find(response => response?.title() === predictedLfeTitle(this.position()));
    });
    this.absoluteIRPeakSeconds = ko.pureComputed(() =>
      this.haveImpulseResponse
        ? this.timeOfIRPeakSeconds() + this.cumulativeIRShiftSeconds()
        : 0,
    );
    this.displayMeasurementTitle = ko.computed(
      () => `${this.measurementIndex()}: ${this.title()}`,
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
      return distanceInUnit(
        this.parentViewModel.distanceUnit(),
        this.distanceInMeters(),
        this.cumulativeIRShiftSeconds(),
      );
    });

    this.splOffsetDeltadB = ko.computed(() =>
      MeasurementItem.cleanFloat32Value(this.splOffsetdB() - this.initialSplOffsetdB, 2),
    );
    this.splForAvr = ko.computed(() => splForAvr(this.splOffsetDeltadB()));
    this.splIsAboveLimit = ko.computed(() =>
      splIsAboveLimit(this.splForAvr(), MeasurementItem.AVR_MAX_GAIN),
    );
    this.splresidual = ko.computed(() => this.splOffsetDeltadB() - this.splForAvr());
    this.cumulativeIRDistanceMeters = ko.computed(
      () => this.parentViewModel.maxDistanceInMeters() - this.distanceInMeters(),
    );
    this.cumulativeIRDistanceSeconds = ko.computed(() =>
      this._computeInSeconds(this.cumulativeIRDistanceMeters()),
    );
    this.isSelected = ko.computed(
      () => this.parentViewModel.currentSelectedPosition() === this.position(),
    );
    this.getOtherGroupMember = ko.computed(() =>
      CHANNEL_TYPES.getGroupMembers(this.channelDetails()?.group),
    );

    // Create a computed observable for the channel detection check
    this.isChannelDetected = ko.pureComputed(() => {
      const details = this.channelDetails();
      if (!details) return false;
      return (
        this.isSelected() &&
        this.detectedChannels?.some(m => m.enChannelType === details.channelIndex)
      );
    });
    this.exceedsDistance = ko.computed(() => {
      if (!this.parentViewModel) {
        return 'normal';
      }
      return distanceSeverity(
        this.distanceInMeters(),
        this.parentViewModel.maxDistanceInMetersWarning(),
        this.parentViewModel.maxDistanceInMetersError(),
      );
    });
    this.hasErrors = ko.computed(
      () =>
        this.splIsAboveLimit() ||
        this.exceedsDistance() === 'error' ||
        !this.isChannelDetected(),
    );


    this.buttonCreateRchFilter = async () => {
      if (parentViewModel.isProcessing()) return;
      try {
        await parentViewModel.setProcessing(true);

        await this.createPhaseMatchFilter();
        return true;
      } catch (error) {
        parentViewModel.handleError(`Filter creation failed: ${error.message}`, error);
        return false;
      } finally {
        await parentViewModel.setProcessing(false);
      }
    };

    this.buttonCreateSelectedFilter = async () => {
      if (parentViewModel.isProcessing()) return;
      try {
        await parentViewModel.setProcessing(true);

        await parentViewModel.createSpeakerFilterForSelectedMode(this);
        return true;
      } catch (error) {
        parentViewModel.handleError(`Filter creation failed: ${error.message}`, error);
        return false;
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
        return true;
      } catch (error) {
        parentViewModel.handleError(`Preview creation failed: ${error.message}`, error);
        return false;
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
            response.position() !== this.position(),
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

    this.updateFromApi(item);
  }

  updateFromApi(item) {
    if (!item) {
      return this;
    }

    // The record owns the whitelist semantics; mirror the changed fields onto
    // the KO observables (plain fields are accessors over the record already).
    const changed = this.record.update(item);
    for (const field of MeasurementRecord.OBSERVABLE_FIELDS) {
      if (Object.hasOwn(changed, field) && typeof this[field] === 'function') {
        this[field](changed[field]);
      }
    }

    return this;
  }

  // ADR 002 write-back contract used by measurement-operations services.
  update(partial) {
    return this.updateFromApi(partial);
  }

  // Compute methods — delegate to src/measurement/measurement-calculations.js
  _computeInMeters(valueInSeconds) {
    return secondsToMeters(valueInSeconds, this.speedOfSound);
  }

  _computeInSeconds(valueInMeters) {
    return metersToSeconds(valueInMeters, this.speedOfSound);
  }

  // funtion is accessible from the UI
  async toggleInversion() {
    const allreadyProcessing = this.parentViewModel.isProcessing();
    try {
      if (!allreadyProcessing) await this.parentViewModel.setProcessing(true);
      await ops.toggleInversion(this.rewMeasurements, this);

      return true;
    } catch (error) {
      const message = `Failed to toggle inversion for ${this.displayMeasurementTitle()}: ${
        error.message
      }`;
      if (allreadyProcessing) {
        throw new Error(message, { cause: error });
      }
      this.parentViewModel.handleError(message, error);
      return false;
    } finally {
      if (!allreadyProcessing) await this.parentViewModel.setProcessing(false);
    }
  }

  // The slice of the viewmodel that owns the measurement list, consumed by the
  // sequence operations until the rew-session service exists.
  sessionContext() {
    return {
      analyseApiResponse: response => this.parentViewModel.analyseApiResponse(response),
      removeMeasurements: items => this.parentViewModel.removeMeasurements(items),
      removeMeasurementUuid: uuid => this.parentViewModel.removeMeasurementUuid(uuid),
      findMeasurementByUuid: uuid => this.parentViewModel.findMeasurementByUuid(uuid),
    };
  }

  irWindowWidths() {
    return {
      leftWindowWidthms: this.leftWindowWidthMilliseconds(),
      rightWindowWidthms: this.rightWindowWidthMilliseconds,
    };
  }

  async resetAll(targetLevel = MeasurementItem.DEFAULT_TARGET_LEVEL) {
    return ops.resetAll(this.rewMeasurements, this, {
      targetLevel,
      irWindowWidths: this.irWindowWidths(),
      equaliserDefaults: this.rewEq.defaultEqtSettings,
      session: this.sessionContext(),
    });
  }

  async resetSmoothing() {
    return ops.resetSmoothing(this.rewMeasurements, this);
  }

  async defaultSmoothing() {
    return ops.defaultSmoothing(
      this.rewMeasurements,
      this,
      this.parentViewModel.selectedSmoothingMethod(),
    );
  }

  async setSmoothing(smoothingMethod) {
    return ops.setSmoothing(this.rewMeasurements, this, smoothingMethod);
  }

  async resetIrWindows() {
    return ops.resetIrWindows(this.rewMeasurements, this, this.irWindowWidths());
  }

  async resetTargetSettings() {
    return ops.resetTargetSettings(this.rewMeasurements, this);
  }

  async resetRoomCurveSettings() {
    return ops.resetRoomCurveSettings(this.rewMeasurements, this);
  }

  async setRoomCurveSettings(settings) {
    return ops.setRoomCurveSettings(this.rewMeasurements, this, settings);
  }

  async getEqualiser() {
    return ops.getEqualiser(this.rewMeasurements, this);
  }

  async isdefaultEqualiser() {
    return ops.isDefaultEqualiser(this.rewMeasurements, this, this.rewEq.defaultEqtSettings);
  }

  async resetEqualiser() {
    return ops.resetEqualiser(this.rewMeasurements, this, this.rewEq.defaultEqtSettings);
  }

  async setIrWindows(irWindowsObject) {
    return ops.setIrWindows(this.rewMeasurements, this, irWindowsObject);
  }

  async trimIRToWindows() {
    return ops.trimIRToWindows(this.rewMeasurements, this, this.sessionContext());
  }

  async responseCopy() {
    return ops.responseCopy(this.rewMeasurements, this);
  }

  async setTargetSettings(targetSettings) {
    return ops.setTargetSettings(this.rewMeasurements, this, targetSettings);
  }

  async getImpulseResponse(freq, unit = 'percent', windowed = true, normalised = true) {
    return ops.getImpulseResponse(this.rewMeasurements, this, {
      freq,
      unit,
      windowed,
      normalised,
    });
  }

  async getFilterImpulseResponse(freq, sampleCount) {
    return ops.getFilterImpulseResponse(this.rewMeasurements, this, {
      freq,
      sampleCount,
    });
  }

  async resolveSampleRate() {
    return ops.resolveSampleRate(this.rewMeasurements, this);
  }

  createPhaseMatchCalculator(sampleRate, freqStart, freqEnd, options = {}) {
    return createPhaseMatchCalculator({
      sampleRate,
      freqStart,
      freqEnd,
      autoEqConfig: this.parentViewModel.autoEqConfig,
      individualMaxBoostDb:
        options.individualMaxBoostDb ?? this.parentViewModel.individualMaxBoostValue(),
      overallMaxBoostDb:
        options.overallMaxBoostDb ?? this.parentViewModel.overallBoostValue(),
    });
  }

  async restoreWorkingSettings(useWorkingSettings, operationError) {
    return ops.restoreWorkingSettings(
      this.rewMeasurements,
      this,
      this.workingSettingsConfig(),
      useWorkingSettings,
      operationError,
    );
  }

  async getPredictedImpulseResponse(
    freq,
    unit = 'percent',
    windowed = true,
    normalised = true,
  ) {
    return ops.getPredictedImpulseResponse(this.rewMeasurements, this, {
      freq,
      unit,
      windowed,
      normalised,
    });
  }

  async getFrequencyResponse(unit = 'SPL', smoothing = 'None', ppo = null) {
    return ops.getFrequencyResponse(this.rewMeasurements, this, {
      unit,
      smoothing,
      ppo,
    });
  }

  async detectFallOff(threshold = -3, ppo = 12) {
    return ops.detectFallOff(this.rewMeasurements, this, { threshold, ppo });
  }

  async getTargetResponse(unit = 'SPL', ppo = 96) {
    return ops.getTargetResponse(this.rewMeasurements, this, { unit, ppo });
  }

  async delete() {
    await this.parentViewModel.removeMeasurement(this);
  }

  async setInverted(inverted) {
    // the toggle callback keeps the processing lock/error shell of toggleInversion
    return ops.setInverted(this.rewMeasurements, this, inverted, {
      toggle: () => this.toggleInversion(),
    });
  }

  async setTitle(newTitle, notescontent) {
    return ops.setTitle(this.rewMeasurements, this, newTitle, notescontent);
  }

  async resetcumulativeIRShiftSeconds() {
    return ops.resetcumulativeIRShiftSeconds(this.rewMeasurements, this);
  }

  async setcumulativeIRShiftSeconds(newValue) {
    return ops.setcumulativeIRShiftSeconds(this.rewMeasurements, this, newValue);
  }

  async addIROffsetSeconds(amountToAdd) {
    return ops.addIROffsetSeconds(this.rewMeasurements, this, amountToAdd);
  }

  async getImpulseResponseInfo() {
    return ops.getImpulseResponseInfo(this.rewMeasurements, this);
  }

  async setZeroAtIrPeak() {
    return ops.setZeroAtIrPeak(this.rewMeasurements, this);
  }

  async getBandwidth() {
    return ops.getBandwidth(this.rewMeasurements, this);
  }

  async setSPLOffsetDB(newValue) {
    return ops.setSPLOffsetDB(this.rewMeasurements, this, newValue);
  }

  async addSPLOffsetDB(amountToAdd) {
    return ops.addSPLOffsetDB(this.rewMeasurements, this, amountToAdd);
  }

  async getFilters() {
    return ops.getFilters(this.rewMeasurements, this);
  }

  async setFilters(filters, overwrite = true) {
    return ops.setFilters(this.rewMeasurements, this, filters, {
      overwrite,
    });
  }

  async setSingleFilter(filter) {
    return ops.setSingleFilter(this.rewMeasurements, this, filter);
  }

  async getFreeXFilterIndex() {
    return ops.getFreeXFilterIndex(
      this.rewMeasurements,
      this,
      this.rewEq.defaultEqtSettings,
    );
  }

  async copyFiltersToOther() {
    return ops.copyFiltersToOther(
      this.rewMeasurements,
      this,
      this.otherPositionMeasurements(),
      this.sessionContext(),
    );
  }

  async copySplOffsetDeltadBToOther() {
    return ops.copySplOffsetDeltadBToOther(
      this.rewMeasurements,
      this,
      this.otherPositionMeasurements(),
    );
  }

  async copyCumulativeIRShiftToOther() {
    return ops.copyCumulativeIRShiftToOther(
      this.rewMeasurements,
      this,
      this.otherPositionMeasurements(),
    );
  }

  async copyInversionToOtherPositions() {
    const targets = this.otherPositionMeasurements();
    if (!targets.length) return;

    // processing lock is a UI concern — the copy loop itself lives in the service
    const allreadyProcessing = this.parentViewModel.isProcessing();
    if (!allreadyProcessing) await this.parentViewModel.setProcessing(true);

    await ops.copyInversionToOtherPositions(this.rewMeasurements, this, targets);

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
    return ops.getTargetLevel(this.rewMeasurements, this);
  }

  async setTargetLevel(level) {
    return ops.setTargetLevel(this.rewMeasurements, this, level);
  }

  async resetFilters() {
    return ops.resetFilters(this.rewMeasurements, this);
  }

  async producePredictedMeasurement() {
    return ops.producePredictedMeasurement(
      this.rewMeasurements,
      this,
      this.sessionContext(),
    );
  }

  // Snapshot of the viewmodel settings consumed by working-settings operations.
  workingSettingsConfig() {
    return {
      smoothingMethod: this.parentViewModel.selectedSmoothingMethod(),
      roomCurveSettings: this.parentViewModel.getRoomCurveConfig(),
      irWindows: this.parentViewModel.selectedIrWindowsConfig(),
    };
  }

  async applyWorkingSettings() {
    return ops.applyWorkingSettings(
      this.rewMeasurements,
      this,
      this.workingSettingsConfig(),
    );
  }

  async removeWorkingSettings() {
    return ops.removeWorkingSettings(this.rewMeasurements, this, this.irWindowWidths());
  }

  async checkFilterGain() {
    return ops.checkFilterGain(this.rewMeasurements, this);
  }

  // Dependencies of the filter-creation sequences that still live on the
  // viewmodel (configs, AutoEQ calculator, target-level sync).
  filterCreationContext() {
    const pv = this.parentViewModel;
    return {
      session: this.sessionContext(),
      workingConfig: this.workingSettingsConfig(),
      irWindowWidths: this.irWindowWidths(),
      smoothingMethod: pv.selectedSmoothingMethod(),
      optimizedMtwWindows: () => pv.getIrWindowConfig('Optimized MTW'),
      bounds: {
        lower: pv.lowerFrequencyBound(),
        upper: pv.upperFrequencyBound(),
      },
      boosts: {
        individual: pv.individualMaxBoostValue(),
        overall: pv.overallBoostValue(),
      },
      createCalculator: (sampleRate, freqStart, freqEnd, options) =>
        this.createPhaseMatchCalculator(sampleRate, freqStart, freqEnd, options),
      setTargetLevelFromMeasurement: () => pv.setTargetLevelFromMeasurement(this),
      otherTargets: () => this.otherPositionMeasurements(),
    };
  }

  async createFilter(type, useWorkingSettings, copyFiltersToOther) {
    return ops.createFilter(
      this.rewMeasurements,
      this,
      this.filterCreationContext(),
      type,
      useWorkingSettings,
      copyFiltersToOther,
    );
  }

  async _runPhaseMatchFilter(customStartFrequency, customEndFrequency, options = {}) {
    return ops.runPhaseMatchFilter(
      this.rewMeasurements,
      this,
      this.filterCreationContext(),
      customStartFrequency,
      customEndFrequency,
      options,
    );
  }

  async createPhaseMatchFilter(useWorkingSettings = true, copyFiltersToOther = false) {
    return this.createFilter('phase', useWorkingSettings, copyFiltersToOther);
  }

  async setAllFiltersAuto(requiredState = true) {
    return ops.setAllFiltersAuto(this.rewMeasurements, this, requiredState);
  }

  async createMinimumPhaseCopy() {
    return ops.createMinimumPhaseCopy(this.rewMeasurements, this);
  }

  async createExcessPhaseCopy() {
    return ops.createExcessPhaseCopy(this.rewMeasurements, this);
  }

  static cleanFloat32Value(value, precision = 7) {
    return cleanFloat32Value(value, precision, raw =>
      lm.warn(`Invalid numeric value: ${raw}`),
    );
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
    return ops.arithmeticSum(
      this.rewMeasurements,
      this,
      otherMeasurement,
      this.sessionContext(),
    );
  }

  async arithmeticConvolution(otherMeasurement) {
    return ops.arithmeticConvolution(
      this.rewMeasurements,
      this,
      otherMeasurement,
      this.sessionContext(),
    );
  }

  async arithmeticADividedByB(
    otherMeasurement,
    maxGain = null,
    lowerLimit = null,
    upperLimit = null,
  ) {
    return ops.arithmeticADividedByB(
      this.rewMeasurements,
      this,
      otherMeasurement,
      this.sessionContext(),
      maxGain,
      lowerLimit,
      upperLimit,
    );
  }

  async arithmeticInvertAPhase(otherMeasurement, lowerLimit = null, upperLimit = null) {
    return ops.arithmeticInvertAPhase(
      this.rewMeasurements,
      this,
      otherMeasurement,
      this.sessionContext(),
      lowerLimit,
      upperLimit,
    );
  }

  dispose() {
    // Disposer tous les computed observables
    for (const name of [
      'cumulativeIRDistanceMeters',
      'cumulativeIRDistanceSeconds',
      'isSelected',
      'getOtherGroupMember',
      'isChannelDetected',
      'exceedsDistance',
      'hasErrors',
      'otherPositionMeasurements',
    ]) {
      this[name]?.dispose();
    }
    // Disposer les subscriptions
    this.inverted?.subscription?.dispose();
    this.cumulativeIRShiftSeconds?.subscription?.dispose();
    this._recordMirrorSubscriptions?.forEach(subscription => subscription.dispose());
  }
}

export default MeasurementItem;
