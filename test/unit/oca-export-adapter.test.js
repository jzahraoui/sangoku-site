import { describe, expect, it, vi } from 'vitest';
import { buildOcaMeasurements } from '../../src/measurement/oca-export-adapter.js';

function harness() {
  const rewMeasurements = { id: 'rew' };
  const session = {
    rewMeasurements,
    analyseApiResponse: vi.fn(),
    removeMeasurements: vi.fn(),
    removeMeasurementUuid: vi.fn(),
    findMeasurementByUuid: vi.fn(),
    removeMeasurement: vi.fn().mockResolvedValue(true),
  };
  const filterRecord = { uuid: 'flt', title: 'Filter FL', isFilter: true, haveImpulseResponse: true };
  const trimmedRecord = { uuid: 'trim', title: 'trimmed', isFilter: true, haveImpulseResponse: true };
  const operations = {
    generateFilterMeasurement: vi.fn().mockResolvedValue(filterRecord),
    trimIRToWindows: vi.fn().mockResolvedValue(trimmedRecord),
    getImpulseResponse: vi.fn().mockResolvedValue(new Float32Array([1, 0.5])),
    setIrWindows: vi.fn().mockResolvedValue(true),
    setInverted: vi.fn().mockResolvedValue(true),
    toggleInversion: vi.fn().mockResolvedValue(true),
  };

  const record = {
    uuid: 'fl1',
    title: 'FL_P01',
    haveImpulseResponse: true,
    cumulativeIRShiftSeconds: 0.01,
    timeOfIRPeakSeconds: 0.01,
    splOffsetdB: 0,
    initialSplOffsetdB: 0,
    inverted: false,
  };
  const descriptor = {
    isSub: false,
    channelName: 'FL',
    channelDetails: { channelIndex: 0, group: 'Front' },
  };
  const derived = { byRecord: new Map([[record, descriptor]]) };

  const [adapter] = buildOcaMeasurements([record], {
    operations,
    session,
    derived,
    speedOfSound: 343,
  });
  return { adapter, operations, session, filterRecord, trimmedRecord };
}

describe('createOcaMeasurement', () => {
  it('exposes the derived getters createOCAFile consumes', () => {
    const { adapter } = harness();
    expect(adapter.isSub()).toBe(false);
    expect(adapter.channelName()).toBe('FL');
    expect(adapter.channelDetails().channelIndex).toBe(0);
    expect(adapter.crossover()).toBe(80);
    expect(adapter.speakerType()).toBe('S');
    // raw peak 0.02 s → 6.86 m ≥ 1 → no shift; distance = 0.01·343
    expect(adapter.distanceInMeters()).toBeCloseTo(3.43, 2);
    expect(adapter.splForAvr()).toBe(0);
    expect(adapter.splIsAboveLimit()).toBe(false);
    expect(adapter.exceedsDistance()).toBe('normal');
    expect(adapter.displayMeasurementTitle()).toBe('1: FL_P01');
  });

  it('generates a filter and drives the trim → impulse-response chain', async () => {
    const { adapter, operations, session, filterRecord, trimmedRecord } = harness();

    const filter = await adapter.generateFilterMeasurement();
    expect(operations.generateFilterMeasurement).toHaveBeenCalledWith(
      session.rewMeasurements,
      expect.objectContaining({ uuid: 'fl1', crossover: 80, splresidual: 0 }),
      expect.any(Object),
    );
    expect(filter.isFilter).toBe(true);

    await filter.setIrWindows({ leftWindowWidthms: 0 });
    expect(operations.setIrWindows).toHaveBeenCalledWith(
      session.rewMeasurements,
      filterRecord,
      { leftWindowWidthms: 0 },
    );

    const trimmed = await filter.trimIRToWindows();
    expect(operations.trimIRToWindows).toHaveBeenCalledWith(
      session.rewMeasurements,
      filterRecord,
      expect.any(Object),
    );

    const ir = await trimmed.getImpulseResponse(80);
    expect(operations.getImpulseResponse).toHaveBeenCalledWith(
      session.rewMeasurements,
      trimmedRecord,
      { freq: 80, unit: 'percent', windowed: true, normalised: true },
    );
    expect(ir[0]).toBe(1);

    await trimmed.delete();
    expect(session.removeMeasurement).toHaveBeenCalledWith(trimmedRecord);
  });
});
