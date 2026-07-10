/**
 * Decontaminated BusinessTools (ADR 002). The Knockout
 * BusinessTools drives the measurement objects through their methods; here the
 * same sequences run over the flat MeasurementRecords by routing writes to the
 * operations service. The internally-created measurements (predicted sums,
 * divisions) are records too, so ops keep working down the chain.
 *
 * [ORCHESTRATION] service — no Knockout, no DOM.
 *
 * Dependencies:
 * - `operations`: createMeasurementOperations instance.
 * - `session`: RewSession (rewMeasurements, analyseApiResponse, removeMeasurements,
 *   removeMeasurement, removeMeasurementUuid, findMeasurementByUuid).
 * - `workingSettingsConfig()`, `irWindowWidthsFor(m)`: per-item working-settings
 *   context (same values the KO item methods derived from the viewmodel).
 * - `displayTitleOf(m)`: label used in the sum's notes (defaults to the title).
 */

import {
  splForAvrOf,
  splOffsetDeltadB,
} from '../measurement/measurement-export.js';
import {
  metersToSeconds,
  secondsToMeters,
} from '../measurement/measurement-calculations.js';

const unwrap = value => (typeof value === 'function' ? value() : value);

const LPF_REVERTED_SUFFIX = ' w/o LPF'; // mirror BusinessTools.LPF_REVERTED_SUFFIX
const RESULT_PREFIX = 'final '; // mirror BusinessTools.RESULT_PREFIX

