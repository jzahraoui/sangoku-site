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
    // TODO: check why do not interrupt on errors
    try {
      if (!subResponses || subResponses.length === 0) {
        throw new Error('No subwoofer measurements found');
      }
      const resultsUuids = [];
      // use the fist measurement to creates the filter to ensure the same Frequency is used
      const measurement = subResponses[0];
      const saveCurrentsFilters = await measurement.getFilters();
      const LowPassFilterSet = [];
      // clear all filters
      for (let i = 1; i < 21; i++) {
        LowPassFilterSet.push({
          index: i,
          type: 'None',
          enabled: true,
          isAuto: false,
        });
      }
      // set the low pass
      LowPassFilterSet.push({
        index: 21,
        type: 'Low pass',
        enabled: true,
        isAuto: false,
        frequency: freq,
        shape: 'L-R',
        slopedBPerOctave: 24,
      });
      LowPassFilterSet.push({
        index: 22,
        type: 'None',
        enabled: true,
        isAuto: false,
      });

      // push the low pass filter on the first measurement
      await measurement.setFilters(LowPassFilterSet);

      const lowPassFilter = await measurement.generateFilterMeasurement();

      // restore measurement filter to left it as it was
      await measurement.setFilters(saveCurrentsFilters);

      for (const subResponse of subResponses) {
        if (!subResponse) {
          throw new Error(`Subwoofer measurement not found: ${subResponse.title()}`);
        }
        // remove inversion to keep original status
        const subResponseInverted = subResponse.inverted();
        await subResponse.setInverted(false);
        // reverse delay if previous iteration changed it because it will not be into cumulativeIRShift
        const subResponseDelay = subResponse.cumulativeIRShiftSeconds();
        await subResponse.setcumulativeIRShiftSeconds(0);
        // backup original filters
        const saveCurrentsFilters = await subResponse.getFilters();
        // create the new measurement with canceled LFE filter effect
        const division = await this.viewModel.doArithmeticOperation(
          subResponse.uuid,
          lowPassFilter.uuid,
          {
            function: 'A / B',
            upperLimit: '500',
          }
        );
        if (replaceOriginal) {
          // delete original
          await this.viewModel.removeMeasurement(subResponse);
        } else {
          // restore inversion
          await subResponse.setInverted(subResponseInverted);
          // restore delay
          await subResponse.setcumulativeIRShiftSeconds(subResponseDelay);
        }
        // update the title
        const subResponseTitle = replaceOriginal
          ? subResponse.title()
          : subResponse.title() + this.LPF_REVERTED_SUFFIX;
        await division.setTitle(subResponseTitle);

        // apply inversion
        await division.setInverted(subResponseInverted);
        // apply delay
        await division.setcumulativeIRShiftSeconds(subResponseDelay);
        // apply filters
        await division.setFilters(saveCurrentsFilters);

        resultsUuids.push(division.uuid);
      }
      // Delete filter
      console.debug(`Deleting LP filter ${lowPassFilter.title()}`);
      await this.viewModel.removeMeasurement(lowPassFilter);
      return resultsUuids;
    } catch (error) {
      throw new Error(`${error.message}`, { cause: error });
    }
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
  async produceAligned(PredictedLfe, cuttOffFrequency = 120, speakerItem, subResponses) {
    if (!speakerItem) {
      throw new Error(`Please select a speaker item`);
    }
    if (!PredictedLfe) {
      throw new Error(`Cannot find predicted LFE`);
    }
    if (cuttOffFrequency === 0) {
      throw new Error('no cuttoff frequency');
    }
    if (!PredictedLfe.haveImpulseResponse) {
      throw new Error('Invalid PredictedLfe object or missing cumulativeIRShiftSeconds');
    }

    const cxText = cuttOffFrequency ? `X@${cuttOffFrequency}Hz` : 'FB';
    const maxForwardSearchMs = 2;
    let totalOffset = 0;
    let mustBeInverted = false;
    const mustBeDeleted = [];
    try {
      // Front Left predicted equalized measurement
      const predictedFrontLeft = await speakerItem.producePredictedMeasurement();
      // TODO: manage the case of only one sub

      const { PredictedLfeFiltered, predictedSpeakerFiltered } =
        await this.applyCuttOffFilter(PredictedLfe, predictedFrontLeft, cuttOffFrequency);

      // Store filtered measurements for cleanup in finally block
      mustBeDeleted.push(PredictedLfeFiltered);
      mustBeDeleted.push(predictedSpeakerFiltered);
      mustBeDeleted.push(predictedFrontLeft);

      // get the sub impulse closer to the front left, better method than cros corr align
      const distanceToSpeakerPeak =
        PredictedLfeFiltered.timeOfIRPeakSeconds -
        predictedSpeakerFiltered.timeOfIRPeakSeconds;

      const distanceToSpeakerPeakMeters =
        PredictedLfe._computeInMeters(distanceToSpeakerPeak);

      const neededDistanceMeter =
        PredictedLfe.distanceInMeters() + distanceToSpeakerPeakMeters;

      // Calculate and apply adjustment to stay within maximum distance
      const overheadOffsetMs =
        PredictedLfe._computeInSeconds(
          this.viewModel.maxDistanceInMetersError() - neededDistanceMeter
        ) * 1000;

      // correction to prevent exceeding max distance
      let finalDistance = distanceToSpeakerPeak;
      if (overheadOffsetMs < 0) {
        finalDistance += overheadOffsetMs / 1000;
      }

      // Apply initial offset to align impulse peaks
      await PredictedLfeFiltered.addIROffsetSeconds(finalDistance);
      // Update total offset with initial alignment
      totalOffset += finalDistance;

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
      mustBeInverted = isBInverted;

      const checkResult = false;
      if (checkResult) {
        await PredictedLfeFiltered.addIROffsetSeconds(-shiftDelay);

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

      totalOffset -= shiftDelay;
      const debugMessage = `Subwoofer aligment: ${(totalOffset * 1000).toFixed(
        2
      )}ms (from previous position ${(distanceToSpeakerPeak * 1000).toFixed(
        2
      )}ms - alignment tool result ${(shiftDelay * 1000).toFixed(2)}ms)`;

      console.debug(debugMessage);

      const newDistance = PredictedLfe._computeDistanceInMeters(
        PredictedLfe.cumulativeIRShiftSeconds() + totalOffset
      ).toFixed(2);

      const shiftDistance = PredictedLfe._computeInMeters(totalOffset).toFixed(2);

      const resultMessage = `Subwoofer deplaced by: ${shiftDistance}m, new distance: ${newDistance}m (alignment:${(shiftDelay * 1000).toFixed(2)}ms)`;

      return resultMessage;
    } catch (error) {
      // cancel the offset applied to the sub
      totalOffset = 0;
      throw new Error(`${error.message}`, { cause: error });
    } finally {
      // cleanup of predicted measurements
      for (const measurement of mustBeDeleted) {
        await this.viewModel.removeMeasurement(measurement);
      }
      await PredictedLfe.addIROffsetSeconds(totalOffset);
      await this.applyTimeOffsetToSubs(totalOffset, subResponses, mustBeInverted);
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
      await predictedSubChannel.defaultSmoothing();
      return true;
    }
    if (item.isUnknownChannel) {
      return true;
    }

    await item.resetSmoothing();
    await item.resetIrWindows();

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

      await relatedLfeMeasurement.resetSmoothing();
      await relatedLfeMeasurement.resetIrWindows();

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

      await relatedLfeMeasurement.defaultSmoothing();
    }
    // set title
    const cxText = item.crossover() ? `X@${item.crossover()}Hz` : 'FB';
    const finalTitle = `${this.RESULT_PREFIX}${item.title()} ${cxText}_P${item.position()}`;
    await finalPredcition.setTitle(finalTitle);

    await finalPredcition.defaultSmoothing();
    await item.defaultSmoothing();

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
    if (!Array.isArray(itemList)) {
      throw new Error('Parameter must be an array');
    }
    if (itemList.length < 2) {
      throw new Error('Parameter must contains at least 2 elements');
    }

    let generatedPredictedUuids = [];
    let intermediateSumUuids = [];

    try {
      if (!Array.isArray(itemList)) {
        throw new Error('Parameter must be an array');
      }
      if (itemList.length < 2) {
        throw new Error('Parameter must contains at least 2 elements');
      }

      for (const measurementItem of itemList) {
        await measurementItem.resetSmoothing();
        await measurementItem.resetIrWindows();
        await measurementItem.resetTargetSettings();
        const rollResponse = await measurementItem.producePredictedMeasurement();
        if (!rollResponse) {
          throw new Error(`Cannot generate predicted measurement`);
        }
        generatedPredictedUuids.push(rollResponse.uuid);
      }

      let lastAlignedSum = await this.viewModel.doArithmeticOperation(
        generatedPredictedUuids[0],
        generatedPredictedUuids[1],
        { function: 'A + B' }
      );

      // Loop through each UUID and process
      for (let i = 2; i < generatedPredictedUuids.length; i++) {
        const newAlignedSum = await this.viewModel.doArithmeticOperation(
          generatedPredictedUuids[i],
          lastAlignedSum.uuid,
          { function: 'A + B' }
        );
        intermediateSumUuids.push(lastAlignedSum.uuid);
        lastAlignedSum = newAlignedSum;
      }
      const titles = itemList.map(item => item.displayMeasurementTitle());
      await lastAlignedSum.setTitle(title, `sum from:\n${titles.join('\n')}`);
      await lastAlignedSum.resetIrWindows();

      return lastAlignedSum;
    } catch (error) {
      throw new Error(`Error creating sum:${error.message}`, { cause: error });
    } finally {
      for (const uuid of intermediateSumUuids) {
        await this.viewModel.removeMeasurementUuid(uuid);
      }

      if (deletePredicted && generatedPredictedUuids.length) {
        // cleanup of equalised sub measurements usded to create the sum
        for (const uuid of generatedPredictedUuids) {
          await this.viewModel.removeMeasurementUuid(uuid);
        }
      }
    }
  }
}

export default BusinessTools;
