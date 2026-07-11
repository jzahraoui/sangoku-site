import { DEFAULT_TARGET_LEVEL } from './measurement-operations.js';

/**
 * Target curve / target level service extracted from MeasurementViewModel
 * (décontamination lot V4 — docs/reverse/03-vm-decontamination.md).
 *
 * [ORCHESTRATION] service. No Knockout, no DOM.
 *
 * Construction dependencies:
 * - `session`: the RewSession instance (rewEq, rewMeasurements, measurements
 *   accessor, analyseApiResponse, addMeasurementFromRewOperation,
 *   removeMeasurements).
 * - `state`: accessor object — tcName (r), targetCurve (w),
 *   mainTargetLevel (rw).
 * - `lists`: thunks — firstMeasurement(), validMeasurements(),
 *   predictedLfeMeasurements().
 * - `isMeasurement(value)`: reference-measurement type guard.
 */

const TARGET_PREFIX = 'Target';

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const unwrap = value => (typeof value === 'function' ? value() : value);

function createTargetCurveService({
  session,
  state,
  lists,
  isMeasurement = () => true,
  log = noopLog,
}) {
  /**
   * (Re)create the target-curve measurement in REW when its title no longer
   * matches the active curve + level. Returns false when already up to date.
   */
  async function updateTargetCurve(referenceMeasurement) {
    const title = `${TARGET_PREFIX} ${state.tcName}`;

    const measurements = session.measurements.get();
    if (measurements.some(item => unwrap(item.title) === title)) {
      log.debug(`Current target curve ${title} is valid, skipping creation.`);
      return false;
    }

    log.debug(`Current target curve needs to be updated to ${title}.`);

    await session.removeMeasurements(
      measurements.filter(item => unwrap(item.title).startsWith(TARGET_PREFIX)),
    );

    let targetMeasurement, comments;
    if (referenceMeasurement) {
      const apiResponse = await session.rewMeasurements.generateTargetMeasurement(
        referenceMeasurement.uuid,
      );
      targetMeasurement = await session.analyseApiResponse(apiResponse);
      comments = `from ${unwrap(referenceMeasurement.title)}`;
    } else {
      // api response of generateTargetMeasurement is bugged: uuid returned is not the created measurement's uuid
      targetMeasurement = await session.addMeasurementFromRewOperation(
        () => session.rewEq.generateTargetMeasurement(),
        { operationLabel: 'target measurement generation' },
      );
      comments = 'no reference measurement';
    }
    await targetMeasurement.setTitle(title, comments);

    log.info(`Created target curve: ${title}`);
    return true;
  }

  /**
   * Synchronises the target level across all measurements from a reference
   * measurement (see the viewmodel doc-comment history for the full flow).
   * Returns the new target level in dB, or undefined when nothing changed.
   * The processing lock is the caller's concern.
   */
  async function setTargetLevelFromMeasurement(measurement) {
    if (!measurement || !isMeasurement(measurement)) {
      // use first measurement as default
      measurement = lists.firstMeasurement();
      if (!measurement) {
        log.warn('No measurements available to set target level from');
      }
    }
    log.debug(`Setting target level from measurement: ${unwrap(measurement?.title)}`);
    const targetLevel = measurement
      ? await measurement.getTargetLevel()
      : await session.rewEq.getDefaultTargetLevel();
    const newValue = targetLevel || DEFAULT_TARGET_LEVEL;

    const currentTc = await session.rewEq.getTargetCurveName();
    if (currentTc === 'None') {
      log.warn('No target curve set in REW, please set a target curve first');
    }

    const previousTcName = state.tcName;
    state.targetCurve = currentTc;

    // check if target curve or target level changed, if not, skip
    // tcName after setting targetCurve has the new curve name + old level
    if (state.tcName === previousTcName && newValue === state.mainTargetLevel) {
      // sometimes target not exist, this creates it
      await updateTargetCurve(measurement);
      return;
    }

    // update target level
    state.mainTargetLevel = newValue;

    log.info(`Current target curve: ${state.tcName}`);

    // update all measurements target level
    const targets = lists.validMeasurements();
    for (const otherItem of targets) {
      // Filters will be deleted if target level is changed
      log.info(`Updating target level for measurement: ${unwrap(otherItem.title)}`);
      await otherItem.setTargetLevel(newValue);
    }

    // set default target level for future measurements
    await session.rewEq.setDefaultTargetLevel(newValue);

    //delete previous LFE predicted measurements
    await session.removeMeasurements(lists.predictedLfeMeasurements());
    // if main target level change, we need to update target curve measurement
    const updated = await updateTargetCurve(lists.firstMeasurement());
    if (!updated) {
      log.warn(`Target curve update failed`);
    }

    return newValue;
  }

  return {
    setTargetLevelFromMeasurement,
    updateTargetCurve,
  };
}

export { createTargetCurveService };
