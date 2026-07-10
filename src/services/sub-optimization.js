import MultiSubOptimizer from '../multi-sub-optimizer.js';
import { cleanFloat32Value } from '../measurement/measurement-calculations.js';
import { DEFAULT_LFE_PREDICTED } from '../measurement/measurement-info.js';
import { setSameDelayToAll } from './alignment.js';

/**
 * Subwoofer optimization service extracted from MeasurementViewModel
 * (décontamination lot V5 — docs/reverse/03-vm-decontamination.md).
 *
 * [ORCHESTRATION] service: subwoofer sums, single/multi sub equalization and
 * the MultiSubOptimizer sequence. No Knockout, no DOM.
 *
 * Construction dependencies:
 * - `session`: the RewSession instance.
 * - `businessTools`: bridges { produceAligned, createsSum }.
 * - `config`: accessor object over the app settings — mainTargetLevel,
 *   selectedEqualizationMode, lowerFrequencyBoundSub, upperFrequencyBoundSub,
 *   maxBoostIndividualValue, maxBoostOverallValue, useAllPassFiltersForSubs,
 *   distanceLeftBeforeError, avrData.
 * - `lists`: thunks — uniqueSubsMeasurements(), predictedLfeMeasurements(),
 *   selectedPredictedLfeMeasurement().
 */

const MAXIMISED_SUM_TITLE = 'LFE Max Sum';

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const unwrap = value => (typeof value === 'function' ? value() : value);

const labelOf = m => unwrap(m.displayMeasurementTitle) ?? unwrap(m.title);

async function applySubPolarity(subMeasurement, polarity) {
  if (polarity === -1) {
    await subMeasurement.setInverted(true);
  } else if (polarity === 1) {
    await subMeasurement.setInverted(false);
  } else {
    throw new Error(`Invalid invert value for ${await labelOf(subMeasurement)}`);
  }
}

async function applySubAllPassFilter(subMeasurement, allPassParam) {
  const allPassFilter = allPassParam.enabled
    ? {
        index: 20,
        enabled: true,
        isAuto: false,
        frequency: allPassParam.frequency,
        q: allPassParam.q,
        type: 'All pass',
      }
    : { index: 20, enabled: true, isAuto: true, type: 'None' };
  await subMeasurement.setSingleFilter(allPassFilter);
}

function getMaxFromArray(array) {
  if (!Array.isArray(array)) {
    throw new TypeError('Input is not an array');
  }

  let maxPeak = -Infinity;
  for (const value of array) {
    if (value > maxPeak) {
      maxPeak = value;
    }
  }
  return maxPeak;
}

