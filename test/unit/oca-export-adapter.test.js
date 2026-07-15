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
  const operations = {
    getFilters: vi.fn().mockResolvedValue([
      { index: 1, type: 'PK', enabled: true, frequency: 100, q: 4, gaindB: -3 },
    ]),
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
    crossoverByGroup: { Front: 80 },
    speedOfSound: 343,
  });
  return { adapter, operations, session, record, derived };
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

  it('exposes the REW filter bank for the internal OCA generation', async () => {
    const { adapter, operations, session } = harness();

    await adapter.getFilters();
    expect(operations.getFilters).toHaveBeenCalledWith(
      session.rewMeasurements,
      expect.objectContaining({ uuid: 'fl1' }),
    );
  });

  it('refuse un groupe non-sub sans crossover ni defaultCrossover explicite', () => {
    // Le BW12 électrique étant cuit dans la FIR, un défaut silencieux (80)
    // mettrait en passe-haut permanent des canaux configurés Large.
    const { record, derived, operations, session } = harness();

    expect(() =>
      buildOcaMeasurements([record], { operations, session, derived }),
    ).toThrow(/No crossover provided for group\(s\) Front/);

    // Un defaultCrossover EXPLICITE reste accepté (opt-in assumé).
    const [adapter] = buildOcaMeasurements([record], {
      operations,
      session,
      derived,
      defaultCrossover: 90,
    });
    expect(adapter.crossover()).toBe(90);
  });
});
