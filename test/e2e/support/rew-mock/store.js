import { decodeBase64ToFloat32 } from '../../../../src/rew/rew-codec.js';
import {
  averageIRs,
  frequencyResponseFromIR,
  levelAround,
  peakIndex,
} from './dsp.js';

const FIXED_DATE = '12 juin 2026 12:00:00';
const DEFAULT_TARGET_SETTINGS = {
  shape: 'Driver',
  lowPassCrossoverHz: 0,
  highPassCrossoverHz: 0,
  bassManagementSlopedBPerOctave: 0,
  bassManagementCutoffHz: 0,
};
const DEFAULT_IR_WINDOWS = {
  leftWindowType: 'Rectangular',
  rightWindowType: 'Rectangular',
  leftWindowWidthms: 125,
  rightWindowWidthms: 500,
  refTimems: 0,
  addFDW: false,
};

/**
 * In-memory REW state. UUIDs and titles are deterministic.
 * Measurements created from impulse imports carry IR-derived fields;
 * measurements created from frequency-response imports do not expose
 * `cumulativeIRShiftSeconds` (the app uses its presence to decide
 * `haveImpulseResponse`).
 */
class RewStore {
  constructor() {
    this.measurements = new Map();
    this.uuidCounter = 0;
    this.application = {
      blocking: false,
      'inhibit-graph-updates': false,
      logging: false,
    };
    this.eq = {
      'default-equaliser': null,
      'default-target-level': 75,
      'house-curve': String.raw`C:\curves\e2e Target.txt`,
      'house-curve-log-interpolation': true,
      'match-target-settings': null,
      'default-target-settings': null,
      'default-room-curve-settings': null,
    };
    this.alignmentTool = {
      mode: 'Impulse',
      frequency: 100,
      'uuid-a': null,
      'uuid-b': null,
      'index-a': null,
      'index-b': null,
      'gain-a': 0,
      'gain-b': 0,
      'delay-b': 0,
      'invert-a': false,
      'invert-b': false,
      'max-positive-delay': 0,
      'max-negative-delay': 0,
      'remove-time-delay': false,
    };
  }

  nextUuid() {
    this.uuidCounter += 1;
    return `e2e-${String(this.uuidCounter).padStart(4, '0')}`;
  }

  /** REW-like list payload: object keyed by 1-based index. */
  list() {
    const out = {};
    let index = 1;
    for (const record of this.measurements.values()) {
      out[index] = this.summary(record);
      index += 1;
    }
    return out;
  }

  summary(record) {
    const base = {
      uuid: record.uuid,
      title: record.title,
      notes: record.notes,
      date: FIXED_DATE,
      sampleRate: record.sampleRate,
      splOffsetdB: record.splOffsetdB,
      alignSPLOffsetdB: record.alignSPLOffsetdB,
      timeOfIRPeakSeconds: record.timeOfIRPeakSeconds,
      inverted: record.inverted,
    };
    if (record.ir) {
      base.cumulativeIRShiftSeconds = record.cumulativeIRShiftSeconds;
      base.clockAdjustmentPPM = 0;
      base.timeOfIRStartSeconds = record.timeOfIRStartSeconds;
    }
    return base;
  }

  get(idOrUuid) {
    if (this.measurements.has(idOrUuid)) return this.measurements.get(idOrUuid);
    // numeric 1-based index fallback (the app always uses UUIDs)
    const records = [...this.measurements.values()];
    const index = Number(idOrUuid);
    if (Number.isInteger(index) && index >= 1 && index <= records.length) {
      return records[index - 1];
    }
    return null;
  }

  delete(uuid) {
    return this.measurements.delete(uuid);
  }

  createRecord(partial) {
    const uuid = this.nextUuid();
    const record = {
      uuid,
      title: partial.title ?? uuid,
      notes: partial.notes ?? '',
      sampleRate: partial.sampleRate ?? 48000,
      splOffsetdB: partial.splOffsetdB ?? 80,
      alignSPLOffsetdB: 0,
      cumulativeIRShiftSeconds: 0,
      timeOfIRStartSeconds: partial.timeOfIRStartSeconds ?? 0,
      timeOfIRPeakSeconds: partial.timeOfIRPeakSeconds ?? 0,
      ir: partial.ir ?? null,
      fr: partial.fr ?? null,
      // REW's Generic EQ exposes a fixed bank of 22 filter slots.
      filters: Array.from({ length: 22 }, (unused, i) => ({
        index: i + 1,
        type: 'None',
        enabled: true,
        isAuto: true,
      })),
      equaliser: this.eq['default-equaliser'] ?? { manufacturer: 'Generic', model: 'Generic' },
      targetSettings: { ...DEFAULT_TARGET_SETTINGS },
      irWindows: { ...DEFAULT_IR_WINDOWS },
      roomCurveSettings: {},
      targetLevel: this.eq['default-target-level'],
      smoothing: 'None',
      inverted: false,
    };
    this.measurements.set(uuid, record);
    return record;
  }

