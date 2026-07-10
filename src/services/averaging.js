import { UNKNOWN_GROUP_NAME } from '../measurement/measurement-info.js';
import { assertAveragingConsistency, quantize3dB } from '../measurement/measurement-selection.js';
import {
  AVERAGE_SUFFIX,
  isAverageTitle,
  isPredictedTitle,
} from '../measurement/measurement-view.js';

/**
 * Averaging service extracted from MeasurementViewModel
 *.
 *
 * [ORCHESTRATION] service: validates that the measurements are consistent
 * (SPL offsets, polarity) then hands the grouped responses to
 * BusinessTools.processGroupedResponses through the injected bridge.
 * No Knockout, no DOM.
 */

const unwrap = value => (typeof value === 'function' ? value() : value);

const labelOf = m => unwrap(m.displayMeasurementTitle) ?? unwrap(m.title);

// isAverage as a KO getter (boolean) or, for the flat records (ADR 002), the
// pure title predicate — same result for both entries.
const isAverageOf = item =>
  typeof item.isAverage === 'boolean' ? item.isAverage : isAverageTitle(unwrap(item.title));
const isPredictedOf = item =>
  typeof item.isPredicted === 'boolean'
    ? item.isPredicted
    : isPredictedTitle(unwrap(item.title));

/**
 * Create the per-channel averages.
 * - `validMeasurements`: current valid measurements (averages excluded here).
 * - `groupedMeasurements`: { channel: {items, count} } map.
 * - `processGroupedResponses(grouped, method, deleteOriginal)`: BusinessTools bridge.
 */
async function createAverages({
  validMeasurements,
  groupedMeasurements,
  averageMethod,
  deleteOriginal,
  processGroupedResponses,
}) {
  // Snapshot once — reactive computeds would otherwise re-evaluate
  const filteredMeasurements = validMeasurements.filter(
    item => !isAverageOf(item) && item.IRPeakValue <= 1,
  );

  // Prime the per-item derivations once, then validate on plain numbers
  // (logic in src/measurement/measurement-selection.js).
  const snapshots = filteredMeasurements.map(item => ({
    title: labelOf(item),
    alignOffset: unwrap(item.alignSPLOffsetdB),
    quantizedSpl: quantize3dB(unwrap(item.splOffsetdB)),
    inverted: !!unwrap(item.inverted),
  }));

  assertAveragingConsistency(snapshots);

  // creates array of uuid attributes for each code into groupedResponse
  await processGroupedResponses(groupedMeasurements, averageMethod, deleteOriginal);
}

function measurementsToDelete(uuids, deleteOriginal) {
  if (uuids.length < 2) {
    return [];
  }
  switch (deleteOriginal) {
    case 'all':
      return uuids;
    case 'all_but_1':
      return uuids.slice(1);
    case 'none':
    case undefined:
      return [];
    default:
      throw new Error(`Invalid deleteOriginal parameter: ${deleteOriginal}`);
  }
}

/**
 * Decontaminated equivalent of BusinessTools.processGroupedResponses for the
 * operations path (ADR 002): drives REW cross-correlation + averaging over the
 * flat MeasurementRecords, renames the created average through the operations
 * service, and returns true. The Knockout entry keeps BusinessTools until the
 * class is reclassed [MOTEUR].
 *
 * Dependencies: `session` (RewSession: rewMeasurements, analyseApiResponse,
 * removeMeasurements, removeMeasurementUuid) and `operations`
 * (createMeasurementOperations instance).
 */
function createAveragingProcessor({ session, operations }) {
  async function processCodeGroup(code, group, avgMethod, deleteOriginal) {
    // exclude previous results, predictions and out-of-range peaks
    const usableItems = group.items.filter(
      item => !isAverageOf(item) && !isPredictedOf(item) && item.IRPeakValue <= 1,
    );
    const itemsToDelete = group.items.filter(item => !usableItems.includes(item));
    await session.removeMeasurements(itemsToDelete);

    if (usableItems.length < 2) {
      throw new Error(`Need at least 2 measurements to make an average: ${code}`);
    }

    const uuids = usableItems.map(item => item.uuid);
    await session.rewMeasurements.crossCorrAlign(uuids);

    const vectorAverage = await session.analyseApiResponse(
      await session.rewMeasurements.processMeasurements(avgMethod, uuids),
    );
    if (!vectorAverage) {
      throw new Error(`${code}: can not rename the average...`);
    }
    await operations.setTitle(session.rewMeasurements, vectorAverage, code + AVERAGE_SUFFIX);

    return measurementsToDelete(uuids, deleteOriginal);
  }

  async function processGroupedResponses(groupedResponse, avgMethod, deleteOriginal) {
    if (!groupedResponse || typeof groupedResponse !== 'object') {
      throw new Error('Invalid groupedResponse input');
    }
    if (Object.keys(groupedResponse).length < 2) {
      throw new Error('Parameter must contains at least 2 elements');
    }

    const toBeDeletedUuids = [];
    for (const [code, group] of Object.entries(groupedResponse)) {
      if (!group?.items || code === UNKNOWN_GROUP_NAME) continue;
      toBeDeletedUuids.push(
        ...(await processCodeGroup(code, group, avgMethod, deleteOriginal)),
      );
    }

    for (const uuid of toBeDeletedUuids) {
      await session.removeMeasurementUuid(uuid);
    }

    return true;
  }

  return { processGroupedResponses };
}

export { createAverages, createAveragingProcessor };
