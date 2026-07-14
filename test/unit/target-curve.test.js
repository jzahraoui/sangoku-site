import { describe, expect, it, vi } from 'vitest';
import { createTargetCurveService } from '../../src/services/target-curve.js';

function measurement(title, extras = {}) {
  return {
    uuid: `uuid-${title}`,
    title: () => title,
    setTitle: vi.fn().mockResolvedValue(true),
    getTargetLevel: vi.fn().mockResolvedValue(75),
    setTargetLevel: vi.fn().mockResolvedValue(true),
    ...extras,
  };
}

function createHarness({
  measurements = [],
  tc = 'harman',
  level = 75,
  roomCurve = '',
} = {}) {
  const state = {
    _tc: tc,
    _level: level,
    _roomCurve: roomCurve,
    // Miroir du computed tcName du viewmodel : house curve 'None' → '' ;
    // fallback 'flat' quand ni house curve ni room curve.
    get tcName() {
      const curve = this._tc === 'None' ? '' : this._tc;
      const name = [curve, this._roomCurve].filter(Boolean).join(' - ') || 'flat';
      return `${name} ${this._level}dB`;
    },
    set targetCurve(value) {
      this._tc = value;
    },
    get mainTargetLevel() {
      return this._level;
    },
    set mainTargetLevel(value) {
      this._level = value;
    },
  };
  const session = {
    measurements: { get: () => measurements },
    removeMeasurements: vi.fn().mockResolvedValue(true),
    analyseApiResponse: vi.fn(),
    addMeasurementFromRewOperation: vi.fn(),
    rewMeasurements: { generateTargetMeasurement: vi.fn().mockResolvedValue({}) },
    rewEq: {
      getTargetCurveName: vi.fn().mockResolvedValue(tc),
      getDefaultTargetLevel: vi.fn().mockResolvedValue(75),
      setDefaultTargetLevel: vi.fn().mockResolvedValue(undefined),
      generateTargetMeasurement: vi.fn().mockResolvedValue({}),
    },
  };
  const lists = {
    firstMeasurement: vi.fn(() => measurements[0]),
    validMeasurements: vi.fn(() => measurements),
    predictedLfeMeasurements: vi.fn(() => []),
  };
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const service = createTargetCurveService({
    session,
    state,
    lists,
    isMeasurement: value => typeof value === 'object' && value !== null,
    log,
  });
  return { service, session, state, lists, log };
}

describe('updateTargetCurve', () => {
  it('skips creation when the target curve measurement already exists', async () => {
    const { service, session } = createHarness({
      measurements: [measurement('Target harman 75dB')],
    });

    await expect(service.updateTargetCurve()).resolves.toBe(false);
    expect(session.removeMeasurements).not.toHaveBeenCalled();
  });

  it('replaces stale Target measurements from a reference measurement', async () => {
    const stale = measurement('Target old 70dB');
    const reference = measurement('FL_P01');
    const created = measurement('generated');
    const { service, session } = createHarness({ measurements: [stale, reference] });
    session.analyseApiResponse.mockResolvedValue(created);

    await expect(service.updateTargetCurve(reference)).resolves.toBe(true);

    expect(session.removeMeasurements).toHaveBeenCalledWith([stale]);
    expect(session.rewMeasurements.generateTargetMeasurement).toHaveBeenCalledWith(
      reference.uuid,
    );
    expect(created.setTitle).toHaveBeenCalledWith('Target harman 75dB', 'from FL_P01');
  });

  it('generates from the REW EQ default without a reference measurement', async () => {
    const created = measurement('generated');
    const { service, session } = createHarness({ measurements: [] });
    session.addMeasurementFromRewOperation.mockResolvedValue(created);

    await expect(service.updateTargetCurve()).resolves.toBe(true);

    expect(session.addMeasurementFromRewOperation).toHaveBeenCalledWith(
      expect.any(Function),
      { operationLabel: 'target measurement generation' },
    );
    expect(created.setTitle).toHaveBeenCalledWith(
      'Target harman 75dB',
      'no reference measurement',
    );
  });
});