  createFromImpulseImport(payload) {
    const ir = decodeBase64ToFloat32(payload.data);
    const sampleRate = Number(payload.sampleRate) || 48000;
    const startTime = Number(payload.startTime) || 0;
    const peak = peakIndex(ir);
    return this.createRecord({
      title: payload.identifier ?? 'Imported IR',
      sampleRate,
      splOffsetdB: payload.splOffset === undefined ? 80 : Number(payload.splOffset) || 0,
      timeOfIRStartSeconds: startTime,
      timeOfIRPeakSeconds: startTime + peak / sampleRate,
      ir,
    });
  }

  createFromFrequencyImport(payload) {
    const fr = {
      startFreq: Number(payload.startFreq),
      freqStep: payload.freqStep === undefined ? undefined : Number(payload.freqStep),
      ppo: payload.ppo === undefined ? undefined : Number(payload.ppo),
      magnitude: decodeBase64ToFloat32(payload.magnitude),
      phase: decodeBase64ToFloat32(payload.phase),
    };
    return this.createRecord({
      title: payload.identifier ?? 'Imported FR',
      splOffsetdB: 0,
      fr,
    });
  }

  createAverage(uuids, processName) {
    const records = uuids.map(uuid => this.get(uuid)).filter(Boolean);
    if (records.length < 2) {
      throw new Error(`Average needs at least 2 measurements (got ${records.length})`);
    }
    const withIR = records.filter(record => record.ir);
    if (withIR.length !== records.length) {
      throw new Error('Average on FR-only measurements is not supported by the mock');
    }
    const ir = averageIRs(withIR.map(record => record.ir));
    const sampleRate = withIR[0].sampleRate;
    const peak = peakIndex(ir);
    return this.createRecord({
      title: `${processName} ${this.uuidCounter + 1}`,
      sampleRate,
      splOffsetdB: withIR[0].splOffsetdB,
      timeOfIRStartSeconds: withIR[0].timeOfIRStartSeconds,
      timeOfIRPeakSeconds: withIR[0].timeOfIRStartSeconds + peak / sampleRate,
      ir,
    });
  }

  /**
   * Linear-grid frequency response of a record, magnitude in dB SPL
   * (FFT magnitude + current splOffsetdB), cached per record until the
   * record's data-bearing fields change.
   */
  linearResponse(record) {
    if (record.fr) {
      if (record.fr.freqStep === undefined) {
        throw new Error('FR-only measurement with ppo grid: linear ops unsupported');
      }
      // Reflect the applied SPL offset, like the IR branch below — otherwise
      // Align SPL is non-linear on FR-only imports (level frozen while the
      // offset accumulates) and setSPLOffsetDB's consistency check fails.
      const magnitude = new Float32Array(record.fr.magnitude.length);
      for (let i = 0; i < magnitude.length; i++) {
        magnitude[i] = record.fr.magnitude[i] + record.splOffsetdB;
      }
      return {
        startFreq: record.fr.startFreq,
        freqStep: record.fr.freqStep,
        magnitude,
        phase: record.fr.phase,
      };
    }
    if (!record.ir) throw new Error(`Measurement ${record.uuid} has no data`);
    if (!record._frCache) {
      record._frCache = frequencyResponseFromIR(record.ir, record.sampleRate);
    }
    const base = record._frCache;
    const magnitude = new Float32Array(base.magnitude.length);
    const offset = record.splOffsetdB;
    for (let i = 0; i < magnitude.length; i++) magnitude[i] = base.magnitude[i] + offset;
    return { startFreq: base.startFreq, freqStep: base.freqStep, magnitude, phase: base.phase };
  }

  levelAround(record, centerHz, spanOctaves) {
    return levelAround(this.linearResponse(record), centerHz, spanOctaves);
  }
}

export { RewStore };
