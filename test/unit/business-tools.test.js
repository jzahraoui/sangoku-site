import { describe, expect, it, vi } from 'vitest';
import { createBusinessTools } from '../../src/services/business-tools.js';

describe('createBusinessTools.createsSum', () => {
  function harness() {
    let uuidCounter = 0;
    const operations = {
      removeWorkingSettings: vi.fn().mockResolvedValue(true),
      resetTargetSettings: vi.fn().mockResolvedValue(true),
      applyWorkingSettings: vi.fn().mockResolvedValue(true),
      producePredictedMeasurement: vi
        .fn()
        .mockImplementation(async (_rew, m) => ({ uuid: `pred-${m.uuid}`, title: `predicted ${m.title}` })),
      arithmeticSum: vi
        .fn()
        .mockImplementation(async () => ({ uuid: `sum-${++uuidCounter}`, title: 'sum' })),
      setTitle: vi.fn().mockResolvedValue(true),
    };
    const session = {
      rewMeasurements: { id: 'rew' },
      analyseApiResponse: vi.fn(),
      removeMeasurements: vi.fn().mockResolvedValue(true),
      removeMeasurement: vi.fn(),
      removeMeasurementUuid: vi.fn(),
      findMeasurementByUuid: vi.fn(),
    };
    const tools = createBusinessTools({
      operations,
      session,
      workingSettingsConfig: () => ({ smoothingMethod: 'None' }),
      irWindowWidthsFor: () => ({ leftWindowWidthms: 70, rightWindowWidthms: 1000 }),
    });
    return { operations, session, tools };
  }

  it('folds predicted measurements into a titled sum and cleans up', async () => {
    const { operations, session, tools } = harness();
    const sw1 = { uuid: 's1', title: 'SW1avg' };
    const sw2 = { uuid: 's2', title: 'SW2avg' };

    const result = await tools.createsSum([sw1, sw2], 'LFE predicted_P1', true);

    expect(operations.producePredictedMeasurement).toHaveBeenCalledTimes(2);
    // predicted[0] summed with predicted[1]
    expect(operations.arithmeticSum).toHaveBeenCalledWith(
      session.rewMeasurements,
      { uuid: 'pred-s1', title: 'predicted SW1avg' },
      { uuid: 'pred-s2', title: 'predicted SW2avg' },
      expect.any(Object),
    );
    expect(operations.setTitle).toHaveBeenCalledWith(
      session.rewMeasurements,
      result,
      'LFE predicted_P1',
      'sum from:\nSW1avg\nSW2avg',
    );
    // intermediate + predicted cleaned up
    expect(session.removeMeasurements).toHaveBeenCalled();
  });

  it('rejects an empty list', async () => {
    const { tools } = harness();
    await expect(tools.createsSum([], 'x')).rejects.toThrow('non-empty array');
  });
});

describe('createBusinessTools.crossoverRequiredShiftSweep', () => {
  const SR = 48000;
  const makeIr = (peakSample = 200) => {
    const data = new Float64Array(4096);
    data[peakSample] = 1;
    return { data, sampleRate: SR, startTime: 0 };
  };

  function harness() {
    const operations = {
      getPredictedImpulseResponseInfo: vi
        .fn()
        .mockImplementation(async (_rew, m) =>
          makeIr(m.uuid === 'sub' ? 260 : 200),
        ),
    };
    const session = { rewMeasurements: { id: 'rew' } };
    const tools = createBusinessTools({ operations, session });
    return { operations, tools };
  }

  it('lit chaque IR predicted UNE fois puis balaie les candidats localement', async () => {
    const { operations, tools } = harness();
    const speaker = { uuid: 'FL', title: 'FL', splOffsetdB: 0 };
    const subs = [{ uuid: 'sub', title: 'SW', splOffsetdB: 0 }];

    const results = await tools.crossoverRequiredShiftSweep(
      speaker,
      null,
      subs,
      [60, 80, 100],
    );

    // 1 lecture pour l'enceinte + 1 pour le sub — PAS une lecture par candidat.
    expect(operations.getPredictedImpulseResponseInfo).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect([60, 80, 100]).toContain(r.frequency);
      expect(Number.isFinite(r.requiredDelayMs)).toBe(true);
      expect(typeof r.withinBounds).toBe('boolean');
      expect(typeof r.invertB).toBe('boolean');
    }
  });

  it('utilise le LFE prédictif en repli quand aucun sub réel', async () => {
    const { operations, tools } = harness();
    const speaker = { uuid: 'FL', title: 'FL' };
    const lfe = { uuid: 'lfe', title: 'LFE' };

    const results = await tools.crossoverRequiredShiftSweep(speaker, lfe, [], [80]);

    expect(operations.getPredictedImpulseResponseInfo).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);
  });

  it('lève si ni sub ni LFE ne sont disponibles', async () => {
    const { tools } = harness();
    await expect(
      tools.crossoverRequiredShiftSweep({ uuid: 'FL', title: 'FL' }, null, [], [80]),
    ).rejects.toThrow('Cannot find predicted LFE');
  });
});

