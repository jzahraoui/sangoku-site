import { cleanFloat32Value } from './measurement-calculations.js';

// API fields applied verbatim by update(partial). `sampleRate`,
// `cumulativeIRShiftSeconds` and `isFilter` have dedicated handling below.
const API_UPDATE_FIELDS = [
  'title',
  'inverted',
  'splOffsetdB',
  'alignSPLOffsetdB',
  'timeOfIRPeakSeconds',
  // not an API field: written by the alignment service
  'shiftDelay',
  'notes',
  'date',
  'startFreq',
  'endFreq',
  'rewVersion',
  'clockAdjustmentPPM',
  'timeOfIRStartSeconds',
];

// Flat fields owned by the record but absent from the KO observables of the
// MeasurementItem adapter — exposed there as instance accessors.
const PLAIN_FIELDS = [
  'uuid',
  'notes',
  'date',
  'startFreq',
  'endFreq',
  'rewVersion',
  'sampleRate',
  'clockAdjustmentPPM',
  'timeOfIRStartSeconds',
  'haveImpulseResponse',
  'isFilter',
  'IRPeakValue',
  'revertLfeFrequency',
  'isSubOperationResult',
  'parentAttr',
  'initialSplOffsetdB',
  'jointGainDb',
];

// Fields mirrored as KO observables by the MeasurementItem adapter (and as
// by a future reactive UI layer).
const OBSERVABLE_FIELDS = [
  'title',
  'inverted',
  'splOffsetdB',
  'alignSPLOffsetdB',
  'cumulativeIRShiftSeconds',
  'timeOfIRPeakSeconds',
  'shiftDelay',
];

/**
 * ADR 002 — flat mutable record holding the REW/application state of a
 * measurement, with a minimal home-made event emitter. Derivations live in
 * measurement-info.js / measurement-calculations.js; orchestration lives in
 * src/services/measurement-operations.js.
 */
class MeasurementRecord {
  static PLAIN_FIELDS = PLAIN_FIELDS;
  static OBSERVABLE_FIELDS = OBSERVABLE_FIELDS;

  #listeners = new Map();

  constructor(item = {}, { onInvalidNumber = null } = {}) {
    // identity & REW state
    this.uuid = item.uuid;
    this.title = item.title;
    this.notes = item.notes;
    this.date = item.date;
    this.startFreq = item.startFreq;
    this.endFreq = item.endFreq;
    this.inverted = item.inverted;
    this.rewVersion = item.rewVersion;
    this.sampleRate = Number.isFinite(item.sampleRate) ? item.sampleRate : null;
    this.splOffsetdB = item.splOffsetdB;
    this.alignSPLOffsetdB = item.alignSPLOffsetdB;
    this.cumulativeIRShiftSeconds = item.cumulativeIRShiftSeconds;
    this.clockAdjustmentPPM = item.clockAdjustmentPPM;
    this.timeOfIRStartSeconds = item.timeOfIRStartSeconds;
    this.timeOfIRPeakSeconds = item.timeOfIRPeakSeconds;
    this.haveImpulseResponse = Object.hasOwn(item, 'cumulativeIRShiftSeconds');
    this.isFilter = item.isFilter || false;

    // application state (non-REW)
    this.IRPeakValue = item.IRPeakValue || 0;
    this.revertLfeFrequency = item.revertLfeFrequency || 0;
    this.isSubOperationResult = item.isSubOperationResult || false;
    this.parentAttr = item.parentAttr || null;
    this.shiftDelay = item.shiftDelay || Infinity;
    // Gain trim applied by the joint sub optimizer (its own contribution to
    // the SPL offset): the next run's preamble reverts exactly this amount,
    // leaving the user's manual +/- level adjustments untouched.
    this.jointGainDb = item.jointGainDb || 0;

    // store value on object creation and make it immuable
    this.initialSplOffsetdB = cleanFloat32Value(
      item.initialSplOffsetdB ?? item.splOffsetdB - item.alignSPLOffsetdB,
      2,
      onInvalidNumber,
    );
  }

