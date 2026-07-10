import { describe, expect, it, vi } from 'vitest';
import { buildMsoMeasurements } from '../../src/measurement/mso-export-adapter.js';

describe('createMsoMeasurement', () => {
  it('exposes channelName/position and routes writes to operations', async () => {
    const operations = {
      resetAll: vi.fn().mockResolvedValue(true),
      getFrequencyResponse: vi.fn().mockResolvedValue({ freqs: [], magnitude: [], phase: [] }),
      applyWorkingSettings: vi.fn().mockResolvedValue(true),
    };
    const session = {
      rewMeasurements: { id: 'rew' },
      rewEq: { defaultEqtSettings: { manufacturer: 'Generic' } },
      analyseApiResponse: vi.fn(),
      removeMeasurements: vi.fn(),
      removeMeasurementUuid: vi.fn(),
      findMeasurementByUuid: vi.fn(),
    };
    const record = { uuid: 'sw1', title: 'SW1avg' };
    const descriptor = { channelName: 'SW1', position: 1 };
    const derived = { byRecord: new Map([[record, descriptor]]) };

    const [adapter] = buildMsoMeasurements([record], {
      operations,
      session,
      derived,
      workingSettingsConfig: () => ({ smoothingMethod: 'None' }),
      irWindowWidthsFor: () => ({ leftWindowWidthms: 70, rightWindowWidthms: 1000 }),
    });

    expect(adapter.channelName).toBe('SW1');
    expect(adapter.position).toBe(1);

    await adapter.resetAll(75);
    expect(operations.resetAll).toHaveBeenCalledWith(
      session.rewMeasurements,
      record,
      expect.objectContaining({
        targetLevel: 75,
        equaliserDefaults: session.rewEq.defaultEqtSettings,
      }),
    );

    await adapter.getFrequencyResponse();
    expect(operations.getFrequencyResponse).toHaveBeenCalledWith(
      session.rewMeasurements,
      record,
      {},
    );

    await adapter.applyWorkingSettings();
    expect(operations.applyWorkingSettings).toHaveBeenCalledWith(
      session.rewMeasurements,
      record,
      { smoothingMethod: 'None' },
    );
  });
});