describe('createBusinessTools.revertLfeFilterProccess', () => {
  function harness() {
    const filter = { uuid: 'lpf', title: 'lpf', isFilter: true };
    let divCount = 0;
    const operations = {
      getFilters: vi.fn().mockResolvedValue([]),
      setFilters: vi.fn().mockResolvedValue(true),
      generateFilterMeasurement: vi.fn().mockResolvedValue(filter),
      setInverted: vi.fn().mockResolvedValue(true),
      setcumulativeIRShiftSeconds: vi.fn().mockResolvedValue(true),
      setTitle: vi.fn().mockResolvedValue(true),
      arithmeticADividedByB: vi
        .fn()
        .mockImplementation(async () => ({ uuid: `div-${++divCount}`, title: 'div' })),
    };
    const session = {
      rewMeasurements: { id: 'rew' },
      analyseApiResponse: vi.fn(),
      removeMeasurements: vi.fn().mockResolvedValue(true),
      removeMeasurement: vi.fn().mockResolvedValue(true),
      removeMeasurementUuid: vi.fn(),
      findMeasurementByUuid: vi.fn(),
    };
    const tools = createBusinessTools({ operations, session });
    return { operations, session, tools, filter };
  }

  it('divides each sub by the low-pass filter and titles the result', async () => {
    const { operations, session, tools, filter } = harness();
    const sw1 = { uuid: 's1', title: 'SW1avg', inverted: false, cumulativeIRShiftSeconds: 0, splOffsetdB: 0, initialSplOffsetdB: 0 };

    await tools.revertLfeFilterProccess([sw1], 80, false, true);

    // low-pass filter generated once from the first sub
    expect(operations.generateFilterMeasurement).toHaveBeenCalledTimes(1);
    // A / B division with cutoff at 2×freq
    expect(operations.arithmeticADividedByB).toHaveBeenCalledWith(
      session.rewMeasurements,
      sw1,
      filter,
      expect.any(Object),
      null,
      null,
      160,
    );
    expect(operations.setTitle).toHaveBeenCalledWith(
      session.rewMeasurements,
      expect.objectContaining({ uuid: 'div-1' }),
      'SW1avg w/o LPF',
    );
    // temporary low-pass filter cleaned up
    expect(session.removeMeasurement).toHaveBeenCalledWith(filter);
  });

  it('skips subs already reverted (drops the previous results)', async () => {
    const { session, tools } = harness();
    const reverted = { uuid: 'r1', title: 'SW1avg w/o LPF', inverted: false, cumulativeIRShiftSeconds: 0, splOffsetdB: 0, initialSplOffsetdB: 0 };
    const orig = { uuid: 's1', title: 'SW1avg', inverted: false, cumulativeIRShiftSeconds: 0, splOffsetdB: 0, initialSplOffsetdB: 0 };

    await tools.revertLfeFilterProccess([orig, reverted], 80, false, true);

    expect(session.removeMeasurements).toHaveBeenCalledWith([reverted]);
  });
});

