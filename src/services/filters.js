/**
 * Speaker filter generation / bulk-apply service extracted from
 * MeasurementViewModel.
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

function createFiltersService({
  config,
  // operations path (ADR 002): route filter creation to createMeasurementOperations over
  // the flat records. When `operations` is absent the item methods are used
  // (Knockout path — unchanged), so the viewmodel + filters-service.test stay green.
  operations = null,
  session = null,
  rewEqFor = () => session?.rewEq,
  workingSettingsConfig = () => undefined,
  irWindowWidthsFor = () => undefined,
  boundsFor = () => undefined,
  boostsFor = () => undefined,
  setTargetLevelFromMeasurement = () => {},
  getOtherPositionMeasurements = () => [],
  // One-speaker preview. Default calls the item's own method (KO path);
  // record-based callers inject createMeasurementPreview + copyFiltersToOther.
  previewOne = item => item.previewMeasurement(),
  log = noopLog,
}) {
  const rew = () => session?.rewMeasurements;
  const sessionContext =
    operations && session
      ? {
          analyseApiResponse: result => session.analyseApiResponse(result),
          removeMeasurements: items => session.removeMeasurements(items),
          removeMeasurementUuid: uuid => session.removeMeasurementUuid(uuid),
          findMeasurementByUuid: uuid => session.findMeasurementByUuid(uuid),
        }
      : null;

  // Mirror of MeasurementItem.filterCreationContext for the operations path.
  function buildFilterContext(m) {
    return {
      session: sessionContext,
      rewEq: rewEqFor(),
      workingConfig: workingSettingsConfig(m),
      irWindowWidths: irWindowWidthsFor(m),
      bounds: boundsFor(),
      boosts: boostsFor(),
      setTargetLevelFromMeasurement: () => setTargetLevelFromMeasurement(m),
      otherTargets: () => getOtherPositionMeasurements(m),
      createCalculator: () => {
        throw new Error('phase-match calculator (rch mode) is not wired on the operations path');
      },
    };
  }

  function createSpeakerFilterForSelectedMode(item) {
    const isRch = config.selectedEqualizationMode === 'rch';
    if (!operations) {
      return isRch ? item.createPhaseMatchFilter() : item.createStandardFilter();
    }
    if (isRch) {
      throw new Error('rch (phase-match) filter mode is not wired on the operations path');
    }
    // Parity with item.createStandardFilter(useWorkingSettings=true, copyToOther=true).
    return operations.createFilter(
      rew(),
      item,
      buildFilterContext(item),
      'standard',
      true,
      true,
    );
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
      const previewCreated = await previewOne(item);
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
    previewMeasurement: previewOne,
    selectMeasurementsForBulkApply,
  };
}

export { createFiltersService, selectMeasurementsForBulkApply };
