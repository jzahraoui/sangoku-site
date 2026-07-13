import { FrequencyResponseAnalyzer } from '../analysis/index.js';
import {
  cleanFloat32Value,
  compareIrWindows,
  compareObjectsSorted,
} from '../measurement/measurement-calculations.js';
import {
  buildPhaseMatchFilters,
  createEmptyFilters,
  validatePhaseMatchRange,
} from '../measurement/filter-slots.js';
import {
  applyTargetProfile,
  computeReferenceProfile,
  meanProfileOffset,
} from '../measurement/reference-compensation.js';
import { applyBankAndCrossoverToIr } from '../measurement/rew-filter-bank.js';
import { combineImpulseResponses } from '../dsp/impulseResponse.js';

/**
 * Simple REW wrappers extracted from MeasurementItem
 * (ADR 002).
 *
 * [ORCHESTRATION] service: functions `(rew, measurement, params)` with no
 * Knockout and no DOM. `rew` is the REW measurements API service
 * (`parentViewModel.rewMeasurements` today). `measurement` exposes plain
 * fields (`uuid`, `notes`, `haveImpulseResponse`, `sampleRate`, `isFilter`),
 * fields read through `unwrap` (KO observables today, plain record fields
 * after ADR 002) and `update(partial)` for state write-back.
 *
 * Sequences receive a `session`
 * object — the parts of the viewmodel that own the measurement list until the
 * rew-session service exists:
 *   { analyseApiResponse, removeMeasurements, removeMeasurementUuid,
 *     findMeasurementByUuid }
 *
 * Instantiate with `createMeasurementOperations({ log })`; the logger is
 * injected so this module never depends on `logs.js` (split pending).
 * Log-free operations live at module scope and are re-exposed by the factory.
 */

const AUTO_DISABLE_FILTER_TYPES = new Set(['LP', 'HP', 'HS', 'LS', 'All pass']);

const DEFAULT_TARGET_LEVEL = 75;

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const unwrap = value => (typeof value === 'function' ? value() : value);

const labelOf = m => unwrap(m.displayMeasurementTitle) ?? unwrap(m.title);

// --- Log-free operations ----------------------------------------------------

async function toggleInversion(rew, m) {
  const newInverted = !unwrap(m.inverted);
  await rew.invert(m.uuid);
  m.update({ inverted: newInverted });
  return true;
}

async function setTitle(rew, m, newTitle, notes) {
  const titleChanged = newTitle !== undefined && newTitle !== unwrap(m.title);
  const notesChanged = notes !== undefined && notes !== m.notes;

  if (!titleChanged && !notesChanged) {
    return false;
  }
  await rew.update(m.uuid, { title: newTitle, notes });

  const partial = {};
  if (titleChanged) partial.title = newTitle;
  if (notes !== undefined) partial.notes = notes;
  m.update(partial);

  return true;
}

async function defaultSmoothing(rew, m, smoothingMethod) {
  // actually not possible to check current smoothing method
  return rew.smoothMeasurements([m.uuid], smoothingMethod);
}

async function setSmoothing(rew, m, smoothingMethod) {
  // actually not possible to check current smoothing method
  return rew.smooth([m.uuid], smoothingMethod);
}

async function setTargetSettings(rew, m, targetSettings) {
  return rew.postTargetSettings(m.uuid, targetSettings);
}

async function getEqualiser(rew, m) {
  return rew.getEqualiser(m.uuid);
}

async function isDefaultEqualiser(rew, m, defaultSettings) {
  const commandResult = await getEqualiser(rew, m);

  return (
    commandResult.manufacturer === defaultSettings.manufacturer &&
    commandResult.model === defaultSettings.model
  );
}

async function getFilters(rew, m) {
  const measurementFilters = await rew.getFilters(m.uuid);
  for (const filter of measurementFilters) {
    if (AUTO_DISABLE_FILTER_TYPES.has(filter.type)) {
      filter.isAuto = false;
    }
  }
  return measurementFilters;
}

async function setSingleFilter(rew, m, filter) {
  if (!filter) {
    throw new Error(`Invalid filter: ${filter}`);
  }

  const filters = await getFilters(rew, m);
  const found = filters.find(f => f.index === filter.index);
  if (!found) {
    throw new Error(`Filter with index ${filter.index} not found`);
  }
  if (compareObjectsSorted(filter, found)) {
    return false;
  }

  await rew.setFilters(m.uuid, filter);

  return true;
}

async function getFreeXFilterIndex(rew, m, defaultSettings) {
  if (!(await isDefaultEqualiser(rew, m, defaultSettings))) {
    throw new Error(`Invalid Equaliser: ${labelOf(m)}`);
  }

  const filters = await getFilters(rew, m);
  const freeIndex = [20, 21].find(i => filters[i]?.type === 'None');

  if (freeIndex === undefined) {
    throw new Error(`No free filter index found: ${labelOf(m)}`);
  }

  return freeIndex + 1;
}

async function getFrequencyResponse(
  rew,
  m,
  { unit = 'SPL', smoothing = 'None', ppo = null } = {},
) {
  const options = { unit, smoothing, ...(ppo && { ppo }) };

  return rew.getFrequencyResponse(m.uuid, options);
}