function createSubOptimizationService({
  session,
  businessTools,
  config,
  lists,
  log = noopLog,
}) {
  /** Import an optimizer frequency response into REW and prepare it. */
  async function sendToREW(optimizedSubsSum, maximisedSumTitle) {
    const options = {
      identifier: maximisedSumTitle.slice(0, 24),
      isImpedance: false,
      startFreq: optimizedSubsSum.freqs[0],
      freqStep: optimizedSubsSum.freqStep,
      magnitude: optimizedSubsSum.magnitude,
      phase: optimizedSubsSum.phase,
      ppo: optimizedSubsSum.ppo,
    };
    const maximisedSum = await session.addMeasurementFromRewOperation(
      () => session.rewImport.importFrequencyResponseData(options),
      { expectedTitle: options.identifier, operationLabel: maximisedSumTitle },
    );

    if (!maximisedSum) {
      throw new Error('Error creating maximised sum');
    }

    await maximisedSum.applyWorkingSettings();
    await maximisedSum.setTargetLevel(config.mainTargetLevel);
    await maximisedSum.resetTargetSettings();

    return maximisedSum;
  }

  /** Dump the combined response of the given measurements as a text export. */
  async function createsSumFromFR(measurementList) {
    try {
      if (!Array.isArray(measurementList) || measurementList.length === 0) {
        throw new Error('Invalid measurement list');
      }
      const frequencyResponses = [];
      for (const measurement of measurementList) {
        await measurement.removeWorkingSettings();
        const frequencyResponse = await measurement.getFrequencyResponse();
        frequencyResponse.uuid = measurement.uuid;
        frequencyResponses.push(frequencyResponse);
        await measurement.applyWorkingSettings();
      }

      const optimizer = new MultiSubOptimizer(
        frequencyResponses,
        MultiSubOptimizer.DEFAULT_CONFIG,
        log,
      );
      const optimizedSubsSum = optimizer.calculateCombinedResponse(frequencyResponses);
      const data = optimizer.displayResponse(optimizedSubsSum);

      return {
        filename: 'sum.txt',
        blob: new Blob([data], { type: 'text/plain;charset=utf-8' }),
      };
    } catch (error) {
      throw new Error(`Failed to create sum: ${error.message}`, {
        cause: error,
      });
    }
  }

  /** Sum the given position's subs into the predicted LFE measurement. */
  async function produceSumProcess(subsList) {
    if (!subsList?.length) {
      throw new Error(`No subs found`);
    }
    if (subsList.length < 1) {
      throw new Error(`Not enough subs found to compute sum`);
    }
    const subResponsesTitles = subsList.map(response => unwrap(response.title));
    log.info(`Using: ${subResponsesTitles.join(', ')} to create subwoofer sum`);
    // get first subsList element position
    const position = unwrap(subsList[0].position);
    const resultTitle = `${DEFAULT_LFE_PREDICTED}${position}`;

    const previousSubSum = session.measurements
      .get()
      .find(item => unwrap(item.title) === resultTitle);
    // remove previous
    await session.removeMeasurement(previousSubSum);
    // create sum of all subwoofer measurements
    const newDefaultLfePredicted = await businessTools.createsSum(
      subsList,
      resultTitle,
      true,
    );
    newDefaultLfePredicted.isSubOperationResult = true;

    log.info(
      `Subwoofer sum created successfully: ${unwrap(newDefaultLfePredicted.title)}`,
    );
    return newDefaultLfePredicted;
  }

  /** Sum every position's subs (used by the "sum subs" button). */
  async function produceSubSums(positionGroups) {
    for (const [position, subResponses] of Object.entries(positionGroups)) {
      log.info(`Processing position ${position}`);

      // Handle based on number of subwoofers
      if (subResponses.length === 0) continue;

      // Multiple subwoofers case - produce sum
      await produceSumProcess(subResponses);
    }
  }

  /** Align the sub sum against a speaker then sync every predicted LFE. */
  async function produceAligned(speakerItem) {
    await businessTools.produceAligned(speakerItem, lists.uniqueSubsMeasurements());

    syncAllPredictedLfeMeasurement();
  }

  async function syncAllPredictedLfeMeasurement() {
    const selectedLfe = lists.selectedPredictedLfeMeasurement();

    if (!selectedLfe) {
      throw new Error(`No LFE found, please use sum subs button`);
    }

    const selectedLfeIRShift = unwrap(selectedLfe.cumulativeIRShiftSeconds);
    const selectedLfeInverted = unwrap(selectedLfe.inverted);

    for (const predictedLfe of lists.predictedLfeMeasurements()) {
      if (predictedLfe.uuid === selectedLfe.uuid) continue;
      await predictedLfe.setcumulativeIRShiftSeconds(selectedLfeIRShift);
      await predictedLfe.setInverted(selectedLfeInverted);
      log.debug(`Syncing LFE ${labelOf(predictedLfe)} to selected LFE settings`);
    }

    // TODO each related subwoofer measurement should follow the same settings as predicted LFE (applyTimeOffsetToSubs)
  }

  // --- Sub equalization ----------------------------------------------------

  async function equalizeSub(subMeasurement) {
    await subMeasurement.setTargetLevel(config.mainTargetLevel);
    await subMeasurement.applyWorkingSettings();
    await subMeasurement.resetTargetSettings();
    const fallOff = await subMeasurement.detectFallOff(-3);

    const customStartFrequency = Math.max(config.lowerFrequencyBoundSub, fallOff.lowHz);
    const customEndFrequency = Math.min(config.upperFrequencyBoundSub, fallOff.highHz);

    log.info(
      `Creating ${config.selectedEqualizationMode.toUpperCase()} EQ filters for sub sumation ${customStartFrequency}Hz - ${customEndFrequency}Hz`,
    );

    if (config.selectedEqualizationMode === 'rch') {
      await subMeasurement._runPhaseMatchFilter(customStartFrequency, customEndFrequency, {
        individualMaxBoostDb: config.maxBoostIndividualValue,
        overallMaxBoostDb: config.maxBoostOverallValue,
      });
    } else {
      await session.rewEq.setMatchTargetSettings({
        startFrequency: customStartFrequency,
        endFrequency: customEndFrequency,
        individualMaxBoostdB: config.maxBoostIndividualValue,
        overallMaxBoostdB: config.maxBoostOverallValue,
        flatnessTargetdB: 1,
        allowNarrowFiltersBelow200Hz: false,
        varyQAbove200Hz: false,
        allowLowShelf: false,
        allowHighShelf: false,
      });

      await session.rewMeasurements.matchTarget(subMeasurement.uuid);
    }

    await subMeasurement.checkFilterGain();

    return true;
  }

  async function equalizeSubProcess(subMeasurement) {
    log.info(`Equalizing ${await labelOf(subMeasurement)}`);
    await equalizeSub(subMeasurement);
  }

  async function applyFiltersToSubs(sourceSub) {
    log.info(`Apply calculated filters to each sub`);
    const filters = await sourceSub.getFilters();
    const subsMeasurements = lists.uniqueSubsMeasurements();
    for (const sub of subsMeasurements) {
      // do not overwrite the all pass filter if set
      await sub.setFilters(filters, false);
    }
  }

  async function copySubFiltersToOtherPositions() {
    const subsMeasurements = lists.uniqueSubsMeasurements();
    for (const sub of subsMeasurements) {
      await sub.copyFiltersToOther();
    }
  }

  async function singleSubOptimizer() {
    log.info('Equalize single sub...');
    const subMeasurement = lists.uniqueSubsMeasurements()[0];
    await equalizeSubProcess(subMeasurement);
    await copySubFiltersToOtherPositions();
  }

  async function multipleSubOptimizer() {
    log.info('Equalize multiple subs...');

    const maximisedSum = session.measurements
      .get()
      .find(item => unwrap(item.title) === MAXIMISED_SUM_TITLE);
    if (!maximisedSum) {
      throw new Error('No maximised sum found');
    }
    await equalizeSubProcess(maximisedSum);
    await applyFiltersToSubs(maximisedSum);
    await copySubFiltersToOtherPositions();
  }

  /** Route to the single or multiple sub equalizer. */
  async function equalizeSubs() {
    if (lists.uniqueSubsMeasurements().length === 1) {
      await singleSubOptimizer();
    } else if (lists.uniqueSubsMeasurements().length > 1) {
      await multipleSubOptimizer();
    }
  }

  // --- MultiSubOptimizer sequence -------------------------------------------

  function createOptimizerConfig(lowFrequency, highFrequency) {
    if (!config.jsonAvrData?.avr) {
      throw new Error('Please load AVR data first');
    }

    const subMeasurement = lists.uniqueSubsMeasurements()[0];
    const headroomSeconds = cleanFloat32Value(
      subMeasurement._computeInSeconds(config.distanceLeftBeforeError),
      4,
    );
    if (headroomSeconds <= 0.002) {
      log.warn(
        `Low distance left before error (${(headroomSeconds * 1000).toFixed(
          1,
        )} ms). Optimization may fail. Consider increasing the distance left before error in settings.`,
      );
    }
    if (headroomSeconds <= 0) {
      throw new Error(
        `Distance left before error (${(headroomSeconds * 1000).toFixed(
          1,
        )} ms) is too low. Please increase the distance left before error in settings.`,
      );
    }
    return {
      frequency: { min: lowFrequency, max: highFrequency },
      // Gains stay at 0: the efficiency ratio is computed as
      // actual/theoretical linear magnitude. Allowing positive gain would
      // artificially inflate the ratio above 100% without any real acoustic
      // improvement — the optimizer would "cheat" by boosting level instead
      // of improving alignment. MSO also optimizes with gains at 0 for the
      // same reason. The delay/polarity/all-pass dimensions are sufficient
      // to approach the theoretical maximum.
      gain: { min: 0, max: 0, step: 0.1 },
      delay: {
        min: -headroomSeconds,
        max: headroomSeconds,
        step: config.jsonAvrData.avr.minDistAccuracy || 0.00001,
      },
      allPass: {
        enabled: config.useAllPassFiltersForSubs,
        frequency: { min: 10, max: 500, step: 10 },
        q: { min: 0.1, max: 0.5, step: 0.1 },
      },
      optimization: {
        objective: 'balanced',
        globalRefinement: {
          enabled: true,
          passes: 4,
          maxIterations: 30,
        },
        multiStart: {
          enabled: false,
          runs: 1,
          coarseSeedCount: 8,
          minRunImprovement: 0.25,
        },
      },
    };
  }

  async function applyOptimizedSubSettings(sub) {
    const subMeasurement = session.findMeasurementByUuid(sub.measurement);
    if (!subMeasurement) {
      throw new Error(`Measurement not found for ${sub.measurement}`);
    }
    await applySubPolarity(subMeasurement, sub.param.polarity);
    await subMeasurement.addIROffsetSeconds(sub.param.delay);
    await subMeasurement.addSPLOffsetDB(sub.param.gain);
    await subMeasurement.copySplOffsetDeltadBToOther();
    await applySubAllPassFilter(subMeasurement, sub.param.allPass);
  }

  /** Full MultiSubOptimizer sequence over the given frequency bands. */
  async function multiSubOptimizer(subsFrequencyBands) {
    const subsMeasurements = lists.uniqueSubsMeasurements();

    if (subsMeasurements.length === 0) {
      throw new Error('No subwoofers found');
    }
    if (subsMeasurements.length === 1) {
      throw new Error('Only one subwoofer found, please use single sub optimizer button');
    }

    if (!subsFrequencyBands?.lowFrequency || !subsFrequencyBands?.highFrequency) {
      throw new Error(
        'Subwoofer frequency bands not defined, please use Align SPL button first',
      );
    }

    //delete previous LFE predicted measurements
    await session.removeMeasurements(lists.predictedLfeMeasurements());

    // set the same delay for all subwoofers
    await setSameDelayToAll(subsMeasurements);

    const optimizerConfig = createOptimizerConfig(
      subsFrequencyBands.lowFrequency,
      subsFrequencyBands.highFrequency,
    );
    log.info(
      `frequency range: ${optimizerConfig.frequency.min}Hz - ${optimizerConfig.frequency.max}Hz`,
    );
    log.info(
      `delay range: ${optimizerConfig.delay.min * 1000}ms - ${
        optimizerConfig.delay.max * 1000
      }ms`,
    );

    log.info(`Deleting previous settings...`);

    // remove previous maximised sum and maximised sum theoretical
    const previousMaxSum = session.measurements
      .get()
      .filter(item => unwrap(item.title).startsWith(MAXIMISED_SUM_TITLE));

    await session.removeMeasurements(previousMaxSum);

    const frequencyResponses = [];
    for (const measurement of subsMeasurements) {
      await measurement.setInverted(false);
      await measurement.applyWorkingSettings();
      const frequencyResponse = await measurement.getFrequencyResponse();
      frequencyResponse.measurement = measurement.uuid;
      frequencyResponse.name = labelOf(measurement);
      frequencyResponse.position = unwrap(measurement.position);
      frequencyResponses.push(frequencyResponse);
    }

    log.info(`Sarting lookup...`);
    const optimizer = new MultiSubOptimizer(frequencyResponses, optimizerConfig, log);
    const optimizerResults = optimizer.optimizeSubwoofers();

    for (const sub of optimizerResults.optimizedSubs) {
      await applyOptimizedSubSettings(sub);
    }

    log.info(`Creating sub sumation...`);
    // DEBUG use REW api way to generate the sum for compare
    // const maximisedSum = await produceSumProcess(subsMeasurements);

    const optimizedSubsSum = optimizer.getFinalSubSum();

    const maximisedSum = await sendToREW(optimizedSubsSum, MAXIMISED_SUM_TITLE);

    const maximisedSumTheo = await sendToREW(
      optimizer.theoreticalMaxResponse,
      MAXIMISED_SUM_TITLE + ' Theo',
    );

    maximisedSum.isSubOperationResult = true;
    maximisedSumTheo.isSubOperationResult = true;
    // DEBUG to check if this is the same
    // await sendToREW(optimizerResults.bestSum, 'test');

    // reserve filter emplacement 20 for all pass
    if (optimizerConfig.allPass.enabled) {
      const maximisedSumFilter = {
        index: 20,
        enabled: true,
        isAuto: false,
        type: 'None',
      };
      await maximisedSum.setSingleFilter(maximisedSumFilter);
    }
  }

  return {
    applyFiltersToSubs,
    applyOptimizedSubSettings,
    applySubAllPassFilter,
    applySubPolarity,
    copySubFiltersToOtherPositions,
    createOptimizerConfig,
    createsSumFromFR,
    equalizeSub,
    equalizeSubProcess,
    equalizeSubs,
    getMaxFromArray,
    multipleSubOptimizer,
    multiSubOptimizer,
    produceAligned,
    produceSubSums,
    produceSumProcess,
    sendToREW,
    singleSubOptimizer,
    syncAllPredictedLfeMeasurement,
  };
}

export { MAXIMISED_SUM_TITLE, createSubOptimizationService, getMaxFromArray };