  on(event, handler) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    this.#listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.#listeners.get(event)?.delete(handler);
  }

  #emit(event, payload) {
    const handlers = this.#listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(payload, this);
    }
  }

  /**
   * Applies an API delta (whitelist semantics of the historical
   * MeasurementItem.updateFromApi) and emits 'change' with the fields that
   * actually changed. Returns the changed-fields object.
   */
  update(partial) {
    if (!partial) {
      return {};
    }

    const changed = {};
    // Tiny float deltas are polling echoes of our own writes, not changes:
    // emitting them would re-mark the virtual subwoofers dirty after every
    // alignment. Time-of-IR fields tolerate up to half a sample at 48 kHz —
    // a fractional offsetTZero makes REW re-interpolate the IR and recompute
    // its peak a few µs away from the mirrored local value (measured 4.4 µs);
    // other numeric fields only differ by our 1e-10 rounding. The echoed API
    // value is adopted silently so the record stays exact.
    const echoToleranceOf = field =>
      field === 'timeOfIRPeakSeconds' || field === 'timeOfIRStartSeconds'
        ? 1e-5
        : 1e-9;
    const isFloatEcho = (a, b, tolerance) =>
      typeof a === 'number' &&
      typeof b === 'number' &&
      Number.isFinite(a) &&
      Number.isFinite(b) &&
      Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
    const apply = (field, value) => {
      if (value === undefined || this[field] === value) return;
      if (isFloatEcho(this[field], value, echoToleranceOf(field))) {
        this[field] = value;
        return;
      }
      this[field] = value;
      changed[field] = value;
    };

    for (const field of API_UPDATE_FIELDS) {
      if (Object.hasOwn(partial, field)) apply(field, partial[field]);
    }

    if (Object.hasOwn(partial, 'sampleRate') && Number.isFinite(partial.sampleRate)) {
      apply('sampleRate', partial.sampleRate);
    }
    if (Object.hasOwn(partial, 'cumulativeIRShiftSeconds')) {
      apply('cumulativeIRShiftSeconds', partial.cumulativeIRShiftSeconds);
      apply('haveImpulseResponse', true);
    }
    if (Object.hasOwn(partial, 'isFilter')) {
      apply('isFilter', partial.isFilter || false);
    }

    if (Object.keys(changed).length > 0) {
      this.#emit('change', changed);
    }

    return changed;
  }

  toJSON() {
    return {
      title: this.title,
      notes: this.notes,
      date: this.date,
      uuid: this.uuid,
      startFreq: this.startFreq,
      endFreq: this.endFreq,
      inverted: this.inverted,
      rewVersion: this.rewVersion,
      sampleRate: this.sampleRate,
      splOffsetdB: this.splOffsetdB,
      alignSPLOffsetdB: this.alignSPLOffsetdB,
      cumulativeIRShiftSeconds: this.cumulativeIRShiftSeconds,
      clockAdjustmentPPM: this.clockAdjustmentPPM,
      timeOfIRStartSeconds: this.timeOfIRStartSeconds,
      timeOfIRPeakSeconds: this.timeOfIRPeakSeconds,
      initialSplOffsetdB: this.initialSplOffsetdB,
      isFilter: this.isFilter,
      haveImpulseResponse: this.haveImpulseResponse,
      IRPeakValue: this.IRPeakValue,
      revertLfeFrequency: this.revertLfeFrequency,
      isSubOperationResult: this.isSubOperationResult,
      parentAttr: this.parentAttr,
      shiftDelay: this.shiftDelay,
      jointGainDb: this.jointGainDb,
    };
  }

  /**
   * No-op teardown. Unlike the Knockout MeasurementItem (which disposes its
   * computed observables), the flat record has nothing to release; the method
   * exists so the shared persistence service can call `item.dispose()` on both.
   */
  dispose() {}
}

export default MeasurementRecord;
export { MeasurementRecord };
