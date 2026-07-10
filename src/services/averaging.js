import { assertAveragingConsistency, quantize3dB } from '../measurement/measurement-selection.js';

/**
 * Averaging service extracted from MeasurementViewModel
 * (décontamination lot V4 — docs/reverse/03-vm-decontamination.md).
 *
 * [ORCHESTRATION] service: validates that the measurements are consistent
 * (SPL offsets, polarity) then hands the grouped responses to
 * BusinessTools.processGroupedResponses through the injected bridge.
 * No Knockout, no DOM.
 */

const unwrap = value => (typeof value === 'function' ? value() : value);

const labelOf = m => unwrap(m.displayMeasurementTitle) ?? unwrap(m.title);

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
    item => !item.isAverage && item.IRPeakValue <= 1,
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

export { createAverages };