function createBusinessTools({
  operations,
  session,
  workingSettingsConfig = () => undefined,
  irWindowWidthsFor = () => undefined,
  displayTitleOf = m => unwrap(m.title),
  // produceAligned context (Find Sub Alignment / align-sub). Providers mirror the
  // per-item values the KO BusinessTools read from the item/viewmodel: the group
  // crossover, the position's predicted LFE, the remaining distance headroom, the
  // AVR speed of sound and the alignment-tool search (alignment service).
  crossoverForSpeaker = m => unwrap(m.crossover),
  relatedLfeFor = m => unwrap(m.relatedLfeMeasurement),
  subDistanceLeftBeforeError = () => Infinity,
  speedOfSound = () => 343,
  findAligment = () => {
    throw new Error('findAligment is not wired');
  },
  // createMeasurementPreview context (per-speaker preview). Providers mirror the
  // KO item getters used in the title / sub guards.
  positionFor = m => unwrap(m.position),
  isSubOf = m => unwrap(m.isSub),
  isUnknownOf = m => Boolean(m.isUnknownChannel),
  log = { info() {}, warn() {}, debug() {} },
}) {
  const rew = () => session.rewMeasurements;
  const sessionContext = {
    analyseApiResponse: result => session.analyseApiResponse(result),
    removeMeasurements: items => session.removeMeasurements(items),
    removeMeasurementUuid: uuid => session.removeMeasurementUuid(uuid),
    findMeasurementByUuid: uuid => session.findMeasurementByUuid(uuid),
  };
  const invalidateAssociatedFilter = m => async () => {
    if (m.associatedFilter == null) return;
    if (session.findMeasurementByUuid(m.associatedFilter)) {
      await session.removeMeasurementUuid(m.associatedFilter);
      m.associatedFilter = null;
    }
  };

  /**
   * Sum a list of measurements into a single predicted response (parity with
   * BusinessTools.createsSum). Generates one predicted measurement per input,
   * folds them with arithmetic sums, titles the result and cleans up.
   */
  async function createsSum(itemList, title, deletePredicted = true) {
    if (!Array.isArray(itemList) || !itemList.length) {
      throw new Error('Parameter must be a non-empty array');
    }

    const generatedPredicted = [];
    const intermediateSums = [];

    try {
      for (const item of itemList) {
        await operations.removeWorkingSettings(rew(), item, irWindowWidthsFor(item));
        await operations.resetTargetSettings(rew(), item);
        generatedPredicted.push(
          await operations.producePredictedMeasurement(rew(), item, sessionContext),
        );
        await operations.applyWorkingSettings(rew(), item, workingSettingsConfig());
      }

      let result = generatedPredicted[0];
      for (let index = 1; index < generatedPredicted.length; index++) {
        intermediateSums.push(result);
        result = await operations.arithmeticSum(
          rew(),
          result,
          generatedPredicted[index],
          sessionContext,
        );
      }

      const titles = itemList.map(item => displayTitleOf(item));
      await operations.setTitle(rew(), result, title, `sum from:\n${titles.join('\n')}`);
      await operations.applyWorkingSettings(rew(), result, workingSettingsConfig());

      return result;
    } finally {
      await session.removeMeasurements(intermediateSums);
      if (deletePredicted && generatedPredicted.length > 1) {
        await session.removeMeasurements(generatedPredicted);
      }
    }
  }

  /**
   * Create a temporary Low-pass filter measurement from a sub (parity with
   * BusinessTools.createLowPassFilter): set an LR24 low-pass at index 21,
   * generate the filter measurement, then restore the original filters.
   */
  async function createLowPassFilter(measurement, freq) {
    const originalFilters = await operations.getFilters(rew(), measurement);

    const lowPassFilterSet = Array.from({ length: 20 }, (_, index) => ({
      index: index + 1,
      type: 'None',
      enabled: true,
      isAuto: false,
    }));
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
      { index: 22, type: 'None', enabled: true, isAuto: false },
    );

    await operations.setFilters(rew(), measurement, lowPassFilterSet, {
      invalidateAssociatedFilter: invalidateAssociatedFilter(measurement),
    });

    // ops.generateFilterMeasurement reads MeasurementItem-derived fields
    // (splresidual/crossover/associatedFilterItem); supply them for the record.
    const filterSource = {
      uuid: measurement.uuid,
      title: measurement.title,
      splOffsetdB: measurement.splOffsetdB,
      associatedFilter: measurement.associatedFilter ?? null,
      associatedFilterItem: null,
      splresidual: splOffsetDeltadB(measurement) - splForAvrOf(measurement),
      crossover: 0, // subs have no crossover
    };
    const filter = await operations.generateFilterMeasurement(
      rew(),
      filterSource,
      sessionContext,
    );

    await operations.setFilters(rew(), measurement, originalFilters, {
      invalidateAssociatedFilter: invalidateAssociatedFilter(measurement),
    });

    return filter;
  }

  /**
   * Divide each sub by a shared low-pass filter to cancel the AVR LFE filter
   * (parity with BusinessTools.revertLfeFilterProccessList).
   */
  async function revertLfeFilterProccessList(subResponses, freq, replaceOriginal = false) {
    if (!subResponses?.length) {
      throw new Error('No subwoofer measurements found');
    }
    if (!freq || typeof freq !== 'number') {
      throw new TypeError('Frequency must be a number');
    }

    const lowPassFilter = await createLowPassFilter(subResponses[0], freq);
    const resultsUuids = [];

    for (const subResponse of subResponses) {
      const originalState = {
        inverted: unwrap(subResponse.inverted),
        delay: unwrap(subResponse.cumulativeIRShiftSeconds),
        filters: await operations.getFilters(rew(), subResponse),
      };

      await operations.setInverted(rew(), subResponse, false);
      await operations.setcumulativeIRShiftSeconds(rew(), subResponse, 0);

      const division = await operations.arithmeticADividedByB(
        rew(),
        subResponse,
        lowPassFilter,
        sessionContext,
        null,
        null,
        freq * 2,
      );

      if (!replaceOriginal) {
        await operations.setInverted(rew(), subResponse, originalState.inverted);
        await operations.setcumulativeIRShiftSeconds(rew(), subResponse, originalState.delay);
      }

      const newTitle = replaceOriginal
        ? unwrap(subResponse.title)
        : unwrap(subResponse.title) + LPF_REVERTED_SUFFIX;
      await operations.setTitle(rew(), division, newTitle);
      await operations.setInverted(rew(), division, originalState.inverted);
      await operations.setcumulativeIRShiftSeconds(rew(), division, originalState.delay);
      await operations.setFilters(rew(), division, originalState.filters, {
        invalidateAssociatedFilter: invalidateAssociatedFilter(division),
      });
      division.revertLfeFrequency = freq;

      resultsUuids.push(division.uuid);
    }

    await session.removeMeasurement(lowPassFilter);
    if (replaceOriginal) {
      await session.removeMeasurements(subResponses);
    }
    return resultsUuids;
  }

  /**
   * Revert the AVR low-pass filter on the subs (parity with
   * BusinessTools.revertLfeFilterProccess): drop previous reverted results, then
   * process the original subs.
   */
  async function revertLfeFilterProccess(
    subsMeasurements,
    freq,
    replaceOriginal = false,
    deletePrevious = true,
  ) {
    const previous = subsMeasurements.filter(response =>
      unwrap(response.title).includes(LPF_REVERTED_SUFFIX),
    );
    if (deletePrevious) {
      await session.removeMeasurements(previous);
    }
    const originals = subsMeasurements.filter(
      response => !unwrap(response.title).includes(LPF_REVERTED_SUFFIX),
    );
    await revertLfeFilterProccessList(originals, freq, replaceOriginal);
  }

  /**
   * Apply the crossover pair (LR24 low-pass on the sub, BU12 high-pass on the
   * speaker) and return the predicted filtered responses (parity with
   * BusinessTools.applyCutOffFilter). The filters are restored to None in the
   * finally block; a 0 crossover falls back to plain response copies.
   */
  async function applyCutOffFilter(sub, speaker, cutOffFrequency) {
    if (cutOffFrequency === 0) {
      return {
        PredictedLfeFiltered: await operations.responseCopy(rew(), sub),
        predictedSpeakerFiltered: await operations.responseCopy(rew(), speaker),
      };
    }

    // make sure the equaliser is Generic to allow Low pass and High pass filters
    // (defaults mirror the KO item's rewEq.defaultEqtSettings).
    const equaliserDefaults = session.rewEq?.defaultEqtSettings;
    await operations.resetEqualiser(rew(), sub, equaliserDefaults);
    await operations.resetEqualiser(rew(), speaker, equaliserDefaults);

    const subIndex = await operations.getFreeXFilterIndex(rew(), sub, equaliserDefaults);
    const speakerIndex = await operations.getFreeXFilterIndex(
      rew(),
      speaker,
      equaliserDefaults,
    );
    if (subIndex === -1 || speakerIndex === -1) {
      throw new Error('Cannot find free filter index');
    }

    try {
      await operations.setSingleFilter(
        rew(),
        sub,
        {
          index: subIndex,
          enabled: true,
          isAuto: false,
          type: 'Low pass',
          frequency: cutOffFrequency,
          shape: 'L-R',
          slopedBPerOctave: 24,
        },
        { invalidateAssociatedFilter: invalidateAssociatedFilter(sub) },
      );
      await operations.setSingleFilter(
        rew(),
        speaker,
        {
          index: speakerIndex,
          enabled: true,
          isAuto: false,
          type: 'High pass',
          frequency: cutOffFrequency,
          shape: 'BU',
          slopedBPerOctave: 12,
        },
        { invalidateAssociatedFilter: invalidateAssociatedFilter(speaker) },
      );

      const PredictedLfeFiltered = await operations.producePredictedMeasurement(
        rew(),
        sub,
        sessionContext,
      );
      const predictedSpeakerFiltered = await operations.producePredictedMeasurement(
        rew(),
        speaker,
        sessionContext,
      );

      return { PredictedLfeFiltered, predictedSpeakerFiltered };
    } finally {
      await operations.setSingleFilter(
        rew(),
        sub,
        { index: subIndex, type: 'None', enabled: true, isAuto: false },
        { invalidateAssociatedFilter: invalidateAssociatedFilter(sub) },
      );
      await operations.setSingleFilter(
        rew(),
        speaker,
        { index: speakerIndex, type: 'None', enabled: true, isAuto: false },
        { invalidateAssociatedFilter: invalidateAssociatedFilter(speaker) },
      );
    }
  }

  function validateInputs(PredictedLfe, speakerItem, cuttOffFrequency) {
    if (!speakerItem) throw new Error(`Please select a speaker item`);
    if (!PredictedLfe) throw new Error(`Cannot find predicted LFE`);
    if (cuttOffFrequency === 0) {
      log.debug('Speaker are full range, no cuttoff frequency');
    }
    if (cuttOffFrequency < 20 || cuttOffFrequency > 250) {
      throw new Error('CuttOffFrequency must be between 20Hz and 250Hz');
    }
    if (!PredictedLfe.haveImpulseResponse) {
      throw new Error('Invalid PredictedLfe object or missing cumulativeIRShiftSeconds');
    }
  }

  async function applyTimeOffsetToSubs(offset, subResponses, mustBeInverted) {
    if (!subResponses || subResponses.length < 1) {
      return;
    }
    for (const subResponse of subResponses) {
      await operations.addIROffsetSeconds(rew(), subResponse, offset);
      if (mustBeInverted) {
        await operations.toggleInversion(rew(), subResponse);
      }
    }
  }

  /**
   * Align a subwoofer (predicted LFE) with a speaker by computing and applying
   * the optimal time offset (parity with BusinessTools.produceAligned). The
   * temporary predicted/filtered measurements are cleaned up in the finally.
   */
  async function produceAligned(speakerItem, subResponses) {
    const cuttOffFrequency = crossoverForSpeaker(speakerItem);
    const PredictedLfe = relatedLfeFor(speakerItem);
    validateInputs(PredictedLfe, speakerItem, cuttOffFrequency);

    const speed = speedOfSound();
    const mustBeDeleted = [];
    try {
      const predictedFrontLeft = await operations.producePredictedMeasurement(
        rew(),
        speakerItem,
        sessionContext,
      );
      mustBeDeleted.push(predictedFrontLeft);

      const { PredictedLfeFiltered, predictedSpeakerFiltered } =
        await applyCutOffFilter(PredictedLfe, predictedFrontLeft, cuttOffFrequency);
      mustBeDeleted.push(PredictedLfeFiltered, predictedSpeakerFiltered);

      const cutoffPeriod = 1 / cuttOffFrequency; // for 100Hz, period is 10ms
      const delay = cutoffPeriod / 16; // for 100Hz, delay is 0.625ms
      const maxForwardSearchMs = Math.round((cutoffPeriod / 2) * 1000 * 100) / 100;

      // get the sub impulse closer to the front left, better method than cross corr align
      const distanceToSpeakerPeak =
        unwrap(PredictedLfeFiltered.timeOfIRPeakSeconds) -
        unwrap(predictedSpeakerFiltered.timeOfIRPeakSeconds);
      let finalDistance = distanceToSpeakerPeak - delay;

      const neededDistanceMeter = secondsToMeters(finalDistance, speed);
      // Calculate and apply adjustment to stay within maximum distance
      const overheadOffset = subDistanceLeftBeforeError() - neededDistanceMeter;

      if (overheadOffset < 0) {
        log.warn(
          `Adjusting alignment by ${-overheadOffset.toFixed(
            2,
          )}m to stay within max distance limit.`,
        );
        finalDistance += metersToSeconds(overheadOffset, speed);
      }

      await operations.addIROffsetSeconds(rew(), PredictedLfeFiltered, finalDistance);

      const { shiftDelay, isBInverted } = await findAligment(
        predictedSpeakerFiltered,
        PredictedLfeFiltered,
        cuttOffFrequency,
        maxForwardSearchMs,
        false,
        `${RESULT_PREFIX}${unwrap(predictedSpeakerFiltered.title)} X@${cuttOffFrequency}Hz_P${unwrap(predictedSpeakerFiltered.position)}`,
        0,
      );

      if (isBInverted) {
        await operations.toggleInversion(rew(), PredictedLfe);
      }

      finalDistance -= shiftDelay;

      await operations.addIROffsetSeconds(rew(), PredictedLfe, finalDistance);
      await applyTimeOffsetToSubs(finalDistance, subResponses, isBInverted);

      const shiftDistance = secondsToMeters(finalDistance, speed).toFixed(2);
      log.info(
        `Subwoofer deplaced by: ${shiftDistance}m (alignment:${(
          (delay + shiftDelay) *
          1000
        ).toFixed(2)}ms)`,
      );
    } finally {
      await session.removeMeasurements(mustBeDeleted);
    }
  }

  /**
   * Build the "final ..." predicted preview of one speaker (parity with
   * BusinessTools.createMeasurementPreview): predict the channel, fold in the
   * position's crossover-filtered predicted LFE when a crossover is set, title
   * and smooth the result. Skips subs / unknown channels.
   */
  async function createMeasurementPreview(item) {
    if (isSubOf(item)) return;
    if (isUnknownOf(item)) return;

    await operations.removeWorkingSettings(rew(), item, irWindowWidthsFor(item));

    const predictedChannel = await operations.producePredictedMeasurement(
      rew(),
      item,
      sessionContext,
    );

    const crossover = crossoverForSpeaker(item);
    let finalPredcition;
    if (crossover === 0) {
      finalPredcition = predictedChannel;
    } else {
      const relatedLfe = relatedLfeFor(item);
      if (!relatedLfe) {
        await session.removeMeasurement(predictedChannel);
        // LFE predicted must be done by the user to ensure filters are correct.
        throw new Error(`Cannot find predicted LFE for position ${positionFor(item)}`);
      }

      await operations.removeWorkingSettings(rew(), relatedLfe, irWindowWidthsFor(relatedLfe));

      const { PredictedLfeFiltered, predictedSpeakerFiltered } =
        await applyCutOffFilter(relatedLfe, predictedChannel, crossover);

      await session.removeMeasurement(predictedChannel);

      finalPredcition = await operations.arithmeticSum(
        rew(),
        PredictedLfeFiltered,
        predictedSpeakerFiltered,
        sessionContext,
      );
      await session.removeMeasurements([PredictedLfeFiltered, predictedSpeakerFiltered]);

      await operations.applyWorkingSettings(rew(), relatedLfe, workingSettingsConfig());
    }

    const cxText = crossover ? `X@${crossover}Hz` : 'FB';
    const finalTitle = `${RESULT_PREFIX}${unwrap(item.title)} ${cxText}_P${positionFor(item)}`;
    await operations.setTitle(rew(), finalPredcition, finalTitle);
    await operations.setSmoothing(rew(), finalPredcition, 'Psy');
    await operations.applyWorkingSettings(rew(), item, workingSettingsConfig());

    return finalPredcition;
  }

  return {
    createsSum,
    createLowPassFilter,
    revertLfeFilterProccess,
    applyCutOffFilter,
    produceAligned,
    createMeasurementPreview,
  };
}

export { createBusinessTools };
