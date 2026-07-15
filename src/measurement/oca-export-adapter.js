import {
  crossoverOf,
  distanceContext,
  distanceInMeters,
  exceedsDistance,
  speakerTypeOf,
  splForAvrOf,
  splIsAboveLimitOf,
} from './measurement-export.js';

/**
 * Method-bearing measurement adapters for the OCA export (lot Finalization-2).
 *
 * `oca-file.js` is a golden-master [MOTEUR] generator that consumes measurement
 * *objects* with methods (getFilters, isSub(), crossover(), …) —
 * it must not be rewritten. Record-based callers hold flat MeasurementRecords
 * (ADR 002), so these adapters wrap a record and expose the exact interface
 * createOCAFile expects: derived getters route to measurement-export.js, write
 * methods route to the operations service. This is the "measurement model"
 * limited to the export surface (the option-C service refactor cannot apply to
 * a generator we cannot modify).
 *
 * [MOTEUR] module: no Knockout, no DOM, no UI framework.
 */


/**
 * Main measurement adapter passed to OCAFile.createOCAFile. Derived getters use
 * the record + AVR/global context computed once for the batch; the filter
 * generation routes to the operations service.
 */
function createOcaMeasurement(record, ctx) {
  const {
    operations,
    session,
    descriptor,
    distanceCtx,
    crossoverByGroup,
    defaultCrossover,
    speedOfSound,
    index,
  } = ctx;
  const rew = () => session.rewMeasurements;
  const crossover = crossoverOf(descriptor, { crossoverByGroup, defaultCrossover });
  const distance = distanceInMeters(record, { speedOfSound, shift: distanceCtx.shift });

  return {
    record,
    get haveImpulseResponse() {
      return record.haveImpulseResponse;
    },
    isSub: () => descriptor.isSub,
    inverted: () => record.inverted,
    channelName: () => descriptor.channelName,
    channelDetails: () => descriptor.channelDetails,
    speakerType: () => speakerTypeOf(descriptor, crossover),
    crossover: () => crossover,
    distanceInMeters: () => distance,
    splForAvr: () => splForAvrOf(record),
    splIsAboveLimit: () => splIsAboveLimitOf(record),
    exceedsDistance: () => exceedsDistance(distance, distanceCtx),
    displayMeasurementTitle: () => `${index}: ${record.title}`,
    getFilters: () => operations.getFilters(rew(), record),
  };
}

/**
 * Wrap the selected measurement records as OCA-export adapters. `derived` is a
 * deriveMeasurements() result (byRecord descriptors); the distance context is
 * computed once over the batch (parity with the viewmodel's shift/min-distance).
 */
function buildOcaMeasurements(
  records,
  {
    operations,
    session,
    derived,
    crossoverByGroup = {},
    defaultCrossover,
    speedOfSound = 343,
  },
) {
  // Depuis que le BW12 électrique est cuit dans la FIR de chaque enceinte
  // bass-managée (oca-file.js), un crossover par défaut silencieux serait
  // destructif : il mettrait en passe-haut permanent des canaux configurés
  // Large — irrécupérable depuis le menu de l'AVR. Chaque groupe non-sub doit
  // être couvert par crossoverByGroup (0 = Large) ou par un defaultCrossover
  // EXPLICITE.
  if (defaultCrossover === undefined) {
    const missingGroups = [
      ...new Set(
        records
          .map(record => derived.byRecord.get(record))
          .filter(descriptor => descriptor && !descriptor.isSub)
          .map(descriptor => descriptor.channelDetails?.group)
          .filter(group => crossoverByGroup[group] === undefined),
      ),
    ];
    if (missingGroups.length) {
      throw new Error(
        `No crossover provided for group(s) ${missingGroups.join(', ')}: the ` +
          `electrical BW12 is baked into every bass-managed speaker FIR — pass ` +
          `crossoverByGroup (0 = Large) or an explicit defaultCrossover`,
      );
    }
  }
  const distanceCtx = distanceContext(records, speedOfSound);
  return records.map((record, position) =>
    createOcaMeasurement(record, {
      operations,
      session,
      descriptor: derived.byRecord.get(record),
      distanceCtx,
      crossoverByGroup,
      defaultCrossover,
      speedOfSound,
      index: position + 1,
    }),
  );
}

export { buildOcaMeasurements, createOcaMeasurement };
