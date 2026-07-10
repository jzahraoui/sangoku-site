import { describe, expect, it, vi } from 'vitest';
import {
  createAverages,
  createAveragingProcessor,
} from '../../src/services/averaging.js';

function item(title, overrides = {}) {
  return {
    displayMeasurementTitle: () => title,
    alignSPLOffsetdB: () => 0,
    splOffsetdB: () => 0,
    inverted: () => false,
    isAverage: false,
    IRPeakValue: 0.5,
    ...overrides,
  };
}

describe('createAverages', () => {
  it('validates the snapshots then delegates to the grouped-responses bridge', async () => {
    const processGroupedResponses = vi.fn().mockResolvedValue(undefined);
    const grouped = { FL: { items: [], count: 2 } };

    await createAverages({
      validMeasurements: [
        item('FL_P01'),
        item('FL_P02'),
        item('FLavg', { isAverage: true }), // excluded from the checks
        item('clipped', { IRPeakValue: 1.2, inverted: () => true }), // excluded too
      ],
      groupedMeasurements: grouped,
      averageMethod: 'Vector average',
      deleteOriginal: 'all',
      processGroupedResponses,
    });

    expect(processGroupedResponses).toHaveBeenCalledWith(
      grouped,
      'Vector average',
      'all',
    );
  });

  it('refuses inconsistent measurements before averaging', async () => {
    const processGroupedResponses = vi.fn();

    await expect(
      createAverages({
        validMeasurements: [
          item('FL_P01'),
          item('FL_P02', { inverted: () => true }),
        ],
        groupedMeasurements: {},
        averageMethod: 'Vector average',
        deleteOriginal: 'all',
        processGroupedResponses,
      }),
    ).rejects.toThrow(/appear to be inverted: FL_P02/);

    expect(processGroupedResponses).not.toHaveBeenCalled();
  });
});

describe('createAveragingProcessor (records)', () => {
  const record = (uuid, title, IRPeakValue = 0.5) => ({ uuid, title, IRPeakValue });

  function harness() {
    const created = record('avg-uuid', 'created');
    const session = {
      rewMeasurements: {
        crossCorrAlign: vi.fn().mockResolvedValue(true),
        processMeasurements: vi.fn().mockResolvedValue({ ok: true }),
      },
      analyseApiResponse: vi.fn().mockResolvedValue(created),
      removeMeasurements: vi.fn().mockResolvedValue(true),
      removeMeasurementUuid: vi.fn().mockResolvedValue(true),
    };
    const operations = { setTitle: vi.fn().mockResolvedValue(true) };
    const { processGroupedResponses } = createAveragingProcessor({ session, operations });
    return { session, operations, created, processGroupedResponses };
  }

  it('averages each usable channel group, renames via operations, deletes originals', async () => {
    const { session, operations, created, processGroupedResponses } = harness();
    const fl1 = record('fl1', 'FL_P01');
    const fl2 = record('fl2', 'FL_P02');
    const c1 = record('c1', 'C_P01');
    const c2 = record('c2', 'C_P02');
    const grouped = {
      FL: { items: [fl1, fl2], count: 2 },
      C: { items: [c1, c2], count: 2 },
    };

    await expect(processGroupedResponses(grouped, 'Vector average', 'all')).resolves.toBe(
      true,
    );

    expect(session.rewMeasurements.crossCorrAlign).toHaveBeenCalledWith(['fl1', 'fl2']);
    expect(session.rewMeasurements.processMeasurements).toHaveBeenCalledWith(
      'Vector average',
      ['fl1', 'fl2'],
    );
    expect(operations.setTitle).toHaveBeenCalledWith(
      session.rewMeasurements,
      created,
      'FLavg',
    );
    // deleteOriginal 'all' → the 4 source uuids are removed
    expect(session.removeMeasurementUuid.mock.calls.map(c => c[0])).toEqual([
      'fl1',
      'fl2',
      'c1',
      'c2',
    ]);
  });

  it('excludes existing averages/predictions and rejects groups below 2 usable', async () => {
    const { processGroupedResponses } = harness();
    const grouped = {
      FL: { items: [record('fl1', 'FL_P01'), record('fla', 'FLavg')], count: 2 },
      C: { items: [record('c1', 'C_P01'), record('c2', 'C_P02')], count: 2 },
    };

    await expect(processGroupedResponses(grouped, 'Vector average', 'all')).rejects.toThrow(
      'Need at least 2 measurements to make an average: FL',
    );
  });
});
