import MultiSubOptimizer from '../multi-sub-optimizer.js';
import {
  cleanFloat32Value,
  metersToSeconds,
} from '../measurement/measurement-calculations.js';
import { DEFAULT_LFE_PREDICTED } from '../measurement/measurement-info.js';
import { setSameDelayToAll } from './alignment.js';

/**
 * Subwoofer optimization service extracted from MeasurementViewModel
 *.
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

/**
 * Measurement write API used by the optimizer sequences. Without `operations`
 * every call delegates to the measurement's own method (Knockout MeasurementItem
 * adapter) — bit-for-bit the historical behaviour, so the existing unit tests and
 * the multi-sub-optimizer golden masters (which pass no `operations`) are
 * unaffected. With `operations` (ADR 002) the calls route to the
 * createMeasurementOperations functions, and the per-item context the KO methods
 * derived from the viewmodel comes from the injected providers.
 */
function buildMeasurementApi({
  operations,
  session,
  getOtherPositionMeasurements = () => [],
  workingSettingsConfig = () => undefined,
  irWindowWidthsFor = () => undefined,
  speedOfSound = () => 343,
}) {
  if (!operations) {
    return {
      setInverted: (m, inverted) => m.setInverted(inverted),
      setSingleFilter: (m, filter) => m.setSingleFilter(filter),
      applyWorkingSettings: m => m.applyWorkingSettings(),
      setTargetLevel: (m, level) => m.setTargetLevel(level),
      resetTargetSettings: m => m.resetTargetSettings(),
      removeWorkingSettings: m => m.removeWorkingSettings(),
      getFrequencyResponse: m => m.getFrequencyResponse(),
      setcumulativeIRShiftSeconds: (m, value) => m.setcumulativeIRShiftSeconds(value),
      detectFallOff: (m, threshold) => m.detectFallOff(threshold),
      runPhaseMatchFilter: (m, start, end, options) =>
        m._runPhaseMatchFilter(start, end, options),
      checkFilterGain: m => m.checkFilterGain(),
      setFilters: (m, filters, overwrite) => m.setFilters(filters, overwrite),
      copyFiltersToOther: m => m.copyFiltersToOther(),
      addIROffsetSeconds: (m, value) => m.addIROffsetSeconds(value),
      addSPLOffsetDB: (m, value) => m.addSPLOffsetDB(value),
      copySplOffsetDeltadBToOther: m => m.copySplOffsetDeltadBToOther(),
      getFilters: m => m.getFilters(),
      computeInSeconds: (m, meters) => m._computeInSeconds(meters),
    };
  }

  const rew = () => session.rewMeasurements;
  const sessionContext = {
    analyseApiResponse: result => session.analyseApiResponse(result),
    removeMeasurements: items => session.removeMeasurements(items),
    removeMeasurementUuid: uuid => session.removeMeasurementUuid(uuid),
    findMeasurementByUuid: uuid => session.findMeasurementByUuid(uuid),
  };
  const invalidate = m => async () => {
    if (m.associatedFilter == null) return;
    if (session.findMeasurementByUuid(m.associatedFilter)) {
      await session.removeMeasurementUuid(m.associatedFilter);
      m.associatedFilter = null;
    }
  };

  return {
    setInverted: (m, inverted) => operations.setInverted(rew(), m, inverted),
    setSingleFilter: (m, filter) =>
      operations.setSingleFilter(rew(), m, filter, { invalidateAssociatedFilter: invalidate(m) }),
    applyWorkingSettings: m => operations.applyWorkingSettings(rew(), m, workingSettingsConfig()),
    setTargetLevel: (m, level) =>
      operations.setTargetLevel(rew(), m, level, { invalidateAssociatedFilter: invalidate(m) }),
    resetTargetSettings: m => operations.resetTargetSettings(rew(), m),
    removeWorkingSettings: m => operations.removeWorkingSettings(rew(), m, irWindowWidthsFor(m)),
    getFrequencyResponse: m => operations.getFrequencyResponse(rew(), m, {}),
    setcumulativeIRShiftSeconds: (m, value) =>
      operations.setcumulativeIRShiftSeconds(rew(), m, value),
    detectFallOff: (m, threshold) => operations.detectFallOff(rew(), m, { threshold }),
    // 'rch' phase-match mode is not on the operations path (selectedEqualizationMode='rew').
    runPhaseMatchFilter: () => {
      throw new Error('rch phase-match is not wired on the operations path yet');
    },
    checkFilterGain: m => operations.checkFilterGain(rew(), m),
    setFilters: (m, filters, overwrite) =>
      operations.setFilters(rew(), m, filters, {
        overwrite,
        invalidateAssociatedFilter: invalidate(m),
      }),
    copyFiltersToOther: m =>
      operations.copyFiltersToOther(rew(), m, getOtherPositionMeasurements(m), sessionContext),
    addIROffsetSeconds: (m, value) => operations.addIROffsetSeconds(rew(), m, value),
    addSPLOffsetDB: (m, value) => operations.addSPLOffsetDB(rew(), m, value),
    copySplOffsetDeltadBToOther: m =>
      operations.copySplOffsetDeltadBToOther(rew(), m, getOtherPositionMeasurements(m)),
    getFilters: m => operations.getFilters(rew(), m),
    computeInSeconds: (_m, meters) => metersToSeconds(meters, speedOfSound()),
  };
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
  operations = null,
  getOtherPositionMeasurements,
  workingSettingsConfig,
  irWindowWidthsFor,
  speedOfSound,
  log = noopLog,
}) {
  const mops = buildMeasurementApi({
    operations,
    session,
    getOtherPositionMeasurements,
    workingSettingsConfig,
    irWindowWidthsFor,
    speedOfSound,
  });

  async function applySubPolarity(subMeasurement, polarity) {
    if (polarity === -1) {
      await mops.setInverted(subMeasurement, true);
    } else if (polarity === 1) {
      await mops.setInverted(subMeasurement, false);
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
    await mops.setSingleFilter(subMeasurement, allPassFilter);
  }
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

    await mops.applyWorkingSettings(maximisedSum);
    await mops.setTargetLevel(maximisedSum, config.mainTargetLevel);
    await mops.resetTargetSettings(maximisedSum);

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
        await mops.removeWorkingSettings(measurement);
        const frequencyResponse = await mops.getFrequencyResponse(measurement);
        frequencyResponse.uuid = measurement.uuid;
        frequencyResponses.push(frequencyResponse);
        await mops.applyWorkingSettings(measurement);
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
  async function produceSumProcess(subsList, position = unwrap(subsList?.[0]?.position)) {
    if (!subsList?.length) {
      throw new Error(`No subs found`);
    }
    if (subsList.length < 1) {
      throw new Error(`Not enough subs found to compute sum`);
    }
    const subResponsesTitles = subsList.map(response => unwrap(response.title));
    log.info(`Using: ${subResponsesTitles.join(', ')} to create subwoofer sum`);
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

      // Multiple subwoofers case - produce sum (position from the group key so
      // flat records need not carry a derived position field)
      await produceSumProcess(subResponses, position);
    }
  }

  /** Align the sub sum against a speaker then sync every predicted LFE. */
  async function produceAligned(speakerItem) {
    await businessTools.produceAligned(speakerItem, lists.uniqueSubsMeasurements());

    await syncAllPredictedLfeMeasurement();
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
      await mops.setcumulativeIRShiftSeconds(predictedLfe, selectedLfeIRShift);
      await mops.setInverted(predictedLfe, selectedLfeInverted);
      log.debug(`Syncing LFE ${labelOf(predictedLfe)} to selected LFE settings`);
    }

    // TODO each related subwoofer measurement should follow the same settings as predicted LFE (applyTimeOffsetToSubs)
  }

  // --- Sub equalization ----------------------------------------------------

  async function equalizeSub(subMeasurement) {
    await mops.setTargetLevel(subMeasurement, config.mainTargetLevel);
    await mops.applyWorkingSettings(subMeasurement);
    await mops.resetTargetSettings(subMeasurement);
    const fallOff = await mops.detectFallOff(subMeasurement, -3);

    const customStartFrequency = Math.max(config.lowerFrequencyBoundSub, fallOff.lowHz);
    const customEndFrequency = Math.min(config.upperFrequencyBoundSub, fallOff.highHz);
    if (customStartFrequency >= customEndFrequency) {
      throw new Error(
        `Cannot equalize ${labelOf(subMeasurement)}: detected band ` +
          `${fallOff.lowHz}Hz-${fallOff.highHz}Hz does not overlap the configured ` +
          `bounds ${config.lowerFrequencyBoundSub}Hz-${config.upperFrequencyBoundSub}Hz`,
      );
    }

    log.info(
      `Creating ${config.selectedEqualizationMode.toUpperCase()} EQ filters for sub sumation ${customStartFrequency}Hz - ${customEndFrequency}Hz`,
    );

    if (config.selectedEqualizationMode === 'rch') {
      await mops.runPhaseMatchFilter(subMeasurement, customStartFrequency, customEndFrequency, {
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

    await mops.checkFilterGain(subMeasurement);

    return true;
  }

  async function equalizeSubProcess(subMeasurement) {
    log.info(`Equalizing ${await labelOf(subMeasurement)}`);
    await equalizeSub(subMeasurement);
  }

  async function applyFiltersToSubs(sourceSub) {
    log.info(`Apply calculated filters to each sub`);
    const filters = await mops.getFilters(sourceSub);
    const subsMeasurements = lists.uniqueSubsMeasurements();
    for (const sub of subsMeasurements) {
      // do not overwrite the all pass filter if set
      await mops.setFilters(sub, filters, false);
    }
  }

  async function copySubFiltersToOtherPositions() {
    const subsMeasurements = lists.uniqueSubsMeasurements();
    for (const sub of subsMeasurements) {
      await mops.copyFiltersToOther(sub);
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
      mops.computeInSeconds(subMeasurement, config.distanceLeftBeforeError),
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
    await mops.addIROffsetSeconds(subMeasurement, sub.param.delay);
    await mops.addSPLOffsetDB(subMeasurement, sub.param.gain);
    await mops.copySplOffsetDeltadBToOther(subMeasurement);
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

    // set the same delay for all subwoofers (parity with setSameDelayToAll:
    // early-return on a single sub, align the others to the first sub's delay —
    // [0] already carries mainDelay, so skip it rather than issue a no-op write).
    if (operations) {
      if (subsMeasurements.length > 1) {
        const mainDelay = unwrap(subsMeasurements[0].cumulativeIRShiftSeconds);
        for (const measurement of subsMeasurements.slice(1)) {
          await mops.setcumulativeIRShiftSeconds(measurement, mainDelay);
        }
      }
    } else {
      await setSameDelayToAll(subsMeasurements);
    }

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
      await mops.setInverted(measurement, false);
      await mops.applyWorkingSettings(measurement);
      const frequencyResponse = await mops.getFrequencyResponse(measurement);
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
      await mops.setSingleFilter(maximisedSum, maximisedSumFilter);
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
