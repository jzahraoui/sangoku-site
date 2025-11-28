import MeasurementItem from './MeasurementItem.js';
import lm from './logs.js';

class BusinessTools {
  static LPF_REVERTED_SUFFIX = ' w/o LPF';
  static RESULT_PREFIX = 'final ';
  static AVERAGE_SUFFIX = 'avg';

  constructor(parentViewModel) {
    // Validate inputs
    if (!parentViewModel) {
      throw new Error('Parent ViewModel is required');
    }
    this.viewModel = parentViewModel;
  }

  get rewMeasurements() {
    return this.viewModel.rewMeasurements;
  }

  async revertLfeFilterProccess(freq, replaceOriginal = false, deletePrevious = true) {
    try {
      const previousSubResponses = this.viewModel
        .subsMeasurements()
        .filter(response => response.title().includes(BusinessTools.LPF_REVERTED_SUFFIX));
      if (deletePrevious) {
        await this.viewModel.removeMeasurements(previousSubResponses);
      }

      await this.revertLfeFilterProccessList(
        this.viewModel.subsMeasurements(),
        freq,
        replaceOriginal
      );
    } catch (error) {
      throw new Error(`Error: ${error.message}`, { cause: error });
    }
  }

  async revertLfeFilterProccessList(subResponses, freq, replaceOriginal = false) {
    if (!subResponses?.length) {
      throw new Error('No subwoofer measurements found');
    }
    if (!freq || typeof freq !== 'number') {
      throw new TypeError('Frequency must be a number');
    }
    if (subResponses.some(response => !response.isSub())) {
      throw new Error('Not all measurements are subwoofer');
    }

    try {
      // Create low-pass filter using first measurement
      const lowPassFilter = await this.createLowPassFilter(subResponses[0], freq);
      const resultsUuids = [];

      // Process each subwoofer response
      for (const subResponse of subResponses) {
        // Save original state
        const originalState = {
          inverted: subResponse.inverted(),
          delay: subResponse.cumulativeIRShiftSeconds(),
          filters: await subResponse.getFilters(),
        };

        // Reset state for division operation
        await subResponse.setInverted(false);
        await subResponse.setcumulativeIRShiftSeconds(0);

        lm.debug(`Setting limit frequency to ${freq * 2}Hz for LFE filter reversion`);

        // Create new measurement with canceled LFE filter effect
        const division = await subResponse.arithmeticADividedByB(
          lowPassFilter,
          null,
          null,
          freq * 2
        );

        // Handle original measurement
        if (!replaceOriginal) {
          // Restore original state
          await subResponse.setInverted(originalState.inverted);
          await subResponse.setcumulativeIRShiftSeconds(originalState.delay);
        }

        // Set new measurement properties
        const newTitle = replaceOriginal
          ? subResponse.title()
          : subResponse.title() + BusinessTools.LPF_REVERTED_SUFFIX;

        await division.setTitle(newTitle);
        await division.setInverted(originalState.inverted);
        await division.setcumulativeIRShiftSeconds(originalState.delay);
        await division.setFilters(originalState.filters);
        division.revertLfeFrequency = freq;

        resultsUuids.push(division.uuid);
      }

      // Clean up the temporary filter
      await this.viewModel.removeMeasurement(lowPassFilter);
      if (replaceOriginal) {
        // Remove original sub responses if replacing
        await this.viewModel.removeMeasurements(subResponses);
      }
      return resultsUuids;
    } catch (error) {
      throw new Error(`${error.message}`, { cause: error });
    }
  }

