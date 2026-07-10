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
const { default: MeasurementRecord } = await import(
  '../../src/measurement/measurement-record.js'
);

function alignResponse(uuid, alignSPLOffsetdB) {
  return {
    results: {
      [uuid]: {
        UUID: uuid,
        alignSPLOffsetdB,
      },
    },
  };
}

function createSPLOffsetMeasurement({ initialSplOffsetdB = 10, splOffsetdB = 10 } = {}) {
  const uuid = 'measurement-1';
  const rewMeasurements = {
    alignSPL: vi.fn(),
  };
  const measurement = Object.create(MeasurementItem.prototype);

  // update() routes through the ADR 002 record; the fixture carries one.
  measurement.record = new MeasurementRecord({
    uuid,
    initialSplOffsetdB,
    splOffsetdB,
    alignSPLOffsetdB: splOffsetdB - initialSplOffsetdB,
  });
  measurement.uuid = uuid;
  measurement.initialSplOffsetdB = initialSplOffsetdB;
  measurement.splOffsetdB = ko.observable(splOffsetdB);
  measurement.alignSPLOffsetdB = ko.observable(splOffsetdB - initialSplOffsetdB);
  measurement.splOffsetDeltadB = () =>
    MeasurementItem.cleanFloat32Value(
      measurement.splOffsetdB() - measurement.initialSplOffsetdB,
      2,
    );
  measurement.displayMeasurementTitle = () => '1: Front Left';
  // setSPLOffsetDB reads the bandwidth through the measurement-operations
  // cache carried by the measurement.
  measurement.cachedBandwidth = { centerFrequencyHz: 80 };
  measurement.refresh = vi.fn();
  measurement.parentViewModel = { rewMeasurements };

  return { measurement, rewMeasurements, uuid };
}

describe('MeasurementItem SPL offset', () => {
  it('updates SPL offsets locally from Align SPL result without refreshing', async () => {
    const { measurement, rewMeasurements, uuid } = createSPLOffsetMeasurement({
      initialSplOffsetdB: 10,
      splOffsetdB: 11,
    });

    rewMeasurements.alignSPL
      .mockResolvedValueOnce(alignResponse(uuid, 1.25))
      .mockResolvedValueOnce(alignResponse(uuid, 2.5));

    await expect(measurement.setSPLOffsetDB(2.5)).resolves.toBe(true);

    expect(rewMeasurements.alignSPL).toHaveBeenNthCalledWith(1, [uuid], 75, 80, 0);
    expect(rewMeasurements.alignSPL).toHaveBeenNthCalledWith(2, [uuid], 76.25, 80, 0);
    expect(measurement.refresh).not.toHaveBeenCalled();
    expect(measurement.alignSPLOffsetdB()).toBe(2.5);
    expect(measurement.splOffsetdB()).toBe(12.5);
  });

  it('preserves a saved initial SPL offset of zero', () => {
    const parentViewModel = {
      jsonAvrData: () => ({ avr: { speedOfSound: 343 }, detectedChannels: [] }),
      groupedMeasurements: () => ({}),
      measurements: () => [],
      findMeasurementByUuid: () => null,
      measurementsByGroup: () => ({}),
      allPredictedLfeMeasurement: () => [],
      shiftInMeters: () => 0,
      distanceUnit: () => 'M',
      maxDistanceInMeters: () => 0,
      maxDistanceInMetersError: () => 10,
      maxDistanceInMetersWarning: () => 8,
      currentSelectedPosition: () => 0,
      validMeasurements: () => [],
    };
    const item = {
      title: 'Front Left',
      notes: '',
      uuid: 'measurement-1',
      inverted: false,
      splOffsetdB: 2,
      alignSPLOffsetdB: 2,
      initialSplOffsetdB: 0,
      cumulativeIRShiftSeconds: 0,
      timeOfIRPeakSeconds: 0,
    };

    const measurement = new MeasurementItem(item, parentViewModel);

    expect(measurement.initialSplOffsetdB).toBe(0);
    expect(measurement.splOffsetDeltadB()).toBe(2);

    measurement.dispose();
  });
});