describe('createBusinessTools.produceAligned / applyCutOffFilter', () => {
  function harness({ isBInverted = false, shiftDelay = 0.0001 } = {}) {
    const predicted = (m, i) => ({
      uuid: `pred-${m.uuid}`,
      title: `pred ${m.title}`,
      // filtered LFE peaks a touch later than the speaker, so finalDistance < 0
      timeOfIRPeakSeconds: i === 'lfe' ? 0.002 : 0.001,
      position: 1,
    });
    const operations = {
      producePredictedMeasurement: vi
        .fn()
        .mockImplementation(async (_rew, m) => predicted(m, m.role)),
      responseCopy: vi.fn().mockImplementation(async (_rew, m) => ({ uuid: `copy-${m.uuid}` })),
      resetEqualiser: vi.fn().mockResolvedValue(true),
      getFreeXFilterIndex: vi.fn().mockResolvedValue(20),
      setSingleFilter: vi.fn().mockResolvedValue(true),
      addIROffsetSeconds: vi.fn().mockResolvedValue(true),
      toggleInversion: vi.fn().mockResolvedValue(true),
      // IR filtrée interne : le LFE pique un peu après l'enceinte
      getCrossoverFilteredIr: vi.fn().mockImplementation(async (_rew, m) => ({
        data: new Float64Array(8),
        sampleRate: 48000,
        startTime: 0,
        timeOfIRPeakSeconds: m.role === 'lfe' ? 0.002 : 0.001,
      })),
      // somme vraie des subs (même pic que le LFE projeté dans ces tests)
      getCombinedSubsCrossoverFilteredIr: vi.fn().mockResolvedValue({
        data: new Float64Array(8),
        sampleRate: 48000,
        startTime: 0,
        timeOfIRPeakSeconds: 0.002,
      }),
    };
    const session = {
      rewMeasurements: { id: 'rew' },
      findMeasurementByUuid: vi.fn(),
      removeMeasurementUuid: vi.fn(),
      removeMeasurements: vi.fn().mockResolvedValue(true),
      removeMeasurement: vi.fn().mockResolvedValue(true),
    };
    const predictedLfe = { uuid: 'lfe', title: 'LFE predicted', role: 'lfe', haveImpulseResponse: true };
    const findAligment = vi.fn().mockResolvedValue({ shiftDelay, isBInverted });
    const tools = createBusinessTools({
      operations,
      session,
      crossoverForSpeaker: () => 80,
      relatedLfeFor: () => predictedLfe,
      subDistanceLeftBeforeError: () => Infinity,
      speedOfSound: () => 343,
      findAligment,
    });
    return { operations, session, tools, findAligment, predictedLfe };
  }

  it('alignmentGapSeconds measures the crossover-filtered peak gap internally', async () => {
    const { operations, tools, session } = harness();
    const speaker = { uuid: 'fl', title: 'FL', role: 'spk' };

    const gap = await tools.alignmentGapSeconds(speaker);

    // filtered LFE peak (0.002) minus filtered speaker peak (0.001)
    expect(gap).toBeCloseTo(0.001, 6);
    // internal path: HP BU12 on the speaker, LP LR24 on the LFE — no REW
    // temporary measurement, nothing to clean up.
    expect(operations.getCrossoverFilteredIr).toHaveBeenCalledWith(
      session.rewMeasurements,
      speaker,
      expect.objectContaining({ type: 'High pass', frequency: 80, shape: 'BU' }),
    );
    expect(operations.getCrossoverFilteredIr).toHaveBeenCalledWith(
      session.rewMeasurements,
      expect.objectContaining({ uuid: 'lfe' }),
      expect.objectContaining({ type: 'Low pass', frequency: 80, shape: 'L-R' }),
    );
    expect(session.removeMeasurements).not.toHaveBeenCalled();
  });

  it('alignmentGapSeconds returns null without a predicted LFE', async () => {
    const tools = createBusinessTools({
      operations: {},
      session: { rewMeasurements: {}, removeMeasurements: vi.fn() },
      relatedLfeFor: () => null,
      crossoverForSpeaker: () => 80,
    });

    await expect(tools.alignmentGapSeconds({ uuid: 'fl' })).resolves.toBeNull();
  });

  it('applyCutOffFilter short-circuits to response copies at 0Hz', async () => {
    const { operations, tools } = harness();
    const sub = { uuid: 's' };
    const speaker = { uuid: 'fl' };

    const result = await tools.applyCutOffFilter(sub, speaker, 0);

    expect(result).toEqual({
      PredictedLfeFiltered: { uuid: 'copy-s' },
      predictedSpeakerFiltered: { uuid: 'copy-fl' },
    });
    expect(operations.setSingleFilter).not.toHaveBeenCalled();
  });

  it('applyCutOffFilter sets the LR24/BU12 pair then restores to None', async () => {
    const { operations, tools } = harness();
    const sub = { uuid: 's', role: 'lfe' };
    const speaker = { uuid: 'fl', role: 'spk' };

    await tools.applyCutOffFilter(sub, speaker, 80);

    // Low pass on the sub + High pass on the speaker, then two None resets
    expect(operations.setSingleFilter).toHaveBeenCalledTimes(4);
    expect(operations.setSingleFilter.mock.calls[0][2]).toMatchObject({
      type: 'Low pass',
      frequency: 80,
      shape: 'L-R',
      slopedBPerOctave: 24,
    });
    expect(operations.setSingleFilter.mock.calls[1][2]).toMatchObject({
      type: 'High pass',
      frequency: 80,
      shape: 'BU',
      slopedBPerOctave: 12,
    });
    expect(operations.setSingleFilter.mock.calls[2][2]).toMatchObject({ type: 'None' });
    expect(operations.setSingleFilter.mock.calls[3][2]).toMatchObject({ type: 'None' });
  });

  it('produceAligned aligns the LFE and subs without REW temporaries', async () => {
    const { operations, session, tools, findAligment, predictedLfe } = harness();
    const speaker = { uuid: 'fl', title: 'FL', role: 'spk', haveImpulseResponse: true };
    const subs = [{ uuid: 'sw1' }, { uuid: 'sw2' }];

    await tools.produceAligned(speaker, subs);

    // findAligment runs on the internally filtered speaker/LFE IR pair at the
    // crossover — the channels carry a precomputed `ir`, no REW measurement.
    expect(findAligment).toHaveBeenCalledWith(
      expect.objectContaining({ ir: expect.objectContaining({ sampleRate: 48000 }) }),
      expect.objectContaining({ ir: expect.objectContaining({ sampleRate: 48000 }) }),
      80,
      expect.any(Number),
      false,
      expect.any(String),
      0,
    );
    // the temporary pre-alignment shift lives on the internal IR only: the
    // filtered LFE startTime moved by -finalDistance before the search
    const lfeChannel = findAligment.mock.calls[0][1];
    expect(lfeChannel.ir.startTime).toBeLessThan(0);
    // the final offset is applied on the real LFE record
    expect(operations.addIROffsetSeconds).toHaveBeenCalledWith(
      session.rewMeasurements,
      predictedLfe,
      expect.any(Number),
    );
    // every sub is shifted by the same offset
    expect(operations.addIROffsetSeconds).toHaveBeenCalledWith(
      session.rewMeasurements,
      subs[0],
      expect.any(Number),
    );
    expect(operations.addIROffsetSeconds).toHaveBeenCalledWith(
      session.rewMeasurements,
      subs[1],
      expect.any(Number),
    );
    // no inversion for this run
    expect(operations.toggleInversion).not.toHaveBeenCalled();
    // internal path: no predicted measurement generated, nothing removed
    expect(operations.producePredictedMeasurement).not.toHaveBeenCalled();
    expect(session.removeMeasurements).not.toHaveBeenCalled();
    // the LFE side is the TRUE weighted sum of the real subs, not the projection
    expect(operations.getCombinedSubsCrossoverFilteredIr).toHaveBeenCalledWith(
      session.rewMeasurements,
      subs,
      expect.objectContaining({ type: 'Low pass', frequency: 80 }),
    );
  });

  it('produceAligned toggles polarity when the alignment tool reports inversion', async () => {
    const { operations, tools } = harness({ isBInverted: true });
    const speaker = { uuid: 'fl', title: 'FL', role: 'spk', haveImpulseResponse: true };
    const subs = [{ uuid: 'sw1' }];

    await tools.produceAligned(speaker, subs);

    // predicted LFE toggled once + each sub toggled by applyTimeOffsetToSubs
    expect(operations.toggleInversion).toHaveBeenCalledTimes(2);
  });

  it('produceAligned rejects an out-of-range crossover', async () => {
    const speaker = { uuid: 'fl', title: 'FL', role: 'spk', haveImpulseResponse: true };
    const bad = createBusinessTools({
      operations: {},
      session: { removeMeasurements: vi.fn() },
      crossoverForSpeaker: () => 10, // below the 20Hz floor
      relatedLfeFor: () => ({ haveImpulseResponse: true }),
    });
    await expect(bad.produceAligned(speaker, [])).rejects.toThrow('between 20Hz and 250Hz');
  });
});