  async createLowPassFilter(measurement, freq) {
    // Save current filters
    const originalFilters = await measurement.getFilters();

    // Create low-pass filter configuration
    const lowPassFilterSet = Array.from({ length: 20 }, (_, i) => ({
      index: i + 1,
      type: 'None',
      enabled: true,
      isAuto: false,
    }));

    // Add low-pass filter at index 21
    lowPassFilterSet.push(
      {
        index: 21,
        type: 'Low pass',
        enabled: true,
        isAuto: false,
        frequency: freq,
        shape: 'L-R',
        slopedBPerOctave: 24,
      },
      {
        index: 22,
        type: 'None',
        enabled: true,
        isAuto: false,
      }
    );

    // Apply filters and generate filter measurement
    await measurement.setFilters(lowPassFilterSet);
    const filter = await measurement.generateFilterMeasurement();

    // Restore original filters
    await measurement.setFilters(originalFilters);

    return filter;
  }

  // Process grouped responses and create UUID arrays
  async processGroupedResponses(groupedResponse, avgMethod, deleteOriginal) {
    // Input validation
    if (!groupedResponse || typeof groupedResponse !== 'object') {
      throw new Error('Invalid groupedResponse input');
    }
    if (Object.keys(groupedResponse).length < 2) {
      throw new Error('Parameter must contains at least 2 elements');
    }

    // Process each code group sequentially
    for (const code of Object.keys(groupedResponse)) {
      if (!groupedResponse[code]?.items || code === MeasurementItem.UNKNOWN_GROUP_NAME) {
        continue;
      }

      // exclude previous results and create array of UUIDs for the current code group
      const usableItems = groupedResponse[code].items.filter(
        item => !item.isAverage && !item.isPredicted
      );

      // Process the collected indices
      if (usableItems.length < 2) {
        throw new Error(`Need at least 2 measurements to make an average: ${code}`);
      }

      // remove inversion and gain for each item
      for (const measurement of usableItems) {
        await measurement.setInverted(false);
      }

      // Get UUIDs of usable items
      const uuids = usableItems.map(item => item.uuid);

      // Cross correlation alignment
      lm.debug(`${code}: ${uuids.length} measures cross corr align...`);
      await this.rewMeasurements.crossCorrAlign(uuids);

      // average processing
      lm.debug(`${code}: ${uuids.length} measures ${avgMethod}...`);
      const apiResponse = await this.rewMeasurements.processMeasurements(
        avgMethod,
        uuids
      );
      const vectorAverage = await this.viewModel.analyseApiResponse(apiResponse);

      // Update title
      if (!vectorAverage) {
        throw new Error(`${code}: can not rename the average...`);
      }

      await vectorAverage.setTitle(code + BusinessTools.AVERAGE_SUFFIX);

      await this._deleteOriginalMeasurements(uuids, deleteOriginal);
    }

    return true;
  }

  async _deleteOriginalMeasurements(uuids, deleteOriginal) {
    if (!deleteOriginal || uuids.length < 2) {
      return;
    }

    if (deleteOriginal === 'none') {
      return;
    }

    if (deleteOriginal !== 'all' && deleteOriginal !== 'all_but_1') {
      throw new Error(`Invalid deleteOriginal parameter: ${deleteOriginal}`);
    }

    const startIndex = deleteOriginal === 'all_but_1' ? 1 : 0;

    for (let i = startIndex; i < uuids.length; i++) {
      await this.viewModel.removeMeasurementUuid(uuids[i]);
    }
  }

