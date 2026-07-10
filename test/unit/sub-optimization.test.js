import { describe, expect, it, vi } from 'vitest';
import {
  MAXIMISED_SUM_TITLE,
  createSubOptimizationService,
  getMaxFromArray,
} from '../../src/services/sub-optimization.js';

function fakeSub(uuid, overrides = {}) {
  return {
    uuid,
    title: () => uuid,
    displayMeasurementTitle: () => `1: ${uuid}`,
    position: () => 1,
    setTargetLevel: vi.fn().mockResolvedValue(true),
    applyWorkingSettings: vi.fn().mockResolvedValue(undefined),
    removeWorkingSettings: vi.fn().mockResolvedValue(undefined),
    resetTargetSettings: vi.fn().mockResolvedValue(undefined),
    detectFallOff: vi.fn().mockResolvedValue({ lowHz: 25, highHz: 150 }),
    checkFilterGain: vi.fn().mockResolvedValue(undefined),
    _runPhaseMatchFilter: vi.fn().mockResolvedValue(undefined),
    getFilters: vi.fn().mockResolvedValue([{ index: 1, type: 'PK' }]),
    setFilters: vi.fn().mockResolvedValue(true),
    copyFiltersToOther: vi.fn().mockResolvedValue(undefined),
    setInverted: vi.fn().mockResolvedValue(undefined),
    setSingleFilter: vi.fn().mockResolvedValue(true),
    addIROffsetSeconds: vi.fn().mockResolvedValue(true),
    addSPLOffsetDB: vi.fn().mockResolvedValue(true),
    copySplOffsetDeltadBToOther: vi.fn().mockResolvedValue(undefined),
    setcumulativeIRShiftSeconds: vi.fn().mockResolvedValue(undefined),
    cumulativeIRShiftSeconds: () => 0,
    inverted: () => false,
    _computeInSeconds: v => v / 343,
    ...overrides,
  };
}

function createHarness({ subs = [], measurements = [], config = {} } = {}) {
  const session = {
    measurements: { get: () => measurements },
    removeMeasurement: vi.fn().mockResolvedValue(true),
    removeMeasurements: vi.fn().mockResolvedValue(true),
    findMeasurementByUuid: vi.fn(uuid => measurements.find(m => m.uuid === uuid)),
    addMeasurementFromRewOperation: vi.fn(),
    rewImport: { importFrequencyResponseData: vi.fn().mockResolvedValue({}) },
    rewEq: { setMatchTargetSettings: vi.fn().mockResolvedValue(undefined) },
    rewMeasurements: { matchTarget: vi.fn().mockResolvedValue(undefined) },
  };
  const businessTools = {
    produceAligned: vi.fn().mockResolvedValue(undefined),
    createsSum: vi.fn(),
  };
  const service = createSubOptimizationService({
    session,
    businessTools,
    config: {
      mainTargetLevel: 75,
      selectedEqualizationMode: 'rch',
      lowerFrequencyBoundSub: 10,
      upperFrequencyBoundSub: 500,
      maxBoostIndividualValue: 6,
      maxBoostOverallValue: 3,
      useAllPassFiltersForSubs: false,
      distanceLeftBeforeError: 3,
      jsonAvrData: { avr: { minDistAccuracy: 0.0001 } },
      ...config,
    },
    lists: {
      uniqueSubsMeasurements: () => subs,
      predictedLfeMeasurements: () => [],
      selectedPredictedLfeMeasurement: () => null,
    },
  });
  return { service, session, businessTools };
}

describe('getMaxFromArray', () => {
  it('returns the maximum and validates its input', () => {
    expect(getMaxFromArray([1, 9, 3])).toBe(9);
    expect(() => getMaxFromArray('nope')).toThrow('Input is not an array');
  });
});