describe('measurementOps injection', () => {
  it('routes title/level writes through the injected bridge, not item methods', async () => {
    const reference = measurement('FL_P01', {
      getTargetLevel: vi.fn().mockResolvedValue(72),
    });
    const other = measurement('C_P01');
    const created = measurement('generated');
    const { session } = createHarness({ measurements: [reference, other] });
    session.analyseApiResponse.mockResolvedValue(created);

    const measurementOps = {
      setTitle: vi.fn().mockResolvedValue(true),
      getTargetLevel: vi.fn().mockResolvedValue(72),
      setTargetLevel: vi.fn().mockResolvedValue(true),
    };
    // rebuild the service with the bridge (createHarness uses the defaults)
    const bridged = createTargetCurveService({
      session,
      state: {
        _tc: 'harman',
        _level: 75,
        get tcName() {
          return `${this._tc} ${this._level}dB`;
        },
        set targetCurve(value) {
          this._tc = value;
        },
        get mainTargetLevel() {
          return this._level;
        },
        set mainTargetLevel(value) {
          this._level = value;
        },
      },
      lists: {
        firstMeasurement: () => reference,
        validMeasurements: () => [reference, other],
        predictedLfeMeasurements: () => [],
      },
      isMeasurement: value => typeof value === 'object' && value !== null,
      measurementOps,
    });

    await bridged.setTargetLevelFromMeasurement(reference);

    // the bridge is used with (measurement, …) — the item methods stay untouched
    expect(measurementOps.getTargetLevel).toHaveBeenCalledWith(reference);
    expect(measurementOps.setTargetLevel).toHaveBeenCalledWith(reference, 72);
    expect(measurementOps.setTargetLevel).toHaveBeenCalledWith(other, 72);
    expect(measurementOps.setTitle).toHaveBeenCalledWith(
      created,
      'Target harman 72dB',
      'from FL_P01',
    );
    expect(reference.getTargetLevel).not.toHaveBeenCalled();
    expect(reference.setTargetLevel).not.toHaveBeenCalled();
    expect(created.setTitle).not.toHaveBeenCalled();
  });
});

describe('setTargetLevelFromMeasurement', () => {
  it('only refreshes the target curve when nothing changed', async () => {
    const reference = measurement('FL_P01');
    const existingTarget = measurement('Target harman 75dB');
    const { service, session } = createHarness({
      measurements: [reference, existingTarget],
    });

    await expect(service.setTargetLevelFromMeasurement(reference)).resolves.toBeUndefined();

    expect(reference.setTargetLevel).not.toHaveBeenCalled();
    expect(session.rewEq.setDefaultTargetLevel).not.toHaveBeenCalled();
  });

  it('propagates a new target level to every valid measurement', async () => {
    const reference = measurement('FL_P01', {
      getTargetLevel: vi.fn().mockResolvedValue(72),
    });
    const other = measurement('C_P01');
    const created = measurement('generated');
    const { service, session, state, lists } = createHarness({
      measurements: [reference, other],
    });
    session.analyseApiResponse.mockResolvedValue(created);

    await expect(service.setTargetLevelFromMeasurement(reference)).resolves.toBe(72);

    expect(state.mainTargetLevel).toBe(72);
    expect(reference.setTargetLevel).toHaveBeenCalledWith(72);
    expect(other.setTargetLevel).toHaveBeenCalledWith(72);
    expect(session.rewEq.setDefaultTargetLevel).toHaveBeenCalledWith(72);
    expect(lists.predictedLfeMeasurements).toHaveBeenCalled();
    expect(created.setTitle).toHaveBeenCalledWith('Target harman 72dB', 'from FL_P01');
  });

  it('falls back to the first measurement when the reference is not a measurement', async () => {
    const first = measurement('FL_P01');
    const existingTarget = measurement('Target harman 75dB');
    const { service, lists } = createHarness({
      measurements: [first, existingTarget],
    });

    await service.setTargetLevelFromMeasurement('not-a-measurement');

    expect(lists.firstMeasurement).toHaveBeenCalled();
    expect(first.getTargetLevel).toHaveBeenCalled();
  });

  it('warns only when the effective target is flat (no house curve, no room curve)', async () => {
    const first = measurement('FL_P01');
    const flatTarget = measurement('Target flat 75dB');
    const { service, session, log } = createHarness({
      measurements: [first, flatTarget],
      tc: 'None',
    });
    session.rewEq.getTargetCurveName.mockResolvedValue('None');

    await service.setTargetLevelFromMeasurement(first);

    expect(log.warn).toHaveBeenCalledWith(
      'No target curve set in REW, please set a target curve first',
    );
  });

  it('stays silent without a house curve when a room curve shapes the target', async () => {
    // Cas du log de prod 1.2.55 : house curve REW absente mais room curve
    // harman active — la cible n'est pas plate, avertir serait du bruit.
    const first = measurement('FL_P01');
    const target = measurement('Target harman 75dB');
    const { service, session, log } = createHarness({
      measurements: [first, target],
      tc: 'None',
      roomCurve: 'harman',
    });
    session.rewEq.getTargetCurveName.mockResolvedValue('None');

    await service.setTargetLevelFromMeasurement(first);

    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs a clear debug on an empty session instead of a warning', async () => {
    const { service, session, log } = createHarness({ measurements: [] });
    session.addMeasurementFromRewOperation.mockResolvedValue(
      measurement('generated'),
    );

    await service.setTargetLevelFromMeasurement(null);

    expect(session.rewEq.getDefaultTargetLevel).toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalledWith(
      'No measurements available to set target level from',
    );
    expect(log.debug).toHaveBeenCalledWith(
      'No measurements yet: taking the REW default target level',
    );
  });
});