  /**
   * Search through JSON objects by attribute values
   * @param {Object} jsonData - Array of JSON objects to search through
   * @param {Object} searchCriteria - Object containing attribute-value pairs to search for
   * @param {Object} options - Search options (optional)
   * @returns {Array} Matching JSON objects
   */
  filterResponses(jsonData, searchCriteria, options = {}) {
    const { caseSensitive = false, matchAll = true, partialMatch = true } = options;

    if (
      !jsonData ||
      typeof jsonData !== 'object' ||
      !searchCriteria ||
      typeof searchCriteria !== 'object'
    ) {
      return [];
    }

    // Convert the object to an array of its values
    const dataArray = Object.values(jsonData);

    return dataArray.filter(item => {
      // Handle each search criteria
      const matches = Object.entries(searchCriteria).map(([key, value]) => {
        // Skip if search value is null or undefined
        if (value == null) return true;

        // Get nested property value using key path (e.g., 'attributes.color')
        const itemValue = key.split('.').reduce((obj, k) => obj?.[k], item);

        // If item doesn't have the property, no match
        if (itemValue == null) return false;

        // Convert values to strings for comparison
        const searchStr = String(value);
        const itemStr = String(itemValue);

        if (partialMatch) {
          return caseSensitive
            ? itemStr.includes(searchStr)
            : itemStr.toLowerCase().includes(searchStr.toLowerCase());
        } else {
          return caseSensitive
            ? itemStr === searchStr
            : itemStr.toLowerCase() === searchStr.toLowerCase();
        }
      });

      // Return true if all criteria match (AND) or any criteria matches (OR)
      return matchAll ? matches.every(Boolean) : matches.some(Boolean);
    });
  }

  /**
   * Imports and applies filter configurations from REW (Room EQ Wizard) to subwoofer responses
   * @param {Array} REWconfigs - Array of REW configuration objects
   * @param {Object} subResponses - Object containing subwoofer response measurements
   */
  async importFilterInREW(REWconfigs, subResponses) {
    // Process each REW configuration sequentially
    for (const { filters, channel, invert, gain, delay } of REWconfigs) {
      try {
        // Find item in allResponses that has title beginning with channel
        const foundItem = Object.values(subResponses).find(item =>
          item?.title()?.toLowerCase().startsWith(channel.toLowerCase())
        );

        if (!foundItem) {
          throw new Error(`Cannot find measurement name matching ${channel}`);
        }
        // Apply filters
        await foundItem.setFilters(filters);
        // invert
        if (invert === -1) {
          await foundItem.setInverted(true);
        } else if (invert === 1) {
          await foundItem.setInverted(false);
        } else {
          throw new Error(`Invalid invert value for ${channel}`);
        }
        // reverse delay if previous iteration and apply specified delay
        await foundItem.setcumulativeIRShiftSeconds(-delay / 1000);

        await foundItem.setSPLOffsetDB(gain);
      } catch (error) {
        throw new Error(`Error processing channel ${channel}: ${error.message}`, {
          cause: error,
        });
      }
    }
  }

  validateInputs(PredictedLfe, speakerItem, cuttOffFrequency) {
    if (!speakerItem) throw new Error(`Please select a speaker item`);
    if (!PredictedLfe) throw new Error(`Cannot find predicted LFE`);
    if (cuttOffFrequency === 0) {
      lm.debug('Speaker are full range, no cuttoff frequency');
    }
    if (cuttOffFrequency < 20 || cuttOffFrequency > 250) {
      throw new Error('CuttOffFrequency must be between 20Hz and 250Hz');
    }
    if (!PredictedLfe.haveImpulseResponse) {
      throw new Error('Invalid PredictedLfe object or missing cumulativeIRShiftSeconds');
    }
  }

  getAvailableSubDistances(subResponses) {
    const distances = subResponses.map(sub => sub.distanceInMeters());

    const availableDistance =
      this.viewModel.maxDistanceInMetersError() - Math.max(...distances);

    return availableDistance;
  }