describe('sendToREW', () => {
  it('imports the response then prepares the created measurement', async () => {
    const created = fakeSub('created');
    const { service, session } = createHarness();
    session.addMeasurementFromRewOperation.mockImplementation(async operation => {
      await operation();
      return created;
    });

    const sum = {
      freqs: [20, 40],
      freqStep: 20,
      magnitude: [75, 76],
      phase: [0, 0.1],
      ppo: 96,
    };

    await expect(service.sendToREW(sum, MAXIMISED_SUM_TITLE)).resolves.toBe(created);

    expect(session.rewImport.importFrequencyResponseData).toHaveBeenCalledWith({
      identifier: 'LFE Max Sum',
      isImpedance: false,
      startFreq: 20,
      freqStep: 20,
      magnitude: [75, 76],
      phase: [0, 0.1],
      ppo: 96,
    });
    expect(created.setTargetLevel).toHaveBeenCalledWith(75);
    expect(created.resetTargetSettings).toHaveBeenCalledOnce();
  });
});

describe('produceSumProcess', () => {
  it('replaces the previous predicted LFE with a fresh sum', async () => {
    const previous = fakeSub('old-sum', { title: () => 'LFE predicted_P1' });
    const created = fakeSub('new-sum', { title: () => 'LFE predicted_P1' });
    const subs = [fakeSub('sw1'), fakeSub('sw2')];
    const { service, session, businessTools } = createHarness({
      measurements: [previous],
    });
    businessTools.createsSum.mockResolvedValue(created);

    await expect(service.produceSumProcess(subs)).resolves.toBe(created);

    expect(session.removeMeasurement).toHaveBeenCalledWith(previous);
    expect(businessTools.createsSum).toHaveBeenCalledWith(subs, 'LFE predicted_P1', true);
    expect(created.isSubOperationResult).toBe(true);
  });

  it('rejects an empty list', async () => {
    const { service } = createHarness();
    await expect(service.produceSumProcess([])).rejects.toThrow('No subs found');
  });
});

describe('equalizeSub', () => {
  it('uses the phase-match filter in rch mode with the sub bounds', async () => {
    const sub = fakeSub('sw1');
    const { service, session } = createHarness({ subs: [sub] });

    await expect(service.equalizeSub(sub)).resolves.toBe(true);

    expect(sub.detectFallOff).toHaveBeenCalledWith(-3);
    expect(sub._runPhaseMatchFilter).toHaveBeenCalledWith(25, 150, {
      individualMaxBoostDb: 6,
      overallMaxBoostDb: 3,
    });
    expect(session.rewMeasurements.matchTarget).not.toHaveBeenCalled();
    expect(sub.checkFilterGain).toHaveBeenCalledOnce();
  });

  it('drives REW matchTarget in rew mode', async () => {
    const sub = fakeSub('sw1');
    const { service, session } = createHarness({
      subs: [sub],
      config: { selectedEqualizationMode: 'rew' },
    });

    await service.equalizeSub(sub);

    expect(session.rewEq.setMatchTargetSettings).toHaveBeenCalledWith(
      expect.objectContaining({ startFrequency: 25, endFrequency: 150 }),
    );
    expect(session.rewMeasurements.matchTarget).toHaveBeenCalledWith('sw1');
    expect(sub._runPhaseMatchFilter).not.toHaveBeenCalled();
  });
});

describe('equalizeSubs routing', () => {
  it('routes to the single-sub optimizer for one sub', async () => {
    const sub = fakeSub('sw1');
    const { service } = createHarness({ subs: [sub] });

    await service.equalizeSubs();

    expect(sub._runPhaseMatchFilter).toHaveBeenCalledOnce();
    expect(sub.copyFiltersToOther).toHaveBeenCalledOnce();
  });

  it('multipleSubOptimizer requires the maximised sum', async () => {
    const subs = [fakeSub('sw1'), fakeSub('sw2')];
    const { service } = createHarness({ subs, measurements: [] });

    await expect(service.equalizeSubs()).rejects.toThrow('No maximised sum found');
  });

  it('equalizes the maximised sum then propagates its filters', async () => {
    const maximisedSum = fakeSub('max', { title: () => MAXIMISED_SUM_TITLE });
    const subs = [fakeSub('sw1'), fakeSub('sw2')];
    const { service } = createHarness({ subs, measurements: [maximisedSum] });

    await service.equalizeSubs();

    expect(maximisedSum._runPhaseMatchFilter).toHaveBeenCalledOnce();
    for (const sub of subs) {
      // filters applied without overwriting the reserved all-pass slot
      expect(sub.setFilters).toHaveBeenCalledWith([{ index: 1, type: 'PK' }], false);
      expect(sub.copyFiltersToOther).toHaveBeenCalledOnce();
    }
  });
});

