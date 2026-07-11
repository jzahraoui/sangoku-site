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

function createHarness({
  subs = [],
  measurements = [],
  config = {},
  virtualSubwoofers = null,
  groupedSubs = null,
} = {}) {
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
    virtualSubwoofers,
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
      byPositionsGroupedSubsMeasurements: () => groupedSubs ?? { 1: subs },
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

describe('projection du sub virtuel (ADR 003)', () => {
  it('equalizeSubs equalizes the projection then distributes via the group command', async () => {
    const projection = fakeSub('proj', { title: () => 'LFE predicted_P1' });
    const bridge = {
      refresh: vi.fn().mockResolvedValue(projection),
      setFilters: vi.fn().mockResolvedValue([projection]),
    };
    const subs = [fakeSub('sw1'), fakeSub('sw2')];
    const { service } = createHarness({ subs, virtualSubwoofers: bridge });

    await service.equalizeSubs();

    expect(bridge.refresh).toHaveBeenCalledWith(1, {});
    expect(projection._runPhaseMatchFilter).toHaveBeenCalledOnce();
    // The EQ of the projection is distributed by the virtual sub command,
    // which also recomputes the projections.
    expect(bridge.setFilters).toHaveBeenCalledWith([{ index: 1, type: 'PK' }], {
      position: 1,
    });
    for (const sub of subs) {
      expect(sub.copyFiltersToOther).toHaveBeenCalledOnce();
    }
  });

  it('equalizeSubs routes a single sub through the same projection path', async () => {
    const projection = fakeSub('proj', { title: () => 'LFE predicted_P1' });
    const bridge = {
      refresh: vi.fn().mockResolvedValue(projection),
      setFilters: vi.fn().mockResolvedValue([projection]),
    };
    const sub = fakeSub('sw1');
    const { service } = createHarness({ subs: [sub], virtualSubwoofers: bridge });

    await service.equalizeSubs();

    expect(projection._runPhaseMatchFilter).toHaveBeenCalledOnce();
    expect(sub._runPhaseMatchFilter).not.toHaveBeenCalled();
    expect(bridge.setFilters).toHaveBeenCalledWith([{ index: 1, type: 'PK' }], {
      position: 1,
    });
  });

  it('equalizeSubs throws when the projection cannot be produced', async () => {
    const bridge = { refresh: vi.fn().mockResolvedValue(null) };
    const { service } = createHarness({
      subs: [fakeSub('sw1')],
      virtualSubwoofers: bridge,
    });

    await expect(service.equalizeSubs()).rejects.toThrow('No subwoofer found');
  });

  it('multiSubOptimizer with one sub refreshes the projection instead of throwing', async () => {
    const bridge = { refresh: vi.fn().mockResolvedValue(fakeSub('proj')) };
    const { service } = createHarness({
      subs: [fakeSub('sw1')],
      virtualSubwoofers: bridge,
    });

    await service.multiSubOptimizer({});

    expect(bridge.refresh).toHaveBeenCalledWith(1, { force: true });
  });
});

describe('equalizeSub — garde des bornes', () => {
  it('rejects a detected band that does not overlap the configured bounds', async () => {
    const sub = fakeSub('sw1', {
      detectFallOff: vi.fn().mockResolvedValue({ lowHz: 600, highHz: 800 }),
    });
    const { service } = createHarness({ subs: [sub] });

    await expect(service.equalizeSub(sub)).rejects.toThrow('does not overlap');
    expect(sub._runPhaseMatchFilter).not.toHaveBeenCalled();
  });
});

describe('produceAligned via le sub virtuel (ADR 003 v2)', () => {
  function bridgeWithCapture(projection) {
    const forEachCalls = [];
    return {
      bridge: {
        refresh: vi.fn().mockResolvedValue(projection),
        refreshProjected: vi.fn().mockResolvedValue([]),
        setFilters: vi.fn().mockResolvedValue([]),
        forEachSub: vi.fn().mockImplementation(async (fn, options) => {
          forEachCalls.push({ fn, options });
        }),
      },
      forEachCalls,
    };
  }

  it('propagates the found alignment to the other positions then recomputes', async () => {
    const projection = fakeSub('proj', { title: () => 'LFE predicted_P1' });
    const { bridge, forEachCalls } = bridgeWithCapture(projection);
    const sw1 = fakeSub('sw1');
    const sw2p2 = fakeSub('sw2p2', { position: () => 2, inverted: () => false });
    const { service, businessTools } = createHarness({
      subs: [sw1],
      virtualSubwoofers: bridge,
      groupedSubs: { 1: [sw1], 2: [sw2p2] },
    });
    businessTools.produceAligned.mockResolvedValue({
      offsetSeconds: 0.002,
      inverted: true,
    });

    await service.produceAligned(fakeSub('FL'));

    // Projection ensured before the alignment, recompute after.
    expect(bridge.refresh).toHaveBeenCalledWith(1, {});
    expect(bridge.refreshProjected).toHaveBeenCalledWith({ force: true });

    // Only the OTHER position receives the offset + inversion toggle.
    expect(forEachCalls).toHaveLength(1);
    expect(forEachCalls[0].options).toEqual({ position: '2' });
    const vmops = {
      addIROffsetSeconds: vi.fn().mockResolvedValue(true),
      setInverted: vi.fn().mockResolvedValue(true),
    };
    await forEachCalls[0].fn(vmops, sw2p2);
    expect(vmops.addIROffsetSeconds).toHaveBeenCalledWith(sw2p2, 0.002);
    expect(vmops.setInverted).toHaveBeenCalledWith(sw2p2, true);
  });

  it('skips the propagation when no alignment result is returned', async () => {
    const projection = fakeSub('proj');
    const { bridge } = bridgeWithCapture(projection);
    const { service, businessTools } = createHarness({
      subs: [fakeSub('sw1')],
      virtualSubwoofers: bridge,
      groupedSubs: { 1: [fakeSub('sw1')], 2: [fakeSub('sw2p2')] },
    });
    businessTools.produceAligned.mockResolvedValue(undefined);

    await service.produceAligned(fakeSub('FL'));

    expect(bridge.forEachSub).not.toHaveBeenCalled();
    expect(bridge.refreshProjected).toHaveBeenCalledWith({ force: true });
  });

  it('reserves the all-pass slot on the projection before equalizing', async () => {
    const projection = fakeSub('proj', { title: () => 'LFE predicted_P1' });
    const bridge = {
      refresh: vi.fn().mockResolvedValue(projection),
      setFilters: vi.fn().mockResolvedValue([projection]),
    };
    const { service } = createHarness({
      subs: [fakeSub('sw1'), fakeSub('sw2')],
      virtualSubwoofers: bridge,
      config: { useAllPassFiltersForSubs: true },
    });

    await service.equalizeSubs();

    expect(projection.setSingleFilter).toHaveBeenCalledWith({
      index: 20,
      enabled: true,
      isAuto: false,
      type: 'None',
    });
  });
});

describe('createOptimizerConfig — budget de délai (fenêtre AVR)', () => {
  const withDistance = (uuid, overrides = {}) =>
    fakeSub(uuid, { timeOfIRPeakSeconds: () => 0, ...overrides });

  it('keeps the historical symmetric bounds without the list providers', () => {
    const sub = withDistance('sw1');
    const { service } = createHarness({ subs: [sub], config: { distanceLeftBeforeError: 3.43 } });

    const optimizerConfig = service.createOptimizerConfig(20, 200);

    expect(optimizerConfig.delay.max).toBeCloseTo(0.01, 4);
    expect(optimizerConfig.delay.min).toBeCloseTo(-0.01, 4);
  });

  it('anchors the negative bound on the closest channel', () => {
    // Subs sit 1.03 ms above the closest channel: they may only come down
    // that far, whatever the remaining headroom is.
    const sub1 = withDistance('sw1', { cumulativeIRShiftSeconds: () => 0.005 });
    const sub2 = withDistance('sw2', { cumulativeIRShiftSeconds: () => 0.007 });
    const speaker = withDistance('FL', { cumulativeIRShiftSeconds: () => 0.00397 });
    const service = createSubOptimizationService({
      session: {},
      businessTools: {},
      config: { distanceLeftBeforeError: 3.43, jsonAvrData: { avr: { minDistAccuracy: 0.00001 } } },
      lists: {
        uniqueSubsMeasurements: () => [sub1, sub2],
        predictedLfeMeasurements: () => [],
        selectedPredictedLfeMeasurement: () => null,
        uniqueMeasurements: () => [speaker, sub1, sub2],
        frontSpeakersMeasurements: () => [],
      },
    });

    const optimizerConfig = service.createOptimizerConfig(20, 200);

    expect(optimizerConfig.delay.min).toBeCloseTo(-(0.005 - 0.00397), 4);
    expect(optimizerConfig.delay.max).toBeCloseTo(0.01, 4);
  });

  it('reserves the alignment latitude from the worst-case front-speaker peak gap', () => {
    // Sub group peak 6 ms after the worst front: the later group alignment
    // will need that much positive budget — the optimizer must not spend it.
    const sub = withDistance('sw1', { timeOfIRPeakSeconds: () => 0.006 });
    const sub2 = withDistance('sw2');
    const fl = withDistance('FL', { timeOfIRPeakSeconds: () => 0.002 });
    const center = withDistance('C', { timeOfIRPeakSeconds: () => 0 });
    const service = createSubOptimizationService({
      session: {},
      businessTools: {},
      config: { distanceLeftBeforeError: 3.43, jsonAvrData: { avr: { minDistAccuracy: 0.00001 } } },
      lists: {
        uniqueSubsMeasurements: () => [sub, sub2],
        predictedLfeMeasurements: () => [],
        selectedPredictedLfeMeasurement: () => null,
        uniqueMeasurements: () => [fl, center, sub, sub2],
        frontSpeakersMeasurements: () => [fl, center],
      },
    });

    const optimizerConfig = service.createOptimizerConfig(20, 200);

    // max = headroom (10 ms) − pire écart tardif (6 ms vs C)
    expect(optimizerConfig.delay.max).toBeCloseTo(0.004, 4);
    // ancre : subs déjà au niveau du canal le plus proche → 0 de latitude basse
    expect(optimizerConfig.delay.min).toBeCloseTo(0, 4);
  });

  it('reserves the anchor side when the sub group is EARLY vs the fronts', () => {
    const sub = withDistance('sw1', {
      timeOfIRPeakSeconds: () => 0,
      cumulativeIRShiftSeconds: () => 0.008,
    });
    const fl = withDistance('FL', {
      timeOfIRPeakSeconds: () => 0.005,
      cumulativeIRShiftSeconds: () => 0.002,
    });
    const service = createSubOptimizationService({
      session: {},
      businessTools: {},
      config: { distanceLeftBeforeError: 3.43, jsonAvrData: { avr: { minDistAccuracy: 0.00001 } } },
      lists: {
        uniqueSubsMeasurements: () => [sub, withDistance('sw2', { cumulativeIRShiftSeconds: () => 0.009 })],
        predictedLfeMeasurements: () => [],
        selectedPredictedLfeMeasurement: () => null,
        uniqueMeasurements: () => [fl, sub],
        frontSpeakersMeasurements: () => [fl],
      },
    });

    const optimizerConfig = service.createOptimizerConfig(20, 200);

    // marge d'ancre 6 ms, réduite par la réserve « en avance » de 5 ms
    expect(optimizerConfig.delay.min).toBeCloseTo(-0.001, 4);
    expect(optimizerConfig.delay.max).toBeCloseTo(0.01, 4);
  });
});

describe('createOptimizerConfig — écarts mesurés (LFE predicted filtrée)', () => {
  it('prefers the measured alignment gaps over the raw peak fallback', () => {
    const sub = fakeSub('sw1', { timeOfIRPeakSeconds: () => 0.001 });
    const fl = fakeSub('FL', { timeOfIRPeakSeconds: () => 0.001 });
    const service = createSubOptimizationService({
      session: {},
      businessTools: {},
      config: { distanceLeftBeforeError: 3.43, jsonAvrData: { avr: { minDistAccuracy: 0.00001 } } },
      lists: {
        uniqueSubsMeasurements: () => [sub, fakeSub('sw2')],
        predictedLfeMeasurements: () => [],
        selectedPredictedLfeMeasurement: () => null,
        uniqueMeasurements: () => [fl, sub],
        frontSpeakersMeasurements: () => [fl], // écart brut = 0
      },
    });

    // Écart mesuré (filtré) de 6 ms — c'est lui qui doit dimensionner la réserve.
    const optimizerConfig = service.createOptimizerConfig(20, 200, {
      alignmentGapsSeconds: [0.006, Number.NaN],
    });

    expect(optimizerConfig.delay.max).toBeCloseTo(0.01 - 0.006, 4);
  });
});

describe('equalizeSub rch sur le chemin operations (ADR 002)', () => {
  it('route vers operations.runPhaseMatchFilter avec un contexte calculateur', async () => {
    const operations = {
      setTargetLevel: vi.fn().mockResolvedValue(true),
      applyWorkingSettings: vi.fn().mockResolvedValue(true),
      resetTargetSettings: vi.fn().mockResolvedValue(true),
      detectFallOff: vi.fn().mockResolvedValue({ lowHz: 25, highHz: 150 }),
      checkFilterGain: vi.fn().mockResolvedValue(true),
      runPhaseMatchFilter: vi.fn().mockResolvedValue(true),
    };
    const session = { rewMeasurements: { id: 'rew' } };
    const autoEqFixture = {
      numFilters: 20,
      maxCutDb: 15,
      flatnessTarget: 0.3,
      numOptimizationPasses: 20,
      gainSignLockThreshold: 0.5,
      notchExclusionThreshold: 6,
      minFilterGain: 0.4,
      enableBeatRewOptimization: true,
      enableCandidatePlacement: true,
      enableReduceRepair: true,
      enableCriticalBandRefinement: true,
      enableRefinement: false,
      refinementIterations: 100,
      varyQAbove200Hz: false,
      allowNarrowFiltersBelow200Hz: true,
      allowBoosts: true,
    };
    const service = createSubOptimizationService({
      session,
      businessTools: {},
      operations,
      autoEqConfig: () => autoEqFixture,
      config: {
        mainTargetLevel: 75,
        selectedEqualizationMode: 'rch',
        lowerFrequencyBoundSub: 10,
        upperFrequencyBoundSub: 500,
        maxBoostIndividualValue: 6,
        maxBoostOverallValue: 3,
        jsonAvrData: { avr: { minDistAccuracy: 0.0001 } },
      },
      lists: {
        uniqueSubsMeasurements: () => [],
        predictedLfeMeasurements: () => [],
        selectedPredictedLfeMeasurement: () => null,
      },
    });
    const record = { uuid: 'proj', title: 'LFE predicted_P1' };

    await service.equalizeSub(record);

    expect(operations.runPhaseMatchFilter).toHaveBeenCalledTimes(1);
    const [rew, m, ctx, start, end, options] =
      operations.runPhaseMatchFilter.mock.calls[0];
    expect(rew).toBe(session.rewMeasurements);
    expect(m).toBe(record);
    expect(start).toBe(25);
    expect(end).toBe(150);
    expect(options).toEqual({
      individualMaxBoostDb: 6,
      overallMaxBoostDb: 3,
    });
    const calculator = ctx.createCalculator(48000, start, end, options);
    expect(typeof calculator.calculate).toBe('function');
    expect(calculator.overallMaxBoostDb).toBe(3);
  });
});

describe('multiSubOptimizer joint route (target-match)', () => {
  function syntheticFrequencyResponse({ level = 80, delayMs = 0 } = {}) {
    const ppo = 24;
    const freqs = [];
    let f = 20;
    while (freqs.length < 72) {
      freqs.push(f);
      f *= Math.pow(2, 1 / ppo);
    }
    const phase = freqs.map(freq => {
      const deg = -360 * freq * (delayMs / 1000);
      return ((deg + 180) % 360 + 360) % 360 - 180;
    });
    return {
      freqs,
      magnitude: new Float32Array(freqs.length).fill(level),
      phase: Float32Array.from(phase),
      freqStep: Math.pow(2, 1 / ppo),
      ppo,
    };
  }

  function jointSub(uuid, frequencyResponse) {
    return fakeSub(uuid, {
      resetFilters: vi.fn().mockResolvedValue(undefined),
      getFrequencyResponse: vi.fn().mockResolvedValue({ ...frequencyResponse }),
      getTargetResponse: vi
        .fn()
        .mockResolvedValue({ freqs: [10, 400], magnitude: [86, 86] }),
    });
  }

  function createJointHarness() {
    const sub1 = jointSub('sw1', syntheticFrequencyResponse());
    const sub2 = jointSub('sw2', syntheticFrequencyResponse({ delayMs: 2 }));
    const harness = createHarness({
      subs: [sub1, sub2],
      measurements: [sub1, sub2],
      config: {
        useJointSubOptimization: true,
        jointOptimizerBudget: {
          filtersPerSub: 1,
          populationSize: 8,
          alignmentGenerations: 6,
          generations: 8,
          patience: 20,
        },
      },
    });
    harness.session.addMeasurementFromRewOperation.mockImplementation(
      async operation => {
        await operation();
        return fakeSub('created-sum');
      },
    );
    return { ...harness, sub1, sub2 };
  }

  it('runs the joint solver and applies per-sub settings including PK filters', async () => {
    const { service, session, sub1, sub2 } = createJointHarness();
    // A leftover trim from a previous joint run must be reverted — and ONLY
    // it: the user's manual +/- level adjustments live in the same SPL
    // offset and must survive, hence the exact-amount bookkeeping.
    sub2.jointGainDb = -4;

    await service.multiSubOptimizer({ lowFrequency: 20, highFrequency: 150 });

    expect(sub2.addSPLOffsetDB).toHaveBeenCalledWith(4);
    expect(sub2.addSPLOffsetDB.mock.invocationCallOrder[0]).toBeLessThan(
      sub2.getFrequencyResponse.mock.invocationCallOrder[0],
    );
    // Bookkeeping refreshed: either cleared (no new trim) or set to the new
    // trim — never left at the stale value.
    expect(sub2.jointGainDb).not.toBe(-4);

    // Target curve anchored on the first sub, like equalize-sub anchors REW.
    expect(sub1.setTargetLevel).toHaveBeenCalledWith(75);
    expect(sub1.getTargetResponse).toHaveBeenCalledWith('SPL', 96);

    // Every sub (reference included) receives its alignment writes.
    for (const sub of [sub1, sub2]) {
      expect(sub.addIROffsetSeconds).toHaveBeenCalled();
      expect(sub.addSPLOffsetDB).toHaveBeenCalled();
      expect(sub.setInverted).toHaveBeenCalled();
    }

    // Per-sub PK filters land in slot 1 (filtersPerSub = 1), non-auto so a
    // later shared write with overwrite=false leaves them alone.
    const pkWrites = [sub1, sub2].flatMap(sub =>
      sub.setSingleFilter.mock.calls.filter(([filter]) => filter.type === 'PK'),
    );
    expect(pkWrites.length).toBeGreaterThan(0);
    for (const [filter] of pkWrites) {
      expect(filter).toMatchObject({ index: 1, enabled: true, isAuto: false });
      expect(filter.frequency).toBeGreaterThan(0);
      expect(filter.q).toBeGreaterThan(0);
      // REW's filter gain field is `gaindB`: a `gain` key is silently ignored
      // and the filter stays flat (bug observed on a live REW).
      expect(typeof filter.gaindB).toBe('number');
      expect(filter).not.toHaveProperty('gain');
    }

    // Legacy surface (no virtual subwoofers): the maximised sum and its Theo
    // reference are imported into REW.
    expect(session.addMeasurementFromRewOperation).toHaveBeenCalledTimes(2);
  });

  it('keeps the legacy path when the joint toggle is off', async () => {
    const sub1 = jointSub('sw1', syntheticFrequencyResponse());
    const sub2 = jointSub('sw2', syntheticFrequencyResponse({ delayMs: 2 }));
    const harness = createHarness({
      subs: [sub1, sub2],
      measurements: [sub1, sub2],
      config: { useJointSubOptimization: false },
    });
    harness.session.addMeasurementFromRewOperation.mockImplementation(
      async operation => {
        await operation();
        return fakeSub('created-sum');
      },
    );

    await harness.service.multiSubOptimizer({ lowFrequency: 20, highFrequency: 150 });

    // The joint-only target fetch must not happen on the legacy path.
    expect(sub1.getTargetResponse).not.toHaveBeenCalled();
    expect(sub1.setInverted).toHaveBeenCalled();
  });
});
