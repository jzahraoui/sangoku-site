/**
 * Method-bearing sub-measurement adapters for the MSO export (lot MSO-A).
 *
 * exports.js `appendMsoMeasurement` drives the measurement through methods
 * (resetAll, getFrequencyResponse, applyWorkingSettings) and reads channelName/
 * position — the KO MeasurementItem interface. The Vue entry holds flat
 * MeasurementRecords (ADR 002), so these adapters wrap a record and route the
 * writes to the operations service and the derivations to measurement-view.
 *
 * [MOTEUR] module: no Knockout, no DOM, no Vue.
 */

function createMsoMeasurement(record, ctx) {
  const {
    operations,
    session,
    descriptor,
    workingSettingsConfig,
    irWindowWidthsFor,
  } = ctx;
  const rew = () => session.rewMeasurements;
  const sessionContext = {
    analyseApiResponse: result => session.analyseApiResponse(result),
    removeMeasurements: items => session.removeMeasurements(items),
    removeMeasurementUuid: uuid => session.removeMeasurementUuid(uuid),
    findMeasurementByUuid: uuid => session.findMeasurementByUuid(uuid),
  };

  return {
    record,
    // read as plain values (appendMsoMeasurement unwraps them)
    channelName: descriptor.channelName,
    position: descriptor.position,
    resetAll: (targetLevel) =>
      operations.resetAll(rew(), record, {
        targetLevel,
        irWindowWidths: irWindowWidthsFor(record),
        equaliserDefaults: session.rewEq?.defaultEqtSettings,
        session: sessionContext,
      }),
    getFrequencyResponse: () => operations.getFrequencyResponse(rew(), record, {}),
    applyWorkingSettings: () =>
      operations.applyWorkingSettings(rew(), record, workingSettingsConfig()),
  };
}

/** Wrap the sub-measurement records as MSO-export adapters. */
function buildMsoMeasurements(records, ctx) {
  return records.map(record =>
    createMsoMeasurement(record, {
      ...ctx,
      descriptor: ctx.derived.byRecord.get(record),
    }),
  );
}

export { buildMsoMeasurements, createMsoMeasurement };
