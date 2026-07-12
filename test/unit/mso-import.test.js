import { describe, expect, it, vi } from 'vitest';
import { createMsoImporter } from '../../src/services/mso-import.js';

describe('createMsoImporter.importFilterInREW', () => {
  function harness() {
    const operations = {
      setFilters: vi.fn().mockResolvedValue(true),
      setInverted: vi.fn().mockResolvedValue(true),
      setcumulativeIRShiftSeconds: vi.fn().mockResolvedValue(true),
      setSPLOffsetDB: vi.fn().mockResolvedValue(true),
    };
    const session = {
      rewMeasurements: { id: 'rew' },
      findMeasurementByUuid: vi.fn(),
      removeMeasurementUuid: vi.fn(),
    };
    return { operations, session, ...createMsoImporter({ operations, session }) };
  }

  it('applies filters/inversion/delay/gain to the matching sub records', async () => {
    const { operations, session, importFilterInREW } = harness();
    const sw1 = { uuid: 's1', title: 'SW1avg' };
    const sw2 = { uuid: 's2', title: 'SW2avg' };

    await importFilterInREW(
      [
        { channel: 'SW1', filters: ['f1'], invert: 1, gain: -2, delay: 3.5 },
        { channel: 'SW2', filters: ['f2'], invert: -1, gain: 0, delay: 0 },
      ],
      [sw1, sw2],
    );

    expect(operations.setFilters).toHaveBeenCalledWith(
      session.rewMeasurements,
      sw1,
      ['f1'],
    );
    expect(operations.setInverted).toHaveBeenCalledWith(session.rewMeasurements, sw1, false);
    expect(operations.setInverted).toHaveBeenCalledWith(session.rewMeasurements, sw2, true);
    // 3.5 ms delay reversed to seconds
    expect(operations.setcumulativeIRShiftSeconds).toHaveBeenCalledWith(
      session.rewMeasurements,
      sw1,
      -0.0035,
    );
    expect(operations.setSPLOffsetDB).toHaveBeenCalledWith(session.rewMeasurements, sw1, -2);
  });

  it('throws when no sub matches the channel', async () => {
    const { importFilterInREW } = harness();
    await expect(
      importFilterInREW([{ channel: 'SW3', filters: [], invert: 1, gain: 0, delay: 0 }], [
        { uuid: 's1', title: 'SW1avg' },
      ]),
    ).rejects.toThrow('Cannot find measurement name matching SW3');
  });
});