async function getTargetResponse(rew, m, { unit = 'SPL', ppo = 96 } = {}) {
  return rew.getTargetResponse(m.uuid, { unit, ppo });
}

async function getImpulseResponse(
  rew,
  m,
  { freq, unit = 'percent', windowed = true, normalised = true } = {},
) {
  const options = { unit, windowed, normalised, ...(freq && { samplerate: freq }) };
  const reponseBody = await rew.getImpulseResponse(m.uuid, options);

  return reponseBody.data;
}

/**
 * Variante de getImpulseResponse exposant le référentiel temporel complet
 * (startTime, sampleRate) avec les échantillons — nécessaire à l'alignement
 * temporel interne. Par défaut : IR brute (ni fenêtrée ni normalisée).
 */
async function getImpulseResponseInfo(
  rew,
  m,
  { unit = 'percent', windowed = false, normalised = false } = {},
) {
  const body = await rew.getImpulseResponse(m.uuid, { unit, windowed, normalised });
  return {
    data: body.data,
    sampleRate: body.sampleRate,
    startTime: body.startTime ?? 0,
  };
}

/**
 * Variante de getPredictedImpulseResponse exposant le référentiel temporel
 * complet, IR brute par défaut. La réponse de /eq/impulse-response est
 * IDENTIQUE BIT À BIT à l'IR de la mesure générée par eqGenerate (mesuré,
 * REW 5.40 B128) : le bank de la mesure — quel que soit le type des
 * filtres — et le flag d'inversion y sont intégrés.
 */
async function getPredictedImpulseResponseInfo(
  rew,
  m,
  { unit = 'percent', windowed = false, normalised = false } = {},
) {
  const body = await rew.getPredictedImpulseResponse(m.uuid, {
    unit,
    windowed,
    normalised,
  });
  return {
    data: body.data,
    sampleRate: body.sampleRate,
    startTime: body.startTime ?? 0,
  };
}

/**
 * IR « predicted + raccord » sans mesure temporaire : l'IR predicted est lue
 * telle que REW la calcule (1 lecture, bank intégré — voir
 * getPredictedImpulseResponseInfo) et seul le filtre de raccord est réalisé
 * en local — remplace la génération de mesures predicted temporaires dans
 * REW (eqGenerate ×N + suppressions) pour les chemins d'alignement.
 */
async function getCrossoverFilteredIr(rew, m, crossoverSetting = null) {
  const ir = await getPredictedImpulseResponseInfo(rew, m);
  return applyBankAndCrossoverToIr(ir, [], crossoverSetting);
}

/**
 * « Somme vraie » des subs, filtrée au raccord : Σ pondérée (splOffsetdB —
 * les exports d'IR REW n'intègrent pas le niveau) des IR predicted des subs
 * réels, dans le référentiel absolu. Contrairement à la projection LFE
 * predicted (synthèse + import + offsets successifs), cette somme ne dépend
 * d'aucun état intermédiaire : le même état des subs donne toujours la même
 * IR — l'alignement devient déterministe.
 */
async function getCombinedSubsCrossoverFilteredIr(rew, subs, crossoverSetting = null) {
  if (!subs?.length) {
    throw new Error('No subwoofer measurements to combine');
  }
  const irs = [];
  const weightsDb = [];
  for (const sub of subs) {
    irs.push(await getPredictedImpulseResponseInfo(rew, sub));
    weightsDb.push(unwrap(sub.splOffsetdB) ?? 0);
  }
  const sum = combineImpulseResponses(irs, weightsDb);
  return applyBankAndCrossoverToIr(sum, [], crossoverSetting);
}

async function getFilterImpulseResponse(rew, m, { freq, sampleCount } = {}) {
  if (!freq || !sampleCount) {
    throw new Error(`Invalid frequency or sample count for ${labelOf(m)}`);
  }
  const options = { length: sampleCount, samplerate: freq };
  const reponseBody = await rew.getFiltersImpulseResponse(m.uuid, options);

  return reponseBody.data;
}

async function getPredictedImpulseResponse(
  rew,
  m,
  { freq, unit = 'percent', windowed = true, normalised = true } = {},
) {
  const options = { unit, windowed, normalised, ...(freq && { samplerate: freq }) };
  const reponseBody = await rew.getPredictedImpulseResponse(m.uuid, options);

  return reponseBody.data;
}

async function resolveSampleRate(rew, m) {
  if (Number.isFinite(m.sampleRate)) {
    return m.sampleRate;
  }

  if (!m.haveImpulseResponse) {
    throw new TypeError(`Sample rate unavailable for ${labelOf(m)}`);
  }

  const impulseResponse = await rew.getImpulseResponse(m.uuid, {
    unit: 'percent',
    windowed: false,
    normalised: false,
  });

  if (!Number.isFinite(impulseResponse?.sampleRate)) {
    throw new TypeError(`Sample rate unavailable for ${labelOf(m)}`);
  }

  m.update({ sampleRate: impulseResponse.sampleRate });
  return impulseResponse.sampleRate;
}

