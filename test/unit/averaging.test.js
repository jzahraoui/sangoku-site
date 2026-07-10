import { describe, expect, it, vi } from 'vitest';
import { createAverages } from '../../src/services/averaging.js';

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
