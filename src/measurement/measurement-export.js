import { cleanFloat32Value, secondsToMeters } from './measurement-calculations.js';
import {
  AVR_MAX_GAIN,
  distanceSeverity,
  speakerTypeFor,
  splForAvr,
  splIsAboveLimit,
} from './measurement-info.js';

/**
 * Export-facing measurement derivations (lot Finalization). Pure counterparts
 * of the MeasurementItem computeds the OCA/settings exports consume
 * (distanceInMeters, splForAvr, crossover, speakerType, …). [MOTEUR] module —
 * reads flat MeasurementRecord fields + AVR/global context, no Knockout/DOM.
 *
 * The values mirror MeasurementItem exactly (statics reproduced below).
 */

const DEFAULT_SPEED_OF_SOUND = 343; // m/s, MeasurementItem fallback
const DEFAULT_CROSSOVER = 80; // MeasurementItem.DEFAULT_CROSSOVER_VALUE
const DEFAULT_SHIFT_IN_METERS = 3; // MeasurementViewModel.DEFAULT_SHIFT_IN_METERS
const MODEL_DISTANCE_LIMIT = 6; // MeasurementItem.MODEL_DISTANCE_LIMIT
const MODEL_DISTANCE_CRITICAL_LIMIT = 7.35; // MeasurementItem.MODEL_DISTANCE_CRITICAL_LIMIT

const num = value => (Number.isFinite(value) ? value : 0);

/** timeOfIRPeakSeconds + cumulativeIRShiftSeconds, 0 without an impulse. */
function absoluteIRPeakSeconds(record) {
  return record.haveImpulseResponse
    ? num(record.timeOfIRPeakSeconds) + num(record.cumulativeIRShiftSeconds)
    : 0;
}

/**
 * Global shift applied to every distance: 3 m when the closest raw IR peak is
 * under 1 m (parity with MeasurementViewModel.shiftInMeters), else 0.
 */
function shiftInMeters(selectedRecords, speedOfSound = DEFAULT_SPEED_OF_SOUND) {
  const distances = selectedRecords.map(record =>
    secondsToMeters(absoluteIRPeakSeconds(record), speedOfSound),
  );
  if (!distances.length) {
    return DEFAULT_SHIFT_IN_METERS;
  }
  return Math.min(...distances) < 1 ? DEFAULT_SHIFT_IN_METERS : 0;
}

function distanceInMeters(
  record,
  { speedOfSound = DEFAULT_SPEED_OF_SOUND, shift = 0 } = {},
) {
  if (!record.haveImpulseResponse) {
    return 0;
  }
  return secondsToMeters(num(record.cumulativeIRShiftSeconds), speedOfSound) + shift;
}

function splOffsetDeltadB(record) {
  return cleanFloat32Value(num(record.splOffsetdB) - num(record.initialSplOffsetdB), 2);
}

function splForAvrOf(record) {
  return splForAvr(splOffsetDeltadB(record));
}

function splIsAboveLimitOf(record) {
  return splIsAboveLimit(splForAvrOf(record), AVR_MAX_GAIN);
}

/**
 * Group crossover: 0 for subs, else the per-group value (editable later by the
 * MeasurementsTable) or the AVR default. `descriptor` is a measurement-view
 * descriptor (isSub + channelDetails).
 */
function crossoverOf(
  descriptor,
  { crossoverByGroup = {}, defaultCrossover = DEFAULT_CROSSOVER } = {},
) {
  if (descriptor.isSub) {
    return 0;
  }
  const group = descriptor.channelDetails?.group;
  return crossoverByGroup[group] ?? defaultCrossover;
}

function speakerTypeOf(descriptor, crossover) {
  return speakerTypeFor(descriptor.isSub, crossover);
}

/**
 * List-level distance context (parity with the viewmodel): the global shift and
 * the min/warning/error distances derived from the selected measurements.
 */
function distanceContext(selectedRecords, speedOfSound = DEFAULT_SPEED_OF_SOUND) {
  const shift = shiftInMeters(selectedRecords, speedOfSound);
  const distances = selectedRecords.map(record =>
    distanceInMeters(record, { speedOfSound, shift }),
  );
  const minDistanceInMeters = distances.length ? Math.min(...distances) : 0;
  return {
    shift,
    minDistanceInMeters,
    maxDistanceWarning: cleanFloat32Value(minDistanceInMeters + MODEL_DISTANCE_LIMIT, 2),
    maxDistanceError: cleanFloat32Value(
      minDistanceInMeters + MODEL_DISTANCE_CRITICAL_LIMIT,
      2,
    ),
  };
}

function exceedsDistance(distance, { maxDistanceWarning, maxDistanceError }) {
  return distanceSeverity(distance, maxDistanceWarning, maxDistanceError);
}

/**
 * Headroom before the critical distance limit (parity with
 * MeasurementViewModel.distanceLeftBeforeError): maxDistanceError - the farthest
 * measurement, clamped at 0. Consumed by the MultiSubOptimizer config.
 */
function distanceLeftBeforeError(selectedRecords, speedOfSound = DEFAULT_SPEED_OF_SOUND) {
  const context = distanceContext(selectedRecords, speedOfSound);
  const distances = selectedRecords.map(record =>
    distanceInMeters(record, { speedOfSound, shift: context.shift }),
  );
  const maxDistance = distances.length ? Math.max(...distances) : 0;
  const left = context.maxDistanceError - maxDistance;
  return left > 0 ? cleanFloat32Value(left, 2) : 0;
}

export {
  DEFAULT_CROSSOVER,
  DEFAULT_SHIFT_IN_METERS,
  DEFAULT_SPEED_OF_SOUND,
  MODEL_DISTANCE_CRITICAL_LIMIT,
  MODEL_DISTANCE_LIMIT,
  absoluteIRPeakSeconds,
  crossoverOf,
  distanceContext,
  distanceInMeters,
  distanceLeftBeforeError,
  exceedsDistance,
  shiftInMeters,
  speakerTypeOf,
  splForAvrOf,
  splIsAboveLimitOf,
  splOffsetDeltadB,
};