async function getBandwidth(rew, m) {
  if (m.cachedBandwidth) {
    return m.cachedBandwidth;
  }

  const frequencyResponse = await getFrequencyResponse(rew, m, { smoothing: '1/6' });
  m.cachedBandwidth = FrequencyResponseAnalyzer.detectBandwidth(frequencyResponse, {
    rangeHz: [10, 20000],
    thresholdDb: -6,
  });
  return m.cachedBandwidth;
}

/**
 * Use the current target curve frequency response to detect the frequency
 * cutoff points.
 */
async function detectFallOff(rew, m, { threshold = -3, ppo = 12 } = {}) {
  const measurementData = await getFrequencyResponse(rew, m, {
    smoothing: '1/6',
    ppo,
  });
  const targetCurveData = await getTargetResponse(rew, m, { ppo });

  return FrequencyResponseAnalyzer.detectTargetRelativeFallOff(
    targetCurveData,
    measurementData,
    { thresholdDb: threshold },
  );
}

// --- Log-free sequences ----------------------------------------------

/** Parse an alignSPL response to get the alignSPLOffsetdB for the target UUID. */
function getAlignSPLOffsetdBByUUID(responseData, targetUUID) {
  try {
    if (!responseData?.results) {
      throw new Error('Invalid response data');
    }
    // Find the result with matching UUID
    const result = Object.values(responseData.results).find(
      item => item.UUID === targetUUID,
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

async function trimIRToWindows(rew, m, session) {
  // Check if cumulative IR distance exists and is valid
  if (!m.haveImpulseResponse) {
    return;
  }
  const result = await rew.trimIRToWindows(m.uuid);
  const newMeasurement = await session.analyseApiResponse(result);
  if (!newMeasurement) {
    throw new Error(`trimIRToWindows failed for ${labelOf(m)}`);
  }
  return newMeasurement;
}

async function responseCopy(rew, m) {
  return rew.responseCopy(m.uuid);
}

async function createMinimumPhaseCopy(rew, m) {
  return rew.minimumPhaseVersion(m.uuid, {
    'include cal': true,
    'append lf tail': false,
    'append hf tail': false,
    'frequency warping': false,
    'replicate data': true,
  });
}

async function createExcessPhaseCopy(rew, m) {
  return rew.excessPhaseVersion(m.uuid, {
    'include cal': true,
    'append lf tail': false,
    'append hf tail': false,
    'frequency warping': false,
    'replicate data': true,
  });
}

async function checkFilterGain(rew, m) {
  const filters = await getFilters(rew, m);
  for (const filter of filters) {
    if (filter.type !== 'PK') continue;
    // check if PK filters are inside limits -25dB to +25dB
    if (filter.gaindB < -25 || filter.gaindB > 25) {
      throw new Error(
        `${labelOf(m)} Filter ${filter.index} gain is out of limits: ${Math.round(
          filter.gaindB,
        )}dB. Please add High Pass to X1 or X2 filter`,
      );
    }
    // check if PK filters are inside limits 0.1 to 20
    if (filter.q < 0.1 || filter.q > 20) {
      throw new Error(
        `${labelOf(m)} Filter ${filter.index} Q is out of limits: ${filter.q}.`,
      );
    }
  }
}

async function arithmeticSum(rew, m, otherMeasurement, session) {
  const apiResponse = await rew.arithmeticAPlusB(m.uuid, otherMeasurement.uuid);
  return session.analyseApiResponse(apiResponse);
}

async function arithmeticConvolution(rew, m, otherMeasurement, session) {
  const apiResponse = await rew.arithmeticATimesB(m.uuid, otherMeasurement.uuid);
  return session.analyseApiResponse(apiResponse);
}

async function arithmeticADividedByB(
  rew,
  m,
  otherMeasurement,
  session,
  maxGain = null,
  lowerLimit = null,
  upperLimit = null,
) {
  const apiResponse = await rew.arithmeticADividedByB(
    m.uuid,
    otherMeasurement.uuid,
    maxGain,
    lowerLimit,
    upperLimit,
  );
  return session.analyseApiResponse(apiResponse);
}

async function arithmeticInvertAPhase(
  rew,
  m,
  otherMeasurement,
  session,
  lowerLimit = null,
  upperLimit = null,
) {
  const apiResponse = await rew.arithmeticInvertAPhase(
    m.uuid,
    otherMeasurement.uuid,
    lowerLimit,
    upperLimit,
  );
  return session.analyseApiResponse(apiResponse);
}

async function producePredictedMeasurement(rew, m, session) {
  if (m.isFilter) {
    throw new Error(`action can not be done on a Filter: ${labelOf(m)}`);
  }

  const apiResponse = await rew.generatePredictedMeasurement(m.uuid);
  const PredictedFiltered = await session.analyseApiResponse(apiResponse);
  if (!PredictedFiltered) {
    throw new Error('Cannot generate predicted measurement');
  }

  await setTitle(rew, PredictedFiltered, `predicted ${unwrap(m.title)}`);

  return PredictedFiltered;
}

// --- Factory binding the injected logger --------------------------------------

function createMeasurementOperations({ log = noopLog } = {}) {
  const cleanValue = (value, precision) =>
    cleanFloat32Value(value, precision, raw => log.warn(`Invalid numeric value: ${raw}`));

  // splOffsetDeltadB derived from the flat fields (splOffsetdB - initialSplOffsetdB),
  // so ops work on plain MeasurementRecords (ADR 002) as well as the KO adapter —
  // identical to MeasurementItem.splOffsetDeltadB.
  const splOffsetDeltadBOf = m =>
    cleanValue(unwrap(m.splOffsetdB) - m.initialSplOffsetdB, 2);

  async function setInverted(rew, m, inverted, { toggle } = {}) {
    // refreshed every second when connected
    if (inverted === unwrap(m.inverted)) return;
    log.debug(`${labelOf(m)}: Setting inverted to ${inverted}`);
    return (toggle ?? (() => toggleInversion(rew, m)))();
  }

  async function resetSmoothing(rew, m) {
    log.debug(`${labelOf(m)}: Resetting smoothing`);
    return rew.removeSmoothing([m.uuid]);
  }

  async function setIrWindows(rew, m, irWindowsObject) {
    if (!m.haveImpulseResponse) {
      return;
    }

    const commandResult = await rew.getIRWindows(m.uuid);

    if (compareIrWindows(commandResult, irWindowsObject)) return true;

    log.debug(`${labelOf(m)}: Setting IR windows`);
    return rew.setIRWindows(m.uuid, irWindowsObject);
  }

  async function resetIrWindows(rew, m, { leftWindowWidthms, rightWindowWidthms }) {
    return setIrWindows(rew, m, {
      leftWindowType: 'Rectangular',
      rightWindowType: 'Rectangular',
      leftWindowWidthms,
      rightWindowWidthms,
      refTimems: unwrap(m.timeOfIRPeakSeconds) * 1000,
      addFDW: false,
      addMTW: false,
    });
  }

  async function resetTargetSettings(rew, m) {
    log.debug(`${labelOf(m)}: Resetting target settings`);
    return rew.resetTargetSettings(m.uuid);
  }

  async function resetRoomCurveSettings(rew, m) {
    log.debug(`${labelOf(m)}: Resetting room curve settings`);
    await rew.resetRoomCurveSettings(m.uuid);
  }

  async function setRoomCurveSettings(rew, m, settings) {
    if (!settings || typeof settings !== 'object') {
      throw new Error('Invalid room curve settings');
    }

    if (!settings.addRoomCurve) {
      return resetRoomCurveSettings(rew, m);
    }

    log.debug(`${labelOf(m)}: Setting room curve settings`);
    return rew.setRoomCurveSettings(m.uuid, settings);
  }

  async function resetEqualiser(rew, m, defaultSettings) {
    if (await isDefaultEqualiser(rew, m, defaultSettings)) {
      return true;
    }
    log.debug(`${labelOf(m)}: Resetting equaliser to Generic EQ`);
    await rew.setEqualiser(m.uuid, defaultSettings);
  }

  async function getTargetLevel(rew, m) {
    const level = await rew.getTargetLevel(m.uuid);
    return cleanValue(level, 2);
  }

  async function setTargetLevel(rew, m, level, session = {}) {
    // Check if level is undefined/null, but allow zero
    if (level === undefined || level === null) {
      throw new TypeError(`Invalid level: ${level}`);
    }
    level = cleanValue(level, 2);

    const currentLevel = await getTargetLevel(rew, m);
    if (level.toFixed(2) === currentLevel.toFixed(2)) {
      return true;
    }

    log.debug(`${labelOf(m)}: Target level set to ${level.toFixed(1)} dB`);
    await rew.setTargetLevel(m.uuid, level);

    return resetFilters(rew, m, session);
  }

  async function setFilters(
    rew,
    m,
    filters,
    { overwrite = true } = {},
  ) {
    if (!filters) {
      throw new Error(`Invalid filter: ${filters}`);
    }
    // Partial banks are nominal (shared-EQ writes carry the free slots only);
    // more entries than the REW bank is a real anomaly.
    if (filters.length > 22) {
      log.warn(`Invalid filter length: ${filters.length}, REW bank holds 22`);
    }

    const allFilters = await getFilters(rew, m);

    if (compareObjectsSorted(allFilters, filters)) {
      return false;
    }

    const currentFilters = overwrite ? allFilters : allFilters.filter(f => f.isAuto);

    const filtersCleaned = [];
    for (const filter of filters) {
      const index = filter.index;
      const found = currentFilters.find(f => f.index === index);
      if (!found) {
        // Clearing ('None') a slot the measurement holds as non-auto is a
        // no-op, not an anomaly: the empty bank of the auto-slot clearing
        // pass legitimately spans the reserved slots.
        if (filter.type !== 'None') {
          log.warn(
            `Filter with index ${index} not found in current filters, make sure Generic EQ is selected`,
          );
        }
        continue;
      }
      // set auto to false if type is all pass
      if (filter.type === 'All pass' || index > 20) {
        filter.isAuto = false;
        found.isAuto = false;
      }
      if (!compareObjectsSorted(filter, found)) {
        filtersCleaned.push(filter);
      }
    }
    if (filtersCleaned.length === 0) {
      return true;
    }

    log.debug(`${labelOf(m)}: Setting ${filtersCleaned.length} filters`);
    return rew.postFilters(m.uuid, {
      filters: filtersCleaned,
    });
  }

  async function resetFilters(rew, m, session = {}) {
    return setFilters(rew, m, createEmptyFilters(), session);
  }

  async function setAllFiltersAuto(rew, m, requiredState = true, session = {}) {
    const filters = await getFilters(rew, m);
    for (const filter of filters) {
      if (filter.type === 'PK' && filter.index <= 20 && filter.isAuto !== requiredState) {
        filter.isAuto = requiredState;
      }
    }
    await setFilters(rew, m, filters, session);
    return true;
  }

  async function applyWorkingSettings(
    rew,
    m,
    { smoothingMethod, roomCurveSettings, irWindows },
  ) {
    if (m.isFilter) {
      throw new Error(`Operation not permitted on a filter ${labelOf(m)}`);
    }
    await defaultSmoothing(rew, m, smoothingMethod);
    await setRoomCurveSettings(rew, m, roomCurveSettings);
    await setIrWindows(rew, m, irWindows);
  }

  async function removeWorkingSettings(rew, m, { leftWindowWidthms, rightWindowWidthms }) {
    if (m.isFilter) {
      throw new Error(`Operation not permitted on a filter ${labelOf(m)}`);
    }
    await resetIrWindows(rew, m, { leftWindowWidthms, rightWindowWidthms });
    await resetSmoothing(rew, m);
  }

  async function restoreWorkingSettings(
    rew,
    m,
    workingConfig,
    useWorkingSettings,
    operationError,
  ) {
    if (useWorkingSettings) {
      return operationError;
    }

    try {
      await applyWorkingSettings(rew, m, workingConfig);
      return operationError;
    } catch (restoreError) {
      if (operationError) {
        log.warn(
          `${labelOf(m)}: failed to restore working settings after phase match filter creation: ${restoreError.message}`,
        );
        return operationError;
      }

      return new Error(`Phase match filter restoration failed: ${restoreError.message}`, {
        cause: restoreError,
      });
    }
  }

  // --- IR shift / SPL offset sequences --------------------------------

  async function addIROffsetSeconds(rew, m, amountToAdd) {
    if (!m.haveImpulseResponse) {
      return;
    }
    // 2 decimals on ms value
    amountToAdd = cleanValue(amountToAdd, 10);
    if (amountToAdd === 0) {
      return false;
    }
    const newCumulativeShift = cleanValue(
      unwrap(m.cumulativeIRShiftSeconds) + amountToAdd,
      10,
    );
    await rew.offsetTZero(m.uuid, amountToAdd);
    // offsetTZero shifts every time reference: mirror the peak/start times
    // locally so reads before the next poll (IR window refTime, peak
    // arithmetic) stay correct and the poll echo is not a change.
    const partial = { cumulativeIRShiftSeconds: newCumulativeShift };
    const peakSeconds = unwrap(m.timeOfIRPeakSeconds);
    if (Number.isFinite(peakSeconds)) {
      partial.timeOfIRPeakSeconds = peakSeconds - amountToAdd;
    }
    const startSeconds = unwrap(m.timeOfIRStartSeconds);
    if (Number.isFinite(startSeconds)) {
      partial.timeOfIRStartSeconds = startSeconds - amountToAdd;
    }
    m.update(partial);
    log.debug(`Offset t=${(amountToAdd * 1000).toFixed(2)}ms added to ${unwrap(m.title)}`);
    return true;
  }

  async function setcumulativeIRShiftSeconds(rew, m, newValue) {
    await addIROffsetSeconds(rew, m, newValue - unwrap(m.cumulativeIRShiftSeconds));
  }

  async function resetcumulativeIRShiftSeconds(rew, m) {
    log.debug(`${labelOf(m)}: Resetting cumulative IR shift to 0s`);
    await setcumulativeIRShiftSeconds(rew, m, 0);
  }

  async function setZeroAtIrPeak(rew, m) {
    await addIROffsetSeconds(rew, m, unwrap(m.timeOfIRPeakSeconds));
    return true;
  }

  async function setSPLOffsetDB(rew, m, newValue) {
    // check if the value is a number
    if (Number.isNaN(newValue)) {
      throw new TypeError(`Invalid SPL offset: ${newValue}`);
    }
    // round the value to 2 decimal places
    newValue = cleanValue(newValue, 2);

    // Check if the new value is the same as the current value
    if (newValue === splOffsetDeltadBOf(m)) {
      return true;
    }
    log.debug(`Setting SPL offset to ${newValue} dB for ${labelOf(m)}`);

    const bandwidth = await getBandwidth(rew, m);
    // refence level is 75 dB just for the align command
    const referenceLevel = DEFAULT_TARGET_LEVEL;
    // frequency must be in the mid range
    const frequencyHz = bandwidth.centerFrequencyHz;
    const spanOctaves = 0;
    // first align the SPL to get the reference level
    const alignResult = await rew.alignSPL(
      [m.uuid],
      referenceLevel,
      frequencyHz,
      spanOctaves,
    );

    const referenceAlignSPLOffsetdB = getAlignSPLOffsetdBByUUID(alignResult, m.uuid);

    const offset = newValue - referenceAlignSPLOffsetdB;

    // align a second time to get the rigth level
    const finalAlignResult = await rew.alignSPL(
      [m.uuid],
      referenceLevel + offset,
      frequencyHz,
      spanOctaves,
    );
    //check results
    const finalAlignSPLOffsetdB = getAlignSPLOffsetdBByUUID(finalAlignResult, m.uuid);
    if (finalAlignSPLOffsetdB !== newValue) {
      throw new Error(
        `Failed to set SPL offset to ${newValue} dB, current value is ${finalAlignSPLOffsetdB}`,
      );
    }
    m.update({
      alignSPLOffsetdB: finalAlignSPLOffsetdB,
      splOffsetdB: cleanValue(m.initialSplOffsetdB + finalAlignSPLOffsetdB, 2),
    });
    return true;
  }

  async function addSPLOffsetDB(rew, m, amountToAdd) {
    return setSPLOffsetDB(rew, m, splOffsetDeltadBOf(m) + amountToAdd);
  }

  // --- Copies towards the other positions of the same channel ------------------

  async function copyFiltersToOther(rew, m, targets) {
    if (!targets.length) return;

    log.info(`Copying filters to other positions of ${labelOf(m)}...`);
    const measurementFilters = await getFilters(rew, m);
    for (const otherItem of targets) {
      await setFilters(rew, otherItem, measurementFilters);
    }
  }

  async function copySplOffsetDeltadBToOther(rew, m, targets) {
    if (!targets.length) return;

    log.info(`Copying SPL offset to other positions of ${labelOf(m)}...`);
    const splOffset = splOffsetDeltadBOf(m);
    for (const otherItem of targets) {
      await setSPLOffsetDB(rew, otherItem, splOffset);
    }
  }

  async function copyCumulativeIRShiftToOther(rew, m, targets) {
    if (!m.haveImpulseResponse) return;
    if (!targets.length) return;

    log.info(`Copying Cumulative IR Shift to other positions of ${labelOf(m)}...`);
    const irShift = unwrap(m.cumulativeIRShiftSeconds);
    for (const otherItem of targets) {
      await setcumulativeIRShiftSeconds(rew, otherItem, irShift);
    }
  }

  async function copyInversionToOtherPositions(rew, m, targets) {
    if (!targets.length) return;

    const inverted = unwrap(m.inverted);
    log.info(`Copying Inversion to other positions of ${labelOf(m)}...`);
    for (const otherItem of targets) {
      await setInverted(rew, otherItem, inverted);
    }
  }

  // --- Filter measurement / predicted measurement sequences --------------------

  async function generateFilterMeasurement(rew, m, session) {
    // Génère la mesure-filtre du bank courant (REW « Generate filters
    // measurement »). Plus de cache : l'export OCA calcule désormais l'IR en
    // interne, et le seul appelant restant (revert LFE, business-tools) gère
    // la mesure comme un objet temporaire.
    const response = await rew.generateFiltersMeasurement(m.uuid);
    const filter = await session.analyseApiResponse(response);
    filter.isFilter = true;

    if (!filter) {
      throw new Error(`filters reponse failed for ${labelOf(m)}`);
    }

    // add spl residual to filter
    await addSPLOffsetDB(rew, filter, unwrap(m.splresidual));
    const crossover = unwrap(m.crossover);
    const cxText = crossover ? `X@${crossover}Hz` : 'FB';
    await setTitle(rew, filter, `Filter ${unwrap(m.title)} ${cxText}`);
    return filter;
  }

  // --- Reset / filter-creation sequences ----------------------------------------

  async function resetAll(
    rew,
    m,
    { targetLevel = DEFAULT_TARGET_LEVEL, irWindowWidths, equaliserDefaults },
  ) {
    try {
      await resetSmoothing(rew, m);
      await resetIrWindows(rew, m, irWindowWidths);
      await resetTargetSettings(rew, m);
      await resetRoomCurveSettings(rew, m);
      await resetEqualiser(rew, m, equaliserDefaults);
      await resetcumulativeIRShiftSeconds(rew, m);
      await setInverted(rew, m, false);
      await setTargetLevel(rew, m, targetLevel);
      await resetFilters(rew, m);
    } catch (error) {
      throw new Error(`Failed to reset for response ${labelOf(m)}: ${error.message}`, {
        cause: error,
      });
    }
  }

  /**
   * !!! WARNING !!! set IR oversampling to None in the Analysis settings
   *
   * Creates a FIR (Finite Impulse Response) filter from the measurement:
   * smoothing, predicted measurement, amplitude correction, IR windows,
   * phase correction, then convolution of phase and amplitude corrections.
   */
  /**
   * Mesure le profil de référentiel D(f) = brute − courbe de travail (moyennes
   * par octave interpolées) quand une fenêtre MTW/FDW est active : bascule
   * temporairement les fenêtres en pleine longueur, relit la réponse, puis
   * restaure les fenêtres verbatim. Soustraire ce profil à la cible équivaut
   * à « fenêtrer la cible » : le référentiel devient cohérent bande par bande
   * (BF intactes où D≈0, médiums dosés juste, pente de la cible transmise en
   * HF) sans réintroduire les détails que le fenêtrage retire volontairement.
   * Retourne null (aucune compensation) si aucune fenêtre n'est active ou si
   * la lecture échoue — la création de filtre ne doit jamais échouer pour ça.
   */
  async function measurePhaseMatchReferenceProfile(rew, m, ctx, workingResponse) {
    let windows;
    try {
      windows = await rew.getIRWindows(m.uuid);
    } catch {
      return null; // pas de réponse impulsionnelle → pas de fenêtrage possible
    }
    if (!windows || (!windows.addMTW && !windows.addFDW)) {
      return null;
    }

    try {
      await rew.setIRWindows(m.uuid, { ...windows, addMTW: false, addFDW: false });
      const rawResponse = await getFrequencyResponse(rew, m, {
        smoothing: ctx.smoothingMethod,
        ppo: 96,
      });
      return computeReferenceProfile(rawResponse, workingResponse);
    } catch (error) {
      log.warn(
        `${labelOf(m)}: mesure de l'écart de référentiel impossible (${error.message}) — pas de compensation`,
      );
      return null;
    } finally {
      await rew.setIRWindows(m.uuid, windows);
    }
  }

  async function runPhaseMatchFilter(
    rew,
    m,
    ctx,
    customStartFrequency,
    customEndFrequency,
    options = {},
  ) {
    log.debug(
      `[createPhaseMatchFilter] range=${customStartFrequency}-${customEndFrequency} Hz`,
    );

    validatePhaseMatchRange(customStartFrequency, customEndFrequency, labelOf(m));

    const sampleRate = await resolveSampleRate(rew, m);

    const sourceFreqResponse = await getFrequencyResponse(rew, m, {
      smoothing: ctx.smoothingMethod,
      ppo: 96,
    });

    // Compensation de référentiel D(f) (plan qualité audio, phase 1) : les
    // filtres calculés sur une courbe fenêtrée (MTW/FDW) sont appliqués à la
    // mesure brute — sans recalage, le predicted s'écarte de la cible de
    // l'énergie que le fenêtrage retire (mesuré : +1.3 à +2.4 dB sur
    // 300-3000 Hz pour un front large bande). La cible passée au calculateur
    // est abaissée du profil D(f) lissé — l'équivalent de « fenêtrer la
    // cible » ; le target level global REW (Align SPL) reste intact.
    const referenceProfile = await measurePhaseMatchReferenceProfile(
      rew,
      m,
      ctx,
      sourceFreqResponse,
    );

    let targetFreqResponse = await getTargetResponse(rew, m, { ppo: 96 });
    if (referenceProfile) {
      targetFreqResponse = applyTargetProfile(targetFreqResponse, referenceProfile);
      const meanOffset = meanProfileOffset(
        referenceProfile,
        customStartFrequency,
        customEndFrequency,
      );
      const message =
        `[createPhaseMatchFilter] référentiel: courbe de travail en moyenne ` +
        `${meanOffset.toFixed(2)} dB sous la brute sur ` +
        `${Math.round(customStartFrequency)}-${Math.round(customEndFrequency)} Hz — cible recalée du profil D(f)`;
      if (meanOffset > 2.5) {
        log.warn(
          `${message}. Écart élevé : vérifiez la méthode de moyenne ` +
            `(RMS + phase avg. recommandé pour l'EQ) et le fenêtrage.`,
        );
      } else {
        log.info(message);
      }
    }

    const calculator = ctx.createCalculator(
      sampleRate,
      customStartFrequency,
      customEndFrequency,
      options,
    );

    const calculationResult = await calculator.calculate(
      sourceFreqResponse,
      targetFreqResponse,
    );
    if (calculationResult?.report) {
      const { verdict, warnings, filters: filterVerdicts } = calculationResult.report;
      // Un WARN/FAIL peut venir des avertissements globaux OU des verdicts par
      // filtre : journaliser les deux pour que la raison soit toujours visible.
      const details = [...warnings];
      const flaggedFilters = (filterVerdicts ?? []).filter(f => f.verdict !== 'PASS');
      if (flaggedFilters.length > 0) {
        const shown = flaggedFilters
          .slice(0, 4)
          .map(
            f =>
              `${Math.round(f.fc)} Hz ${f.gain > 0 ? '+' : ''}${f.gain.toFixed(1)} dB — ${f.warnings[0] ?? f.verdict}`,
          )
          .join(' ; ');
        details.push(
          `${flaggedFilters.length} filtre(s) signalé(s): ${shown}` +
            (flaggedFilters.length > 4 ? ' …' : ''),
        );
      }
      const reportMessage =
        `[createPhaseMatchFilter] rapport: ${verdict}` +
        (details.length ? ` — ${details.join(' ; ')}` : '');
      if (verdict === 'FAIL') {
        log.warn(reportMessage);
      } else {
        log.info(reportMessage);
      }
    }
    const computedFilters = calculator.filterSet.getActiveFilters();
    if (!computedFilters.length) {
      throw new Error('No filters generated by optimizer');
    }

    // The engine's own pruning uses a fixed 0.1 dB floor; the configured
    // minFilterGain is enforced here so near-zero filters do not waste slots.
    const minFilterGain = Number(calculator.minFilterGain) || 0;
    const activeFilters = computedFilters.filter(
      f => Math.abs(f.gain) >= minFilterGain,
    );
    if (activeFilters.length < computedFilters.length) {
      log.info(
        `[createPhaseMatchFilter] ${computedFilters.length - activeFilters.length} ` +
          `filter(s) below min filter gain ${minFilterGain} dB discarded`,
      );
    }
    log.debug(
      `[createPhaseMatchFilter] ${activeFilters.length} filters: ` +
        activeFilters
          .map(f => `${Math.round(f.fc)}Hz(${f.gain.toFixed(1)}dB)`)
          .join(', '),
    );

    // Non-auto slots are reservations (joint per-sub filters mirrored on the
    // projection, slot-20 all-pass): pack the computed filters into the free
    // slots and write without overwrite, like REW's own match-target does.
    const currentFilters = await getFilters(rew, m);
    const reservedIndices = currentFilters
      .filter(filter => filter.isAuto === false)
      .map(filter => filter.index);
    if (reservedIndices.length > 0) {
      log.debug(
        `[createPhaseMatchFilter] reserved slots preserved: ${reservedIndices.join(', ')}`,
      );
    }
    const reserved = new Set(reservedIndices);
    // Every computed filter fell under the threshold: still write the free
    // slots as empty so a previous run's filters do not linger.
    const filters = activeFilters.length
      ? buildPhaseMatchFilters(activeFilters, reservedIndices)
      : createEmptyFilters().filter(slot => !reserved.has(slot.index));

    await setFilters(rew, m, filters, { overwrite: false });
  }

  async function createFilter(rew, m, ctx, type, useWorkingSettings, copyToOther) {
    if (m.isFilter) {
      throw new Error(`Operation not permitted on a filter ${labelOf(m)}`);
    }

    if (unwrap(m.isSub)) {
      throw new Error(`Operation not permitted on a sub ${labelOf(m)}`);
    }

    let operationError = null;

    // Synchronises the target level across all measurements from a reference measurement.
    if (copyToOther) {
      await ctx.setTargetLevelFromMeasurement();
    }

    // must have only lower band filter to be able to use the high pass filter
    await resetFilters(rew, m);
    await resetTargetSettings(rew, m);
    const fallOff = await detectFallOff(rew, m, { threshold: -6 });

    const customStartFrequency = Math.max(ctx.bounds.lower, fallOff.lowHz);
    const customEndFrequency = Math.min(ctx.bounds.upper, fallOff.highHz);

    try {
      if (useWorkingSettings) {
        await applyWorkingSettings(rew, m, ctx.workingConfig);
      } else {
        await removeWorkingSettings(rew, m, ctx.irWindowWidths);
      }

      if (type === 'phase') {
        await runPhaseMatchFilter(rew, m, ctx, customStartFrequency, customEndFrequency);
      } else {
        throw new Error(`Unknown filter type: ${type}`);
      }

      await checkFilterGain(rew, m);

      if (copyToOther) {
        await copyFiltersToOther(rew, m, ctx.otherTargets(), ctx.session);
      }
    } catch (error) {
      operationError = new Error(`Filter creation failed: ${error.message}`, {
        cause: error,
      });
    } finally {
      operationError = await restoreWorkingSettings(
        rew,
        m,
        ctx.workingConfig,
        useWorkingSettings,
        operationError,
      );
    }

    if (operationError) {
      throw operationError;
    }
  }

  return {
    addIROffsetSeconds,
    addSPLOffsetDB,
    applyWorkingSettings,
    arithmeticADividedByB,
    arithmeticConvolution,
    arithmeticInvertAPhase,
    arithmeticSum,
    checkFilterGain,
    copyCumulativeIRShiftToOther,
    copyFiltersToOther,
    copyInversionToOtherPositions,
    copySplOffsetDeltadBToOther,
    createExcessPhaseCopy,
    createFilter,
    createMinimumPhaseCopy,
    defaultSmoothing,
    detectFallOff,
    generateFilterMeasurement,
    getBandwidth,
    getEqualiser,
    getFilterImpulseResponse,
    getFilters,
    getFreeXFilterIndex,
    getFrequencyResponse,
    getImpulseResponse,
    getCombinedSubsCrossoverFilteredIr,
    getCrossoverFilteredIr,
    getImpulseResponseInfo,
    getPredictedImpulseResponse,
    getPredictedImpulseResponseInfo,
    getTargetLevel,
    getTargetResponse,
    isDefaultEqualiser,
    producePredictedMeasurement,
    removeWorkingSettings,
    resetAll,
    resetcumulativeIRShiftSeconds,
    resetEqualiser,
    resetFilters,
    resetIrWindows,
    resetRoomCurveSettings,
    resetSmoothing,
    resetTargetSettings,
    resolveSampleRate,
    responseCopy,
    restoreWorkingSettings,
    runPhaseMatchFilter,
    setAllFiltersAuto,
    setcumulativeIRShiftSeconds,
    setFilters,
    setInverted,
    setIrWindows,
    setRoomCurveSettings,
    setSingleFilter,
    setSmoothing,
    setSPLOffsetDB,
    setTargetLevel,
    setTargetSettings,
    setTitle,
    setZeroAtIrPeak,
    toggleInversion,
    trimIRToWindows,
  };
}

export { DEFAULT_TARGET_LEVEL, createMeasurementOperations, getAlignSPLOffsetdBByUUID };
