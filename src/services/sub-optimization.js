import MultiSubOptimizer from '../multi-sub-optimizer.js';
import { createPhaseMatchCalculator } from '../autoeq/phase-match-calculator.js';
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
  // RCH (phase-match) context for the operations path: accessor over the
  // AutoEQ settings (the RCH panel values) and the default boosts.
  autoEqConfig = () => null,
  defaultBoosts = () => ({}),
}) {
  if (!operations) {
    return {
      setInverted: (m, inverted) => m.setInverted(inverted),
      setSingleFilter: (m, filter) => m.setSingleFilter(filter),
      resetFilters: m => m.resetFilters(),
      applyWorkingSettings: m => m.applyWorkingSettings(),
      setTargetLevel: (m, level) => m.setTargetLevel(level),
      resetTargetSettings: m => m.resetTargetSettings(),
      removeWorkingSettings: m => m.removeWorkingSettings(),
      getFrequencyResponse: m => m.getFrequencyResponse(),
      getTargetResponse: (m, unit, ppo) => m.getTargetResponse(unit, ppo),
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
    resetFilters: m =>
      operations.resetFilters(rew(), m, { invalidateAssociatedFilter: invalidate(m) }),
    applyWorkingSettings: m => operations.applyWorkingSettings(rew(), m, workingSettingsConfig()),
    setTargetLevel: (m, level) =>
      operations.setTargetLevel(rew(), m, level, { invalidateAssociatedFilter: invalidate(m) }),
    resetTargetSettings: m => operations.resetTargetSettings(rew(), m),
    removeWorkingSettings: m => operations.removeWorkingSettings(rew(), m, irWindowWidthsFor(m)),
    getFrequencyResponse: m => operations.getFrequencyResponse(rew(), m, {}),
    getTargetResponse: (m, unit, ppo) =>
      operations.getTargetResponse(rew(), m, { unit, ppo }),
    setcumulativeIRShiftSeconds: (m, value) =>
      operations.setcumulativeIRShiftSeconds(rew(), m, value),
    detectFallOff: (m, threshold) => operations.detectFallOff(rew(), m, { threshold }),
    runPhaseMatchFilter: (m, start, end, options = {}) =>
      operations.runPhaseMatchFilter(
        rew(),
        m,
        {
          session: sessionContext,
          smoothingMethod: workingSettingsConfig()?.smoothingMethod,
          createCalculator: (sampleRate, freqStart, freqEnd, calcOptions = {}) =>
            createPhaseMatchCalculator({
              sampleRate,
              freqStart,
              freqEnd,
              autoEqConfig: autoEqConfig(),
              individualMaxBoostDb:
                calcOptions.individualMaxBoostDb ?? defaultBoosts()?.individual,
              overallMaxBoostDb:
                calcOptions.overallMaxBoostDb ?? defaultBoosts()?.overall,
            }),
        },
        start,
        end,
        options,
      ),
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
  // Virtual subwoofer bridge (ADR 003): { refresh(position, {force}) }. When
  // provided, align/equalize work on the per-position LFE predicted projection
  // instead of a tagged 'LFE Max Sum' measurement. When absent the historical
  // behaviour is preserved (test surface).
  virtualSubwoofers = null,
  getOtherPositionMeasurements,
  autoEqConfig = () => null,
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
    autoEqConfig,
    defaultBoosts: () => ({
      individual: config.maxBoostIndividualValue,
      overall: config.maxBoostOverallValue,
    }),
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
    const subsMeasurements = lists.uniqueSubsMeasurements();
    const position = unwrap(subsMeasurements[0]?.position);

    if (virtualSubwoofers) {
      // The alignment works on the predicted LFE: make sure the projection
      // of the current position exists and is up to date.
      await virtualSubwoofers.refresh(position, {});
    }

    const alignment = await businessTools.produceAligned(speakerItem, subsMeasurements);

    if (!virtualSubwoofers) {
      await syncAllPredictedLfeMeasurement();
      return;
    }

    // ADR 003 v2 — carry the found alignment (offset + inversion) to the
    // other positions' REAL subs through the group commands: the historical
    // sync only shifted their predicted measurements, which are now throwaway
    // projections. Every projection is then recomputed from its subs.
    if (alignment) {
      const currentKey = String(position);
      const groups = lists.byPositionsGroupedSubsMeasurements?.() ?? {};
      for (const [groupPosition, subs] of Object.entries(groups)) {
        if (groupPosition === currentKey || !subs.length) continue;
        await virtualSubwoofers.forEachSub(
          async (vmops, sub) => {
            await vmops.addIROffsetSeconds(sub, alignment.offsetSeconds);
            if (alignment.inverted) {
              await vmops.setInverted(sub, !unwrap(sub.inverted));
            }
          },
          { position: groupPosition },
        );
      }
    } else {
      log.warn('produceAligned returned no alignment result; skipping propagation');
    }

    await virtualSubwoofers.refreshProjected({ force: true });
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

    // Legacy-path limitation only: with the virtual-subwoofer bridge,
    // produceAligned carries the alignment to the other positions' real subs.
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
    const subsMeasurements = lists.uniqueSubsMeasurements();
    if (!subsMeasurements.length) return;

    if (!virtualSubwoofers) {
      if (subsMeasurements.length === 1) {
        await singleSubOptimizer();
      } else {
        await multipleSubOptimizer();
      }
      return;
    }

    // ADR 003 — N ≥ 1 unified: the EQ is computed on the virtual sub
    // projection, distributed to the real subs through the group command
    // (which recomputes the projections), then copied to the other positions.
    const position = unwrap(subsMeasurements[0].position);
    const projection = await virtualSubwoofers.refresh(position, {});
    if (!projection) {
      throw new Error('No subwoofer found');
    }
    if (config.useAllPassFiltersForSubs) {
      // The slot-20 reservation set by align-sub lives on a throwaway
      // projection: re-assert it so matchTarget cannot claim the slot the
      // subs keep for their all-pass filter.
      await mops.setSingleFilter(projection, {
        index: 20,
        enabled: true,
        isAuto: false,
        type: 'None',
      });
    }
    await equalizeSubProcess(projection);
    const filters = await mops.getFilters(projection);
    await virtualSubwoofers.setFilters(filters, { position });
    await copySubFiltersToOtherPositions();
  }

  // --- MultiSubOptimizer sequence -------------------------------------------

  function createOptimizerConfig(
    lowFrequency,
    highFrequency,
    { alignmentGapsSeconds = null } = {},
  ) {
    if (!config.jsonAvrData?.avr) {
      throw new Error('Please load AVR data first');
    }

    const subsMeasurements = lists.uniqueSubsMeasurements();
    const subMeasurement = subsMeasurements[0];
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

    // AVR distance window (closest channel + 6 m, or 7.35 m with the hack):
    // the relative sub delays searched here consume the same budget as the
    // LATER group alignment with a front speaker (produceAligned), so:
    //  - negative bound: a sub moved earlier must not descend below the
    //    current anchor (the closest channel) — otherwise the window slides
    //    and every other channel loses margin. Distances share the global
    //    shift, so the margin is a pure cumulativeIRShiftSeconds difference.
    //  - positive bound: reserve the latitude the group alignment will need —
    //    estimated from the IR-peak gap between the sub group (reference sub,
    //    delays just equalised) and the front speakers (worst case, signed:
    //    a LATE sub reserves the positive side, an EARLY one the anchor side).
    // Without the list providers (historical test surface) the bounds stay
    // symmetric at ±headroom.
    const shiftOf = m => unwrap(m.cumulativeIRShiftSeconds);
    const peakOf = m => unwrap(m.timeOfIRPeakSeconds);

    let anchorMarginSeconds = headroomSeconds;
    const allMeasurements = lists.uniqueMeasurements?.() ?? null;
    if (allMeasurements?.length) {
      const minSubShift = Math.min(...subsMeasurements.map(shiftOf));
      const minAllShift = Math.min(...allMeasurements.map(shiftOf));
      if (Number.isFinite(minSubShift) && Number.isFinite(minAllShift)) {
        anchorMarginSeconds = Math.max(0, minSubShift - minAllShift);
      }
    }

    // Alignment reserve. Preferred source: gaps MEASURED like produceAligned
    // will (predicted LFE vs speaker, both crossover-filtered — the filters'
    // group delay is included). Fallback: raw IR-peak gaps, an approximation
    // biased by that group delay.
    let reserveLateSeconds = 0;
    let reserveEarlySeconds = 0;
    const measuredGaps = (alignmentGapsSeconds ?? []).filter(Number.isFinite);
    if (measuredGaps.length) {
      for (const gapSeconds of measuredGaps) {
        reserveLateSeconds = Math.max(reserveLateSeconds, gapSeconds);
        reserveEarlySeconds = Math.max(reserveEarlySeconds, -gapSeconds);
      }
    } else {
      const subPeakSeconds = peakOf(subMeasurement);
      for (const speaker of lists.frontSpeakersMeasurements?.() ?? []) {
        const gapSeconds = subPeakSeconds - peakOf(speaker);
        if (!Number.isFinite(gapSeconds)) continue;
        reserveLateSeconds = Math.max(reserveLateSeconds, gapSeconds);
        reserveEarlySeconds = Math.max(reserveEarlySeconds, -gapSeconds);
      }
    }

    const maxDelaySeconds = cleanFloat32Value(
      Math.max(0, headroomSeconds - reserveLateSeconds),
      4,
    );
    const minDelaySeconds = cleanFloat32Value(
      -Math.max(0, anchorMarginSeconds - reserveEarlySeconds),
      4,
    );
    if (maxDelaySeconds === 0 && minDelaySeconds === 0) {
      log.warn(
        'No delay latitude left (distance window + alignment reserve): only polarity/all-pass will be optimized.',
      );
    } else {
      log.info(
        `Delay budget: anchor margin ${(anchorMarginSeconds * 1000).toFixed(2)}ms, ` +
          `alignment reserve ${(reserveLateSeconds * 1000).toFixed(2)}ms late / ` +
          `${(reserveEarlySeconds * 1000).toFixed(2)}ms early`,
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
        min: minDelaySeconds,
        max: maxDelaySeconds,
        step: config.jsonAvrData.avr.minDistAccuracy || 0.00001,
      },
      allPass: {
        enabled: config.useAllPassFiltersForSubs,
        frequency: { min: 10, max: 500, step: 10 },
        q: { min: 0.1, max: 0.5, step: 0.1 },
      },
      optimization: {
        // 'pre-eq': the sub sum is EQ'd toward the target curve afterwards,
        // so the optimizer maximizes what EQ cannot fix — level vs the
        // coherent sum (headroom), no cancellation nulls, no group-delay
        // trailing — and ignores peaks/smoothness, which a later EQ cut
        // corrects for free (including the time-domain ringing of
        // minimum-phase room modes). Measured vs 'balanced': equal or better
        // efficiency on every fixture, equal or better group-delay excess,
        // identical run time.
        objective: 'pre-eq',
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
    if (sub.param.gain) {
      // Bookkeep the optimizer's own trim so the next run's preamble can
      // revert exactly this contribution without touching manual settings.
      subMeasurement.jointGainDb = sub.param.gain;
    }
    await mops.copySplOffsetDeltadBToOther(subMeasurement);
    await applySubAllPassFilter(subMeasurement, sub.param.allPass);
    await applySubIndividualFilters(subMeasurement, sub.param.filters);
  }

  /**
   * Writes the per-sub PK filters of the joint (target-match) solution in
   * slots 1..N. Non-auto so later bulk writes with overwrite=false (the
   * shared-EQ path) leave them alone — same convention as the slot-20
   * all-pass reservation. Slots start clean: the optimizer preamble resets
   * every sub's filters before capturing the responses.
   */
  async function applySubIndividualFilters(subMeasurement, filters) {
    if (!filters?.length) return;

    for (const [filterIndex, filter] of filters.entries()) {
      await mops.setSingleFilter(subMeasurement, {
        index: filterIndex + 1,
        enabled: true,
        isAuto: false,
        type: 'PK',
        frequency: filter.frequency,
        // REW's filter field is `gaindB` — an unknown `gain` key is silently
        // ignored and the filter stays at 0 dB (observed on a live REW).
        gaindB: filter.gain,
        q: filter.q,
      });
    }
  }

  /** Full MultiSubOptimizer sequence over the given frequency bands. */
  /**
   * Measures the sub↔front alignment gaps (delay reserve) on the refreshed
   * projection — delays equalised, filters just purged — exactly like
   * produceAligned will measure them. Returns null on the historical surface
   * (no virtual subwoofers or no gap measurement available).
   */
  async function measureAlignmentGaps(subsMeasurements, applySameDelayToAll) {
    if (!virtualSubwoofers || !businessTools.alignmentGapSeconds) {
      //delete previous LFE predicted measurements
      await session.removeMeasurements(lists.predictedLfeMeasurements());
      await applySameDelayToAll();
      return null;
    }

    await applySameDelayToAll();
    await virtualSubwoofers.refresh(unwrap(subsMeasurements[0].position), {
      force: true,
    });
    const alignmentGapsSeconds = [];
    for (const speaker of lists.frontSpeakersMeasurements?.() ?? []) {
      try {
        const gapSeconds = await businessTools.alignmentGapSeconds(speaker);
        if (gapSeconds != null) alignmentGapsSeconds.push(gapSeconds);
      } catch (error) {
        log.warn(
          `Alignment gap measurement failed for ${labelOf(speaker)}: ${error.message}`,
        );
      }
    }
    //delete previous LFE predicted measurements
    await session.removeMeasurements(lists.predictedLfeMeasurements());
    return alignmentGapsSeconds;
  }

  /**
   * Reverts the gain trims the PREVIOUS joint run applied (recorded as
   * jointGainDb on each measurement) — and only those: the user's manual
   * +/- level adjustments and the align-SPL reference are untouched. This
   * targeted bookkeeping is what makes the per-sub gain dimension safe
   * across iterations without crushing user settings. Align SPL clears the
   * bookkeeping itself (its absolute re-anchor absorbs any pending trim).
   */
  async function revertPreviousJointGains(subsMeasurements) {
    for (const measurement of subsMeasurements) {
      const appliedGain = Number(unwrap(measurement.jointGainDb)) || 0;
      if (appliedGain === 0) continue;

      log.info(
        `Reverting previous joint gain of ${appliedGain.toFixed(2)} dB on ${labelOf(measurement)}`,
      );
      await mops.addSPLOffsetDB(measurement, -appliedGain);
      await mops.copySplOffsetDeltadBToOther(measurement);
      measurement.jointGainDb = 0;
    }
  }

  /**
   * Shared preamble of the legacy and joint optimizers: guards, delay
   * equalisation, delay-budget measurement, previous-results cleanup, per-sub
   * clean state and frequency-response capture. Returns null when the
   * single-sub case was fully handled here.
   */
  async function prepareMultiSubOptimization(subsFrequencyBands) {
    const subsMeasurements = lists.uniqueSubsMeasurements();

    if (subsMeasurements.length === 0) {
      throw new Error('No subwoofers found');
    }
    if (subsMeasurements.length === 1) {
      if (!virtualSubwoofers) {
        throw new Error(
          'Only one subwoofer found, please use single sub optimizer button',
        );
      }
      // ADR 003 — nothing to optimise with a single sub: project its response.
      log.info('Single subwoofer: refreshing the LFE predicted projection');
      await virtualSubwoofers.refresh(unwrap(subsMeasurements[0].position), {
        force: true,
      });
      return null;
    }

    if (!subsFrequencyBands?.lowFrequency || !subsFrequencyBands?.highFrequency) {
      throw new Error(
        'Subwoofer frequency bands not defined, please use Align SPL button first',
      );
    }

    // set the same delay for all subwoofers (parity with setSameDelayToAll:
    // early-return on a single sub, align the others to the first sub's delay —
    // [0] already carries mainDelay, so skip it rather than issue a no-op write).
    const applySameDelayToAll = async () => {
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
    };

    // Reset the previous run's per-sub state BEFORE anything is measured:
    // leftover inversions and filters (legacy polarity, joint PK filters)
    // would skew both the alignment-gap measurement (delay reserve) and the
    // responses captured for the optimizer.
    log.info(`Resetting previous sub settings...`);
    for (const measurement of subsMeasurements) {
      await mops.resetFilters(measurement);
      await mops.setInverted(measurement, false);
    }

    await revertPreviousJointGains(subsMeasurements);

    const alignmentGapsSeconds = await measureAlignmentGaps(
      subsMeasurements,
      applySameDelayToAll,
    );

    const optimizerConfig = createOptimizerConfig(
      subsFrequencyBands.lowFrequency,
      subsFrequencyBands.highFrequency,
      { alignmentGapsSeconds },
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
      // Filters and inversion were reset before the gap measurement; only
      // the working settings remain to apply before capturing the responses.
      await mops.applyWorkingSettings(measurement);
      const frequencyResponse = await mops.getFrequencyResponse(measurement);
      frequencyResponse.measurement = measurement.uuid;
      frequencyResponse.name = labelOf(measurement);
      frequencyResponse.position = unwrap(measurement.position);
      frequencyResponses.push(frequencyResponse);
    }

    return { subsMeasurements, optimizerConfig, frequencyResponses };
  }

  /** Recompute (or import) the maximised sum after the optimised settings. */
  async function produceMaximisedSum(subsMeasurements, optimizer, frequencyResponses) {
    log.info(`Creating sub sumation...`);

    if (virtualSubwoofers) {
      // ADR 003 — the optimised settings are applied to the real subs, so the
      // recomputed projection *is* the maximised sum. The Theo reference is
      // the RAW ceiling — zero-phase sum of the responses captured on clean
      // subs (no EQ filters, no gain trims) — so it stays identical whatever
      // settings the optimizer (legacy or joint) applied.
      const theoResponse = optimizer.calculateCombinedResponse(
        frequencyResponses,
        true,
        false,
      );
      return virtualSubwoofers.refresh(unwrap(subsMeasurements[0].position), {
        force: true,
        withTheo: true,
        theoResponse,
      });
    }

    const optimizedSubsSum = optimizer.getFinalSubSum();
    const maximisedSum = await sendToREW(optimizedSubsSum, MAXIMISED_SUM_TITLE);
    maximisedSum.isSubOperationResult = true;

    const maximisedSumTheo = await sendToREW(
      optimizer.theoreticalMaxResponse,
      MAXIMISED_SUM_TITLE + ' Theo',
    );
    maximisedSumTheo.isSubOperationResult = true;

    return maximisedSum;
  }

  async function runLegacyMultiSubOptimizer({
    subsMeasurements,
    optimizerConfig,
    frequencyResponses,
  }) {
    log.info(`Sarting lookup...`);
    const optimizer = new MultiSubOptimizer(frequencyResponses, optimizerConfig, log);
    const optimizerResults = optimizer.optimizeSubwoofers();

    for (const sub of optimizerResults.optimizedSubs) {
      await applyOptimizedSubSettings(sub);
    }

    const maximisedSum = await produceMaximisedSum(
      subsMeasurements,
      optimizer,
      frequencyResponses,
    );

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

  /**
   * Joint (target-match) optimizer: alignment AND per-sub filters solved
   * together against the target curve — one process replacing the legacy
   * two-step logic (align, then copy one shared EQ onto every sub). The
   * user gets a complete per-sub solution: delay, polarity, gain and
   * individual PK filters.
   */
  async function runJointMultiSubOptimizer(
    { subsMeasurements, optimizerConfig, frequencyResponses },
    { onProgress = null } = {},
  ) {
    // The target curve (house curve at the configured target level) anchors
    // the absolute goal, exactly like equalize-sub anchors REW's matchTarget.
    const targetSource = subsMeasurements[0];
    await mops.setTargetLevel(targetSource, config.mainTargetLevel);
    await mops.resetTargetSettings(targetSource);
    const targetCurve = await mops.getTargetResponse(targetSource, 'SPL', 96);

    optimizerConfig.allPass.enabled = false;
    optimizerConfig.optimization.objective = 'target-match';
    optimizerConfig.optimization.targetCurve = {
      freqs: targetCurve.freqs,
      magnitude: targetCurve.magnitude,
    };
    // The per-sub filters honour the app's boost settings, like the shared
    // EQ always did: `maxBoostIndividualValue` bounds each filter's gain and
    // `maxBoostOverallValue` caps the cumulative per-sub boost (soft
    // constraint in the effort regularizer). Boosting is the wrong answer to
    // an interference dip — the other subs are.
    // createOptimizerConfig carries no joint block (the engine normalizes it
    // in the constructor): start from the engine defaults before overriding.
    const joint = {
      ...structuredClone(MultiSubOptimizer.DEFAULT_CONFIG.optimization.joint),
      ...(optimizerConfig.optimization.joint ?? {}),
    };
    const individualBoostCap = Number(config.maxBoostIndividualValue);
    if (Number.isFinite(individualBoostCap)) {
      joint.filterGain = {
        ...joint.filterGain,
        max: Math.min(joint.filterGain.max, individualBoostCap),
      };
    }
    const overallBoostCap = Number(config.maxBoostOverallValue);
    if (Number.isFinite(overallBoostCap)) {
      joint.overallBoostCapDb = overallBoostCap;
    }
    optimizerConfig.optimization.joint = joint;

    // Test/e2e hook: lets the caller shrink the solver budget (population,
    // generations, filtersPerSub…) without exposing UI settings.
    if (config.jointOptimizerBudget) {
      optimizerConfig.optimization.joint = {
        ...optimizerConfig.optimization.joint,
        ...config.jointOptimizerBudget,
      };
    }

    log.info(`Starting joint lookup (target-match)...`);
    const optimizer = new MultiSubOptimizer(frequencyResponses, optimizerConfig, log);
    const optimizerResults = await optimizer.optimizeSubwoofersJoint({
      onProgress: progress => {
        onProgress?.(progress);
        if (progress.generation % 200 === 0) {
          log.info(
            `Joint ${progress.phase}: generation ${progress.generation}/${progress.generations}, score ${progress.bestScore.toFixed(2)}`,
          );
        }
      },
    });

    // The reference sub is part of the joint result (it carries filters).
    for (const sub of optimizerResults.optimizedSubs) {
      await applyOptimizedSubSettings(sub);
    }

    await produceMaximisedSum(subsMeasurements, optimizer, frequencyResponses);
    return optimizerResults;
  }

  async function multiSubOptimizer(subsFrequencyBands, options = {}) {
    const prepared = await prepareMultiSubOptimization(subsFrequencyBands);
    if (!prepared) return;

    if (config.useJointSubOptimization) {
      await runJointMultiSubOptimizer(prepared, options);
      return;
    }
    await runLegacyMultiSubOptimizer(prepared);
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