  /**
   * Aligns a subwoofer (LFE) with a speaker by calculating and applying the optimal time offset
   *
   */
  async produceAligned(speakerItem, subResponses) {
    const cuttOffFrequency = speakerItem.crossover();
    const PredictedLfe = speakerItem.relatedLfeMeasurement();
    this.validateInputs(PredictedLfe, speakerItem, cuttOffFrequency);

    const mustBeDeleted = [];
    try {
      const predictedFrontLeft = await speakerItem.producePredictedMeasurement();
      mustBeDeleted.push(predictedFrontLeft);

      const { PredictedLfeFiltered, predictedSpeakerFiltered } =
        await this.applyCutOffFilter(PredictedLfe, predictedFrontLeft, cuttOffFrequency);
      mustBeDeleted.push(PredictedLfeFiltered, predictedSpeakerFiltered);

      const cutoffPeriod = 1 / cuttOffFrequency; // for 100Hz, period is 10ms
      const delay = cutoffPeriod / 16; // for 100Hz, delay is 0.625ms
      const maxForwardSearchMs = Math.round((cutoffPeriod / 2) * 1000 * 100) / 100;

      // get the sub impulse closer to the front left, better method than cros corr align
      const distanceToSpeakerPeak =
        PredictedLfeFiltered.timeOfIRPeakSeconds() -
        predictedSpeakerFiltered.timeOfIRPeakSeconds();
      let finalDistance = distanceToSpeakerPeak - delay;

      const neededDistanceMeter =
        PredictedLfe.distanceInMeters() + PredictedLfe._computeInMeters(finalDistance);

      // Calculate and apply adjustment to stay within maximum distance
      const overheadOffset =
        this.getAvailableSubDistances(subResponses) - neededDistanceMeter;

      if (overheadOffset < 0) {
        lm.warn(
          `Adjusting alignment by ${-overheadOffset.toFixed(
            2
          )}m to stay within max distance limit.`
        );
        finalDistance += PredictedLfe._computeInSeconds(overheadOffset);
      }

      await PredictedLfeFiltered.addIROffsetSeconds(finalDistance);

      const { shiftDelay, isBInverted } = await this.viewModel.findAligment(
        predictedSpeakerFiltered,
        PredictedLfeFiltered,
        cuttOffFrequency,
        maxForwardSearchMs,
        false,
        `${
          BusinessTools.RESULT_PREFIX
        }${predictedSpeakerFiltered.title()} X@${cuttOffFrequency}Hz_P${predictedSpeakerFiltered.position()}`,
        0
      );

      if (isBInverted) {
        await PredictedLfe.toggleInversion();
      }

      finalDistance -= shiftDelay;

      await PredictedLfe.addIROffsetSeconds(finalDistance);
      await this.applyTimeOffsetToSubs(finalDistance, subResponses, isBInverted);

      const shiftDistance = PredictedLfe._computeInMeters(finalDistance).toFixed(2);
      lm.info(
        `Subwoofer deplaced by: ${shiftDistance}m (alignment:${(
          (delay + shiftDelay) *
          1000
        ).toFixed(2)}ms)`
      );
    } finally {
      await this.viewModel.removeMeasurements(mustBeDeleted);
    }
  }

  /**
   * Applies crossover filters to subwoofer and speaker measurements
   */
  async applyCutOffFilter(sub, speaker, cutOffFrequency) {
    if (cutOffFrequency === 0) {
      return {
        PredictedLfeFiltered: sub.responseCopy(),
        predictedSpeakerFiltered: speaker.responseCopy(),
      };
    }

    // make sure equaliser is Generic to allow Low pass and High pass filters
    await sub.resetEqualiser();
    await speaker.resetEqualiser();

    // lookup free filter index
    const subIndex = await sub.getFreeXFilterIndex();
    const speakerIndex = await speaker.getFreeXFilterIndex();
    if (subIndex === -1 || speakerIndex === -1) {
      throw new Error('Cannot find free filter index');
    }

    try {
      // set filters
      await sub.setSingleFilter({
        index: subIndex,
        enabled: true,
        isAuto: false,
        type: 'Low pass',
        frequency: cutOffFrequency,
        shape: 'L-R',
        slopedBPerOctave: 24,
      });
      await speaker.setSingleFilter({
        index: speakerIndex,
        enabled: true,
        isAuto: false,
        type: 'High pass',
        frequency: cutOffFrequency,
        shape: 'BU',
        slopedBPerOctave: 12,
      });

      const PredictedLfeFiltered = await sub.producePredictedMeasurement();
      const predictedSpeakerFiltered = await speaker.producePredictedMeasurement();

      return { PredictedLfeFiltered, predictedSpeakerFiltered };
    } finally {
      // restore filters to None
      await sub.setSingleFilter({
        index: subIndex,
        type: 'None',
        enabled: true,
        isAuto: false,
      });

      await speaker.setSingleFilter({
        index: speakerIndex,
        type: 'None',
        enabled: true,
        isAuto: false,
      });
    }
  }

