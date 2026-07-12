import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAlignmentService,
  getTargetLevelAtFreq,
  setSameDelayToAll,
} from '../../src/services/alignment.js';
import { FrequencyResponseAnalyzer } from '../../src/analysis/index.js';

function createSubMeasurement(uuid) {
  return {
    uuid,
    initialSplOffsetdB: 10,
    removeWorkingSettings: vi.fn().mockResolvedValue(undefined),
    resetTargetSettings: vi.fn().mockResolvedValue(undefined),
    getFrequencyResponse: vi.fn().mockResolvedValue({
      freqs: [10, 20, 40, 80, 160, 500],
      magnitude: [65, 72, 80, 80, 72, 60],
    }),
    // flat 80 dB target curve → getTargetLevelAtFreq resolves 80
    getTargetResponse: vi.fn().mockResolvedValue({
      freqs: [20, 40, 80],
      magnitude: [80, 80, 80],
    }),
    displayMeasurementTitle: () => uuid,
    position: () => 1,
    applyWorkingSettings: vi.fn().mockResolvedValue(undefined),
    update: vi.fn(),
    copySplOffsetDeltadBToOther: vi.fn().mockResolvedValue(undefined),
  };
}

function createHarness() {
  const session = {
    rewMeasurements: {
      alignSPL: vi.fn(([uuid]) =>
        Promise.resolve({
          results: {
            [uuid]: {
              UUID: uuid,
              alignSPLOffsetdB: uuid === 'sub-a' ? 1.25 : 2.5,
            },
          },
        }),
      ),
    },
    rewAlignmentTool: {
      setRemoveTimeDelay: vi.fn().mockResolvedValue(undefined),
      resetAll: vi.fn().mockResolvedValue(undefined),
      setMaxNegativeDelay: vi.fn().mockResolvedValue(undefined),
      setMaxPositiveDelay: vi.fn().mockResolvedValue(undefined),
      alignIRsBatch: vi.fn(),
    },
    removeMeasurements: vi.fn().mockResolvedValue(true),
    analyseApiResponse: vi.fn(),
  };
  const service = createAlignmentService({
    session,
    applyCutOffFilter: vi.fn(),
    setTargetLevelFromMeasurement: vi.fn().mockResolvedValue(75),
    getPredictedLfeMeasurements: () => [],
  });
  return { session, service };
}

describe('setSameDelayToAll', () => {
  it('aligns every measurement on the first delay', async () => {
    const first = {
      cumulativeIRShiftSeconds: () => 0.002,
      setcumulativeIRShiftSeconds: vi.fn(),
    };
    const second = {
      cumulativeIRShiftSeconds: () => 0,
      setcumulativeIRShiftSeconds: vi.fn(),
    };

    await setSameDelayToAll([first, second]);
    expect(second.setcumulativeIRShiftSeconds).toHaveBeenCalledWith(0.002);

    await setSameDelayToAll([first]);
    expect(first.setcumulativeIRShiftSeconds).toHaveBeenCalledTimes(1);
  });
});

describe('getTargetLevelAtFreq', () => {
  it('validates the frequency and the measurement', async () => {
    await expect(getTargetLevelAtFreq({}, -1)).rejects.toThrow(
      'Target frequency must be a positive number',
    );
    await expect(getTargetLevelAtFreq(undefined, 40)).rejects.toThrow(
      'No measurements available',
    );
  });

  it('returns the target level at the closest frequency', async () => {
    const measurement = {
      getTargetResponse: vi.fn().mockResolvedValue({
        freqs: [20, 42, 80],
        magnitude: [78, 80.5, 82],
      }),
    };

    await expect(getTargetLevelAtFreq(measurement, 40)).resolves.toBe(80.5);
    expect(measurement.getTargetResponse).toHaveBeenCalledWith('SPL', 6);
  });
});

describe('findAligment', () => {
  it('rejects non-finite alignment delays', async () => {
    const { session, service } = createHarness();
    session.rewAlignmentTool.alignIRsBatch.mockResolvedValue({
      results: [{ 'Delay B ms': 'not-a-number', 'Invert B': 'false' }],
    });

    await expect(
      service.findAligment({ uuid: 'a' }, { uuid: 'b' }, 80),
    ).rejects.toThrow('Invalid AlignResults object or missing Delay B ms');
  });

  it('converts the delay to seconds and reports the inversion', async () => {
    const { session, service } = createHarness();
    session.rewAlignmentTool.alignIRsBatch.mockResolvedValue({
      results: [{ 'Delay B ms': '2.5', 'Invert B': 'true' }],
    });

    await expect(
      service.findAligment({ uuid: 'a' }, { uuid: 'b' }, 80),
    ).resolves.toEqual({ shiftDelay: 0.0025, isBInverted: true });
    expect(session.rewAlignmentTool.alignIRsBatch).toHaveBeenCalledWith('a', 'b', 80);
  });
});

