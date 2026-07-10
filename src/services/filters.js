/**
 * Speaker filter generation / bulk-apply service extracted from
 * MeasurementViewModel (décontamination lot V5 —
 * docs/reverse/03-vm-decontamination.md).
 *
 * [ORCHESTRATION] service. No Knockout, no DOM — the button shells (locks,
 * error channel, DOM icon toggles) stay in the viewmodel.
 *
 * Construction dependencies:
 * - `config`: accessor object — selectedEqualizationMode (r).
 */

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const unwrap = value => (typeof value === 'function' ? value() : value);

const labelOf = m => unwrap(m.displayMeasurementTitle) ?? unwrap(m.title);

/**
 * Pick the measurements a bulk setting change applies to: the valid ones
 * matching the filter, plus the selected predicted LFE when requested.
 */
function selectMeasurementsForBulkApply({
  validMeasurements,
  predicted,
  filter = () => true,
  includePredicted = false,
}) {
  const selectedMeasurements = validMeasurements.filter(filter);

  if (
    includePredicted &&
    predicted &&
    filter(predicted) &&
    !selectedMeasurements.some(({ uuid }) => uuid === predicted.uuid)
  ) {
    selectedMeasurements.push(predicted);
  }

  return selectedMeasurements;
}

function createFiltersService({ config, log = noopLog }) {
  function createSpeakerFilterForSelectedMode(item) {
    if (config.selectedEqualizationMode === 'rch') {
      return item.createPhaseMatchFilter();
    }
    return item.createStandardFilter();
  }

  /** Generate the filter of every speaker with the selected equalization mode. */
  async function generateSelectedFilters(speakerMeasurements) {
    const filterModeLabel = config.selectedEqualizationMode === 'rch' ? 'RCH' : 'REW';

    for (const item of speakerMeasurements) {
      // display progression in the status
      log.info(`Generating ${filterModeLabel} filter for channel ${unwrap(item.channelName)}`);
      await createSpeakerFilterForSelectedMode(item);
    }

    return filterModeLabel;
  }

  /** Generate the predicted preview of every speaker; stops on the first refusal. */
  async function generatePreviews(speakerMeasurements) {
    for (const item of speakerMeasurements) {
      // display progression in the status
      log.info(`Generating preview for ${labelOf(item)}`);
      const previewCreated = await item.previewMeasurement();
      if (previewCreated === false) return false;
    }
    return true;
  }

  async function invertAll(speakerMeasurements) {
    for (const item of speakerMeasurements) {
      // display progression in the status
      log.info(`Inverting channel ${unwrap(item.channelName)}`);
      await item.toggleInversion();
    }
  }

  async function copyMeasurementCommonAttributes(uniqueMeasurements) {
    console.time('copyMeasurements');

    for (const item of uniqueMeasurements) {
      await item.copyAllToOther();
    }

    console.timeEnd('copyMeasurements');
  }

  return {
    copyMeasurementCommonAttributes,
    createSpeakerFilterForSelectedMode,
    generatePreviews,
    generateSelectedFilters,
    invertAll,
    selectMeasurementsForBulkApply,
  };
}

export { createFiltersService, selectMeasurementsForBulkApply };
