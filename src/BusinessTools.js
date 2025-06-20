class BusinessTools {
  constructor(parentViewModel) {
    this.viewModel = parentViewModel;
    this.LPF_REVERTED_SUFFIX = ' w/o LPF';
    this.RESULT_PREFIX = 'final ';
    this.AVERAGE_SUFFIX = 'avg';
  }

  async revertLfeFilterProccess(deletePrevious = true, freq, replaceOriginal = false) {
    try {
      const previousSubResponses = this.viewModel
        .subsMeasurements()
        .filter(response => response.title().includes(this.LPF_REVERTED_SUFFIX));
      if (deletePrevious) {
        for (const subResponse of previousSubResponses) {
          await this.viewModel.removeMeasurement(subResponse);
        }
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
    try {
      if (!subResponses?.length) {
        throw new Error('No subwoofer measurements found');
      }

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

        // Create new measurement with canceled LFE filter effect
        const division = await this.viewModel.doArithmeticOperation(
          subResponse.uuid,
          lowPassFilter.uuid,
          { function: 'A / B', upperLimit: '500' }
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
          : subResponse.title() + this.LPF_REVERTED_SUFFIX;

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
        for (const subResponse of subResponses) {
          await this.viewModel.removeMeasurement(subResponse);
        }
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
    lowPassFilterSet.push({
      index: 21,
      type: 'Low pass',
      enabled: true,
      isAuto: false,
      frequency: freq,
      shape: 'L-R',
      slopedBPerOctave: 24,
    });

    // Add empty filter at index 22
    lowPassFilterSet.push({
      index: 22,
      type: 'None',
      enabled: true,
      isAuto: false,
    });

    // Apply filters and generate filter measurement
    await measurement.setFilters(lowPassFilterSet);
    const filter = await measurement.generateFilterMeasurement();

    // Restore original filters
    await measurement.setFilters(originalFilters);

    return filter;
  }

  // Process grouped responses and create UUID arrays
  async processGroupedResponses(groupedResponse, avgMethod, deleteOriginal) {
    try {
      // Input validation
      if (!groupedResponse || typeof groupedResponse !== 'object') {
        throw new Error('Invalid groupedResponse input');
      }
      if (groupedResponse.length < 2) {
        throw new Error('Parameter must contains at least 2 elements');
      }

      // Process each code group sequentially
      for (const code of Object.keys(groupedResponse)) {
        // Validate group exists and has items
        if (!groupedResponse[code]?.items) {
          console.warn(`Skipping empty group: ${code}`);
          continue;
        }

        if (code === this.viewModel.UNKNOWN_GROUP_NAME) {
          continue;
        }

        // exclude previous results and create array of UUIDs for the current code group
        const usableItems = groupedResponse[code].items.filter(
          item => !item.isAverage && !item.isPredicted
        );

        // Process the collected indices
        if (!usableItems || usableItems.length < 2) {
          throw new Error(`Need at least 2 measurements to make an average: ${code}`);
        }

        // remove inversion and gain for each item
        for (const measurement of usableItems) {
          await measurement.setInverted(false);
        }

        // Get UUIDs of usable items
        const uuids = usableItems.map(item => item.uuid);

        // Cross correlation alignment
        console.debug(`${code}: ${uuids.length} measures cross corr align...`);
        await this.viewModel.processCommands('Cross corr align', uuids);

        // average processing
        console.debug(`${code}: ${uuids.length} measures ${avgMethod}...`);
        const vectorAverage = await this.viewModel.processCommands(avgMethod, uuids);

        // Update title
        if (vectorAverage) {
          console.debug(`${code}: measurements average title renaming...`);
          await vectorAverage.setTitle(code + this.AVERAGE_SUFFIX);
        } else {
          throw new Error(`${code}: can not rename the average...`);
        }

        if (deleteOriginal === 'all') {
          // Delete measurements - sequential processing
          for (const uuid of uuids) {
            await this.viewModel.removeMeasurementUuid(uuid);
          }
        }

        if (deleteOriginal === 'all_but_1') {
          // Delete all but the first measurement
          for (let i = 1; i < uuids.length; i++) {
            await this.viewModel.removeMeasurementUuid(uuids[i]);
          }
        }
      }

      return true;
    } catch (error) {
      throw new Error(`${error.message}`, { cause: error });
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
      return matchAll ? matches.every(match => match) : matches.some(match => match);
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

  /**
   * Aligns a subwoofer (LFE) with a speaker by calculating and applying the optimal time offset
   * @param {Object} PredictedLfe - The predicted LFE measurement object
   * @param {number} cuttOffFrequency - Crossover frequency in Hz (default: 120Hz)
   * @param {Object} speakerItem - The speaker measurement object to align with
   * @param {Array} subResponses - Array of subwoofer response objects
   * @returns {string} A message describing the alignment results
   */
  async produceAligned(
    PredictedLfe,
    cuttOffFrequency = 120,
    speakerItem,
    subResponses,
    checkResult = false
  ) {
    if (!speakerItem) {
      throw new Error(`Please select a speaker item`);
    }
    if (!PredictedLfe) {
      throw new Error(`Cannot find predicted LFE`);
    }
    if (cuttOffFrequency === 0) {
      // if all speakers are full range, no cuttoff frequency
      cuttOffFrequency = 120; // default value
      console.debug('no cuttoff frequency');
    }
    if (!PredictedLfe.haveImpulseResponse) {
      throw new Error('Invalid PredictedLfe object or missing cumulativeIRShiftSeconds');
    }

    const mustBeDeleted = [];
    try {
      const cxText = `X@${cuttOffFrequency}Hz`;
      const cutoffPeriod = 1 / cuttOffFrequency; // period in seconds
      const maxForwardSearch = cutoffPeriod / 2;
      const maxForwardSearchMs = maxForwardSearch * 1000; // max forward search in milliseconds, half period of the cuttOffFrequency
      // delay is 1/4 of the cutoff period
      const delay = cutoffPeriod / 4;
      // Front Left predicted equalized measurement
      const predictedFrontLeft = await speakerItem.producePredictedMeasurement();

      const { PredictedLfeFiltered, predictedSpeakerFiltered } =
        await this.applyCuttOffFilter(PredictedLfe, predictedFrontLeft, cuttOffFrequency);

      // Store filtered measurements for cleanup in finally block
      mustBeDeleted.push(
        PredictedLfeFiltered,
        predictedSpeakerFiltered,
        predictedFrontLeft
      );

      // get the sub impulse closer to the front left, better method than cros corr align
      const distanceToSpeakerPeak =
        PredictedLfeFiltered.timeOfIRPeakSeconds -
        predictedSpeakerFiltered.timeOfIRPeakSeconds;

      let finalDistance = distanceToSpeakerPeak - delay;

      const distanceToSpeakerPeakMeters = PredictedLfe._computeInMeters(finalDistance);

      const neededDistanceMeter =
        PredictedLfe.distanceInMeters() + distanceToSpeakerPeakMeters;

      // Calculate and apply adjustment to stay within maximum distance
      const overheadOffset =
        this.viewModel.maxDistanceInMetersError() - neededDistanceMeter;

      // correction to prevent exceeding max distance
      if (overheadOffset < 0) {
        finalDistance += PredictedLfe._computeInSeconds(overheadOffset);
      }

      // Apply initial offset to align impulse peaks
      await PredictedLfeFiltered.addIROffsetSeconds(finalDistance);

      // compute subwoofer aligment
      const { shiftDelay, isBInverted } = await this.viewModel.findAligment(
        predictedSpeakerFiltered,
        PredictedLfeFiltered,
        cuttOffFrequency,
        maxForwardSearchMs,
        false,
        `${this.RESULT_PREFIX}${speakerItem.title()} ${cxText}_P${speakerItem.position()}`,
        0
      );

      if (isBInverted) {
        await PredictedLfe.toggleInversion();
        await PredictedLfeFiltered.toggleInversion();
      }
      await PredictedLfeFiltered.addIROffsetSeconds(-shiftDelay);

      if (checkResult) {
        const finalPredcitionCompare = await this.viewModel.doArithmeticOperation(
          PredictedLfeFiltered.uuid,
          predictedSpeakerFiltered.uuid,
          { function: 'A + B' }
        );

        // set title
        await finalPredcitionCompare.setTitle(
          `${this.RESULT_PREFIX}${speakerItem.title()} ${cxText}_P${speakerItem.position()} cmp`
        );
      }

      const totalOffset = PredictedLfeFiltered.cumulativeIRShiftSeconds();
      const delayMs = delay * 1000;
      const debugMessage = `Subwoofer aligment: ${(totalOffset * 1000).toFixed(
        2
      )}ms (from previous position ${((distanceToSpeakerPeak - delay) * 1000).toFixed(
        2
      )}ms - alignment tool result ${(shiftDelay * 1000).toFixed(
        2
      )}ms) - search from ${delayMs.toFixed(2)}ms to ${(delayMs + maxForwardSearchMs).toFixed(2)}ms`;

      console.debug(debugMessage);

      await PredictedLfe.addIROffsetSeconds(totalOffset);
      await this.applyTimeOffsetToSubs(totalOffset, subResponses, isBInverted);

      const shiftDistance = PredictedLfe._computeInMeters(totalOffset).toFixed(2);

      const resultMessage = `Subwoofer deplaced by: ${shiftDistance}m (alignment:${((delay + shiftDelay) * 1000).toFixed(2)}ms)`;

      return resultMessage;
    } catch (error) {
      throw new Error(`${error.message}`, { cause: error });
    } finally {
      // cleanup of predicted measurements
      for (const measurement of mustBeDeleted) {
        await this.viewModel.removeMeasurement(measurement);
      }
    }
  }

  /**
   * Applies crossover filters to subwoofer and speaker measurements
   * @param {Object} sub - The subwoofer measurement object
   * @param {Object} speaker - The speaker measurement object
   * @param {number} cuttOffFrequency - Crossover frequency in Hz
   * @returns {Object} Object containing filtered measurements for both sub and speaker
   */
  async applyCuttOffFilter(sub, speaker, cuttOffFrequency) {
    if (cuttOffFrequency === 0) {
      const PredictedLfeFiltered = sub;
      const predictedSpeakerFiltered = speaker;
      return { PredictedLfeFiltered, predictedSpeakerFiltered };
    }
    // prenvent errors if the equaliser is not the Generic
    sub.ResetEqualiser();
    speaker.ResetEqualiser();

    try {
      const emptyFilter = index => ({
        index,
        type: 'None',
        enabled: true,
        isAuto: false,
      });

      // apply low pass filter to LFE at cuttOffFrequency
      const subFilter = index => ({
        index,
        enabled: true,
        isAuto: false,
        frequency: cuttOffFrequency,
        shape: 'L-R',
        slopedBPerOctave: 24,
        type: 'Low pass',
      });

      // apply high pass filter at cuttOffFrequency
      const speakerFilter = index => ({
        index,
        enabled: true,
        isAuto: false,
        frequency: cuttOffFrequency,
        shape: 'BU',
        slopedBPerOctave: 12,
        type: 'High pass',
      });

      const subFreeFilterIndex = await sub.getFreeXFilterIndex();
      if (subFreeFilterIndex === -1) {
        throw new Error(
          `No free filter found for ${sub.title()}. please check X1, X2 filters`
        );
      }
      await sub.setSingleFilter(subFilter(subFreeFilterIndex));
      // generate predicted filtered measurement for sub
      const PredictedLfeFiltered = await sub.producePredictedMeasurement();
      await sub.setSingleFilter(emptyFilter(subFreeFilterIndex));

      const speakerFreeFilterIndex = await speaker.getFreeXFilterIndex();
      if (speakerFreeFilterIndex === -1) {
        throw new Error(
          `No free filter found for ${speaker.title()}. please check X1, X2 filters`
        );
      }
      await speaker.setSingleFilter(speakerFilter(speakerFreeFilterIndex));
      // generate predicted filtered measurement for speaker
      const predictedSpeakerFiltered = await speaker.producePredictedMeasurement();
      await speaker.setSingleFilter(emptyFilter(speakerFreeFilterIndex));

      return { PredictedLfeFiltered, predictedSpeakerFiltered };
    } catch (error) {
      throw new Error(`${error.message}`, { cause: error });
    }
  }

  async createMeasurementPreview(item) {
    // skip subs
    if (item.isSub()) {
      const predictedSubChannel = await item.producePredictedMeasurement();
      // set title
      const finalTitle = `${this.RESULT_PREFIX}${item.title()} FB_P${item.position()}`;
      await predictedSubChannel.setTitle(finalTitle);
      await predictedSubChannel.applyWorkingSettings();
      return true;
    }
    if (item.isUnknownChannel) {
      return true;
    }

    await item.removeWorkingSettings();

    const predictedChannel = await item.producePredictedMeasurement();

    let finalPredcition;
    if (item.crossover() === 0) {
      finalPredcition = predictedChannel;
    } else {
      const relatedLfeMeasurement = item.relatedLfeMeasurement();
      if (!relatedLfeMeasurement) {
        // TODO use createssum to get it
        throw new Error(`Cannot find predicted LFE for position ${item.position()}`);
      }

      await relatedLfeMeasurement.removeWorkingSettings();

      const { PredictedLfeFiltered, predictedSpeakerFiltered } =
        await this.applyCuttOffFilter(
          relatedLfeMeasurement,
          predictedChannel,
          item.crossover()
        );

      await this.viewModel.removeMeasurement(predictedChannel);

      finalPredcition = await this.viewModel.doArithmeticOperation(
        PredictedLfeFiltered.uuid,
        predictedSpeakerFiltered.uuid,
        { function: 'A + B' }
      );
      // cleanup of predicted measurements
      await this.viewModel.removeMeasurement(PredictedLfeFiltered);
      await this.viewModel.removeMeasurement(predictedSpeakerFiltered);

      await relatedLfeMeasurement.applyWorkingSettings();
    }
    // set title
    const cxText = item.crossover() ? `X@${item.crossover()}Hz` : 'FB';
    const finalTitle = `${this.RESULT_PREFIX}${item.title()} ${cxText}_P${item.position()}`;
    await finalPredcition.setTitle(finalTitle);

    await finalPredcition.applyWorkingSettings();
    await item.applyWorkingSettings();

    return true;
  }

  async applyTimeOffsetToSubs(offset, subResponses, mustBeInverted) {
    if (subResponses.length < 2) {
      return;
    }
    try {
      for (const subResponse of subResponses) {
        // shift by offset
        await subResponse.addIROffsetSeconds(offset);
        if (mustBeInverted) {
          await subResponse.toggleInversion();
        }
      }
    } catch (error) {
      throw new Error(`${error.message}`, { cause: error });
    }
  }

  async createsSum(itemList, deletePredicted = true, title) {
    if (!Array.isArray(itemList) || itemList.length < 1) {
      throw new Error('Parameter must be a non-empty array');
    }

    const generatedPredicted = [];
    const intermediateSumUuids = [];

    try {
      for (const measurementItem of itemList) {
        await measurementItem.removeWorkingSettings();
        await measurementItem.resetTargetSettings();
        const rollResponse = await measurementItem.producePredictedMeasurement();
        if (!rollResponse) {
          throw new Error('Cannot generate predicted measurement');
        }
        generatedPredicted.push(rollResponse);
        await measurementItem.applyWorkingSettings();
      }

      let lastAlignedSum = generatedPredicted[0];

      for (let i = 1; i < generatedPredicted.length; i++) {
        const newAlignedSum = await this.viewModel.doArithmeticOperation(
          lastAlignedSum.uuid,
          generatedPredicted[i].uuid,
          { function: 'A + B' }
        );
        intermediateSumUuids.push(lastAlignedSum.uuid);
        lastAlignedSum = newAlignedSum;
      }
      const titles = itemList.map(item => item.displayMeasurementTitle());
      await lastAlignedSum.setTitle(title, `sum from:\n${titles.join('\n')}`);
      await lastAlignedSum.applyWorkingSettings();

      return lastAlignedSum;
    } catch (error) {
      throw new Error(`Error creating sum: ${error.message}`, { cause: error });
    } finally {
      for (const uuid of intermediateSumUuids) {
        await this.viewModel.removeMeasurementUuid(uuid);
      }

      if (deletePredicted && generatedPredicted.length > 1) {
        for (const item of generatedPredicted) {
          await this.viewModel.removeMeasurement(item);
        }
      }
    }
  }
}

export default BusinessTools;