describe('adjustSubwooferSPLLevels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aligns each sub on its detected bandwidth and returns the aggregate system bandwidth', async () => {
    const { session, service } = createHarness();
    const firstSub = createSubMeasurement('sub-a');
    const secondSub = createSubMeasurement('sub-b');
    const expectedTargetLevel = 80 - 20 * Math.log10(2);

    vi.spyOn(FrequencyResponseAnalyzer, 'detectBandwidth')
      .mockReturnValueOnce({
        status: 'ok',
        lowCutoffHz: 20.4,
        highCutoffHz: 180.9,
        centerFrequencyHz: 61,
        bandwidthOctaves: 3,
      })
      .mockReturnValueOnce({
        status: 'ok',
        lowCutoffHz: 35.2,
        highCutoffHz: 120.7,
        centerFrequencyHz: 65,
        bandwidthOctaves: 2,
      });

    await expect(
      service.adjustSubwooferSPLLevels([firstSub, secondSub]),
    ).resolves.toEqual({
      lowFrequency: 21,
      highFrequency: 180,
      targetLevelAtFreq: 80,
    });

    expect(firstSub.getFrequencyResponse).toHaveBeenCalledWith('SPL', 'None', 12);
    expect(secondSub.getFrequencyResponse).toHaveBeenCalledWith('SPL', 'None', 12);
    expect(FrequencyResponseAnalyzer.detectBandwidth).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ measurement: 'sub-a' }),
      {
        rangeHz: [10, 500],
        passbandHz: [30, 80],
        thresholdDb: -9,
        smoothing: '1/3',
      },
    );
    expect(session.rewMeasurements.alignSPL).toHaveBeenNthCalledWith(
      1,
      ['sub-a'],
      expectedTargetLevel,
      61,
      3,
    );
    expect(session.rewMeasurements.alignSPL).toHaveBeenNthCalledWith(
      2,
      ['sub-b'],
      expectedTargetLevel,
      65,
      2,
    );
    expect(firstSub.update).toHaveBeenCalledWith({
      alignSPLOffsetdB: 1.25,
      splOffsetdB: 11.25,
    });
    expect(secondSub.update).toHaveBeenCalledWith({
      alignSPLOffsetdB: 2.5,
      splOffsetdB: 12.5,
    });
  });

  it('keeps the aggregate range when detected bands do not overlap', async () => {
    const { session, service } = createHarness();
    const firstSub = createSubMeasurement('sub-a');
    const secondSub = createSubMeasurement('sub-b');
    const expectedTargetLevel = 80 - 20 * Math.log10(2);

    vi.spyOn(FrequencyResponseAnalyzer, 'detectBandwidth')
      .mockReturnValueOnce({
        status: 'ok',
        lowCutoffHz: 20.1,
        highCutoffHz: 80.9,
        centerFrequencyHz: 40,
        bandwidthOctaves: 2,
      })
      .mockReturnValueOnce({
        status: 'ok',
        lowCutoffHz: 100.1,
        highCutoffHz: 150.9,
        centerFrequencyHz: 123,
        bandwidthOctaves: 1,
      });

    await expect(
      service.adjustSubwooferSPLLevels([firstSub, secondSub]),
    ).resolves.toEqual({
      lowFrequency: 21,
      highFrequency: 150,
      targetLevelAtFreq: 80,
    });

    expect(session.removeMeasurements).toHaveBeenCalledTimes(1);
    expect(session.rewMeasurements.alignSPL).toHaveBeenNthCalledWith(
      1,
      ['sub-a'],
      expectedTargetLevel,
      40,
      2,
    );
    expect(session.rewMeasurements.alignSPL).toHaveBeenNthCalledWith(
      2,
      ['sub-b'],
      expectedTargetLevel,
      123,
      1,
    );
    expect(firstSub.applyWorkingSettings).toHaveBeenCalledTimes(1);
    expect(secondSub.applyWorkingSettings).toHaveBeenCalledTimes(1);
  });

  it('rejects indeterminate sub bandwidth instead of assuming the full range', async () => {
    const { session, service } = createHarness();
    const sub = createSubMeasurement('sub-a');

    vi.spyOn(FrequencyResponseAnalyzer, 'detectBandwidth').mockReturnValueOnce({
      status: 'indeterminate',
      reason: 'no response region is above the threshold',
    });

    await expect(service.adjustSubwooferSPLLevels([sub])).rejects.toThrow(
      'Unable to detect subwoofer bandwidth for sub-a: no response region is above the threshold',
    );

    expect(session.rewMeasurements.alignSPL).not.toHaveBeenCalled();
    expect(session.removeMeasurements).not.toHaveBeenCalled();
    expect(sub.applyWorkingSettings).toHaveBeenCalledTimes(1);
  });
});

/** IR synthétique : burst large bande démarrant à startSample (48 kHz). */
function alignmentBurst(startSample) {
  const out = new Float64Array(2048);
  for (let i = startSample; i < out.length; i++) {
    const t = (i - startSample) / 48000;
    out[i] = Math.sin(2 * Math.PI * 3000 * t) * Math.exp(-t * 3000);
  }
  return out;
}

