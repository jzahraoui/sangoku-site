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

function createHarness({ measurements = [], tc = 'harman', level = 75 } = {}) {
  const state = {
    _tc: tc,
    _level: level,
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
  const service = createTargetCurveService({
    session,
    state,
    lists,
    isMeasurement: value => typeof value === 'object' && value !== null,
  });
  return { service, session, state, lists };
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
});