  async createMeasurementPreview(item) {
    // skip subs
    if (item.isSub()) return;
    if (item.isUnknownChannel) return;

    await item.removeWorkingSettings();

    const predictedChannel = await item.producePredictedMeasurement();

    let finalPredcition;
    if (item.crossover() === 0) {
      finalPredcition = predictedChannel;
    } else {
      const relatedLfeMeasurement = item.relatedLfeMeasurement();
      if (!relatedLfeMeasurement) {
        await this.viewModel.removeMeasurement(predictedChannel);
        // LFE predicted must be done by the user to ensure filters are correct
        throw new Error(`Cannot find predicted LFE for position ${item.position()}`);
      }

      await relatedLfeMeasurement.removeWorkingSettings();

      const { PredictedLfeFiltered, predictedSpeakerFiltered } =
        await this.applyCutOffFilter(
          relatedLfeMeasurement,
          predictedChannel,
          item.crossover()
        );

      await this.viewModel.removeMeasurement(predictedChannel);

      finalPredcition = await PredictedLfeFiltered.arithmeticSum(
        predictedSpeakerFiltered
      );
      // cleanup of predicted measurements
      await this.viewModel.removeMeasurements([
        PredictedLfeFiltered,
        predictedSpeakerFiltered,
      ]);

      await relatedLfeMeasurement.applyWorkingSettings();
    }
    // set title
    const cxText = item.crossover() ? `X@${item.crossover()}Hz` : 'FB';
    const finalTitle = `${
      BusinessTools.RESULT_PREFIX
    }${item.title()} ${cxText}_P${item.position()}`;
    await finalPredcition.setTitle(finalTitle);

    await finalPredcition.setSmoothing('Psy');
    await item.applyWorkingSettings();
  }

  async applyTimeOffsetToSubs(offset, subResponses, mustBeInverted) {
    if (subResponses.length < 1) {
      return;
    }
    for (const subResponse of subResponses) {
      // shift by offset
      await subResponse.addIROffsetSeconds(offset);
      if (mustBeInverted) {
        await subResponse.toggleInversion();
      }
    }
  }

  async createsSum(itemList, title, deletePredicted = true) {
    if (!Array.isArray(itemList) || !itemList.length) {
      throw new Error('Parameter must be a non-empty array');
    }

    const generatedPredicted = [];
    const intermediateSumUuids = [];

    try {
      // Generate predicted measurements
      for (const measurementItem of itemList) {
        await measurementItem.removeWorkingSettings();
        await measurementItem.resetTargetSettings();
        generatedPredicted.push(await measurementItem.producePredictedMeasurement());
        await measurementItem.applyWorkingSettings();
      }

      // Sum all measurements
      let result = generatedPredicted[0];
      for (let i = 1; i < generatedPredicted.length; i++) {
        intermediateSumUuids.push(result);
        result = await result.arithmeticSum(generatedPredicted[i]);
      }

      const titles = itemList.map(item => item.displayMeasurementTitle());
      await result.setTitle(title, `sum from:\n${titles.join('\n')}`);
      await result.applyWorkingSettings();

      return result;
    } finally {
      await this.viewModel.removeMeasurements(intermediateSumUuids);

      if (deletePredicted && generatedPredicted.length > 1) {
        await this.viewModel.removeMeasurements(generatedPredicted);
      }
    }
  }
}

export default BusinessTools;