describe('alignArrivals', () => {
  it('zeroes speaker arrivals (excess phase) then gives all subs the first sub delay', async () => {
    const { service } = createHarness();
    // burst à l'échantillon 480 + startTime 2 ms → arrivée absolue ≈ 12 ms
    const speaker = {
      getImpulseResponseInfo: vi.fn().mockResolvedValue({
        data: alignmentBurst(480),
        sampleRate: 48000,
        startTime: 0.002,
      }),
      addIROffsetSeconds: vi.fn().mockResolvedValue(true),
      setZeroAtIrPeak: vi.fn().mockResolvedValue(true),
    };
    const subA = {
      getImpulseResponseInfo: vi.fn().mockResolvedValue({
        data: alignmentBurst(96),
        sampleRate: 48000,
        startTime: 0,
      }),
      addIROffsetSeconds: vi.fn().mockResolvedValue(true),
      setZeroAtIrPeak: vi.fn().mockResolvedValue(true),
      cumulativeIRShiftSeconds: () => 0.001,
      setcumulativeIRShiftSeconds: vi.fn(),
    };
    const subB = {
      cumulativeIRShiftSeconds: () => 0,
      setcumulativeIRShiftSeconds: vi.fn(),
    };

    await service.alignArrivals([speaker], [subA, subB]);

    expect(speaker.addIROffsetSeconds).toHaveBeenCalledOnce();
    expect(speaker.addIROffsetSeconds.mock.calls[0][0]).toBeCloseTo(
      0.002 + 480 / 48000,
      4,
    );
    expect(speaker.setZeroAtIrPeak).not.toHaveBeenCalled();
    expect(subA.addIROffsetSeconds).toHaveBeenCalledOnce();
    expect(subB.setcumulativeIRShiftSeconds).toHaveBeenCalledWith(0.001);
  });

  it('falls back to the IR peak when the impulse response is unavailable', async () => {
    const { service } = createHarness();
    const speaker = {
      displayMeasurementTitle: () => '1: FL',
      getImpulseResponseInfo: vi.fn().mockRejectedValue(new Error('404')),
      addIROffsetSeconds: vi.fn(),
      setZeroAtIrPeak: vi.fn().mockResolvedValue(true),
    };

    await service.alignArrivals([speaker], []);

    expect(speaker.setZeroAtIrPeak).toHaveBeenCalledOnce();
    expect(speaker.addIROffsetSeconds).not.toHaveBeenCalled();
  });
});

describe('operations bridge (flat records, no methods)', () => {
  it('routes alignArrivals writes to the operations functions', async () => {
    const operations = {
      getImpulseResponseInfo: vi.fn().mockResolvedValue({
        data: alignmentBurst(480),
        sampleRate: 48000,
        startTime: 0,
      }),
      addIROffsetSeconds: vi.fn().mockResolvedValue(true),
      setZeroAtIrPeak: vi.fn().mockResolvedValue(true),
      setcumulativeIRShiftSeconds: vi.fn().mockResolvedValue(true),
    };
    const session = { rewMeasurements: { id: 'rew' } };
    const service = createAlignmentService({
      session,
      operations,
      applyCutOffFilter: vi.fn(),
      setTargetLevelFromMeasurement: vi.fn(),
      getPredictedLfeMeasurements: () => [],
    });

    // plain records: flat fields, zero methods
    const speaker = { uuid: 'FL' };
    const subA = { uuid: 'SW1', cumulativeIRShiftSeconds: 0.001 };
    const subB = { uuid: 'SW2', cumulativeIRShiftSeconds: 0 };

    await service.alignArrivals([speaker], [subA, subB]);

    expect(operations.getImpulseResponseInfo).toHaveBeenCalledWith(
      session.rewMeasurements,
      speaker,
    );
    expect(operations.addIROffsetSeconds).toHaveBeenCalledWith(
      session.rewMeasurements,
      speaker,
      expect.closeTo(480 / 48000, 4),
    );
    expect(operations.addIROffsetSeconds).toHaveBeenCalledWith(
      session.rewMeasurements,
      subA,
      expect.closeTo(480 / 48000, 4),
    );
    expect(operations.setZeroAtIrPeak).not.toHaveBeenCalled();
    expect(operations.setcumulativeIRShiftSeconds).toHaveBeenCalledWith(
      session.rewMeasurements,
      subB,
      0.001,
    );
  });
});

describe('checkAlignment', () => {
  it('resets the shift delay and warns instead of failing', async () => {
    const { session, service } = createHarness();
    const speakerItem = {
      crossover: () => 80,
      relatedLfeMeasurement: () => null, // triggers the tolerated failure
      displayMeasurementTitle: () => '1: FL',
      update: vi.fn(),
    };

    await service.checkAlignment(speakerItem);

    expect(speakerItem.update).toHaveBeenCalledWith({ shiftDelay: Infinity });
    expect(session.removeMeasurements).toHaveBeenCalledWith([]);
  });
});
