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

function response(freqs, magnitude) {
  return {
    freqs: Float32Array.from(freqs),
    magnitude: Float32Array.from(magnitude),
  };
}

// detectFallOff delegates to measurement-operations (lot I3): the REW API is
// the mocking seam, not the item's own methods.
function createFallOffMeasurement(measurementData, ...targetResponses) {
  const measurement = Object.create(MeasurementItem.prototype);
  measurement.uuid = 'measurement-1';
  measurement.title = () => 'Front Left';

  const rewMeasurements = {
    getFrequencyResponse: vi.fn().mockResolvedValue(measurementData),
    getTargetResponse: vi.fn(),
  };
  for (const targetResponse of targetResponses) {
    rewMeasurements.getTargetResponse.mockResolvedValueOnce(targetResponse);
  }
  measurement.parentViewModel = { rewMeasurements };

  return measurement;
}

describe('MeasurementItem fall-off detection', () => {
  it('returns cutoffs without storing them on the measurement', async () => {
    const freqs = [20, 30, 40, 50, 100, 400, 600, 1000];
    const measurementData = response(freqs, [65, 71, 73, 75, 75, 73, 70, 65]);
    const targetCurveData = response(freqs, freqs.map(() => 75));
    const measurement = createFallOffMeasurement(measurementData, targetCurveData);

    const fallOff = await measurement.detectFallOff(-3);

    expect(fallOff).toEqual({ lowHz: 40, highHz: 400 });
    expect(measurement.dectedFallOffLow).toBeUndefined();
    expect(measurement.dectedFallOffHigh).toBeUndefined();
  });

  it('recalculates from the current target response on each call', async () => {
    const freqs = [20, 30, 40, 50, 100, 400, 600, 1000];
    const measurementData = response(freqs, [65, 71, 73, 75, 75, 73, 70, 65]);
    const firstTarget = response(freqs, freqs.map(() => 75));
    const changedTarget = response(freqs, freqs.map(() => 70));
    const measurement = createFallOffMeasurement(
      measurementData,
      firstTarget,
      changedTarget,
    );

    await expect(measurement.detectFallOff(-3)).resolves.toEqual({
      lowHz: 40,
      highHz: 400,
    });
    await expect(measurement.detectFallOff(-3)).resolves.toEqual({
      lowHz: 30,
      highHz: 600,
    });
  });
});