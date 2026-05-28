import ko from 'knockout';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logs.js', () => ({
  default: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
  },
}));

const { default: MeasurementItem } = await import('../../src/MeasurementItem.js');

function createIROffsetMeasurement(initialShift = 0.0123456789) {
  const rewMeasurements = {
    offsetTZero: vi.fn().mockResolvedValue(true),
  };
  const measurement = Object.create(MeasurementItem.prototype);

  measurement.uuid = 'measurement-1';
  measurement.haveImpulseResponse = true;
  measurement.title = () => 'Front Left';
  measurement.cumulativeIRShiftSeconds = ko.observable(initialShift);
  measurement.refresh = vi.fn();
  measurement.parentViewModel = { rewMeasurements };

  return { measurement, rewMeasurements };
}

describe('MeasurementItem IR offset', () => {
  it('updates cumulative IR shift locally without refreshing', async () => {
    const initialShift = 0.0123456789;
    const amountToAdd = 0.00123456789;
    const roundedAmount = MeasurementItem.cleanFloat32Value(amountToAdd, 10);
    const { measurement, rewMeasurements } = createIROffsetMeasurement(initialShift);

    await expect(measurement.addIROffsetSeconds(amountToAdd)).resolves.toBe(true);

    expect(rewMeasurements.offsetTZero).toHaveBeenCalledWith(
      'measurement-1',
      roundedAmount,
    );
    expect(measurement.refresh).not.toHaveBeenCalled();
    expect(measurement.cumulativeIRShiftSeconds()).toBe(
      MeasurementItem.cleanFloat32Value(initialShift + roundedAmount, 10),
    );
  });

  it('keeps local IR shift unchanged when REW update fails', async () => {
    const initialShift = 0.0123456789;
    const { measurement, rewMeasurements } = createIROffsetMeasurement(initialShift);

    rewMeasurements.offsetTZero.mockRejectedValueOnce(new Error('REW failed'));

    await expect(measurement.addIROffsetSeconds(0.001)).rejects.toThrow('REW failed');

    expect(measurement.refresh).not.toHaveBeenCalled();
    expect(measurement.cumulativeIRShiftSeconds()).toBe(initialShift);
  });
});