describe('createOptimizerConfig', () => {
  it('requires AVR data and a positive delay headroom', () => {
    const { service } = createHarness({ subs: [fakeSub('sw1')], config: { jsonAvrData: null } });
    expect(() => service.createOptimizerConfig(20, 200)).toThrow(
      'Please load AVR data first',
    );

    const { service: cramped } = createHarness({
      subs: [fakeSub('sw1')],
      config: { distanceLeftBeforeError: -1 },
    });
    expect(() => cramped.createOptimizerConfig(20, 200)).toThrow(
      'is too low. Please increase the distance left before error in settings.',
    );
  });

  it('builds the config from the sub headroom and app settings', () => {
    const { service } = createHarness({
      subs: [fakeSub('sw1')],
      config: { useAllPassFiltersForSubs: true },
    });

    const optimizerConfig = service.createOptimizerConfig(20, 200);

    expect(optimizerConfig.frequency).toEqual({ min: 20, max: 200 });
    expect(optimizerConfig.gain).toEqual({ min: 0, max: 0, step: 0.1 });
    expect(optimizerConfig.delay.max).toBeCloseTo(3 / 343, 4);
    expect(optimizerConfig.delay.min).toBeCloseTo(-3 / 343, 4);
    expect(optimizerConfig.delay.step).toBe(0.0001);
    expect(optimizerConfig.allPass.enabled).toBe(true);
  });
});

describe('applyOptimizedSubSettings', () => {
  it('applies polarity, delay, gain and the all-pass filter', async () => {
    const sub = fakeSub('sw1');
    const { service } = createHarness({ measurements: [sub] });

    await service.applyOptimizedSubSettings({
      measurement: 'sw1',
      param: {
        polarity: -1,
        delay: 0.001,
        gain: 0,
        allPass: { enabled: true, frequency: 60, q: 0.3 },
      },
    });

    expect(sub.setInverted).toHaveBeenCalledWith(true);
    expect(sub.addIROffsetSeconds).toHaveBeenCalledWith(0.001);
    expect(sub.addSPLOffsetDB).toHaveBeenCalledWith(0);
    expect(sub.setSingleFilter).toHaveBeenCalledWith({
      index: 20,
      enabled: true,
      isAuto: false,
      frequency: 60,
      q: 0.3,
      type: 'All pass',
    });
  });

  it('rejects unknown measurements and invalid polarities', async () => {
    const { service } = createHarness({ measurements: [] });

    await expect(
      service.applyOptimizedSubSettings({ measurement: 'ghost', param: {} }),
    ).rejects.toThrow('Measurement not found for ghost');

    const sub = fakeSub('sw1');
    await expect(service.applySubPolarity(sub, 0)).rejects.toThrow(
      'Invalid invert value',
    );
  });
});

describe('multiSubOptimizer guards', () => {
  it('requires at least two subs and the frequency bands', async () => {
    const { service: noSubs } = createHarness({ subs: [] });
    await expect(noSubs.multiSubOptimizer({})).rejects.toThrow('No subwoofers found');

    const { service: oneSub } = createHarness({ subs: [fakeSub('sw1')] });
    await expect(oneSub.multiSubOptimizer({})).rejects.toThrow(
      'Only one subwoofer found',
    );

    const { service } = createHarness({ subs: [fakeSub('sw1'), fakeSub('sw2')] });
    await expect(service.multiSubOptimizer(null)).rejects.toThrow(
      'Subwoofer frequency bands not defined',
    );
  });
});

describe('syncAllPredictedLfeMeasurement', () => {
  it('requires a selected predicted LFE', async () => {
    const { service } = createHarness();
    await expect(service.syncAllPredictedLfeMeasurement()).rejects.toThrow(
      'No LFE found, please use sum subs button',
    );
  });
});
