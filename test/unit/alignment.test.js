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

function createHarness(overrides = {}) {
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
  const crossoverFilteredIrPair = vi.fn();
  const service = createAlignmentService({
    session,
    crossoverFilteredIrPair,
    setTargetLevelFromMeasurement: vi.fn().mockResolvedValue(75),
    getPredictedLfeMeasurements: () => [],
    ...overrides,
  });
  return { session, service, crossoverFilteredIrPair };
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

describe('findBestCrossover (choix du crossover par groupe)', () => {
  const makeMember = uuid => ({ uuid, title: uuid, crossover: () => 80 });

  const makeService = sweepByMember =>
    createAlignmentService({
      session: { rewMeasurements: {} },
      crossoverFilteredIrPair: vi.fn(),
      setTargetLevelFromMeasurement: vi.fn(),
      relatedLfeFor: () => ({ uuid: 'lfe' }),
      relatedSubsFor: () => [{ uuid: 'sub', splOffsetdB: 0 }],
      crossoverRequiredShiftSweep: vi.fn(member =>
        Promise.resolve(sweepByMember[member.uuid]),
      ),
    });

  it('retient le crossover à la plus faible moyenne des |required shift|', async () => {
    // Enceintes pré-alignées → shifts FL/FR proches à un crossover donné.
    // Moyennes |shift| : 60→(0.5+0.5)/2=0.50, 80→(0.15+0.2)/2=0.175,
    // 100→(0.4+0.35)/2=0.375 → 80 gagne (raccord de groupe le plus serré au sub fixe).
    const sweepFL = [
      { frequency: 60, requiredDelayMs: 0.5, delayMs: 0.5, withinBounds: true },
      { frequency: 80, requiredDelayMs: 0.15, delayMs: 0.15, withinBounds: true },
      { frequency: 100, requiredDelayMs: 0.4, delayMs: 0.4, withinBounds: true },
    ];
    const sweepFR = [
      { frequency: 60, requiredDelayMs: 0.5, delayMs: 0.5, withinBounds: true },
      { frequency: 80, requiredDelayMs: 0.2, delayMs: 0.2, withinBounds: true },
      { frequency: 100, requiredDelayMs: 0.35, delayMs: 0.35, withinBounds: true },
    ];
    const service = makeService({ FL: sweepFL, FR: sweepFR });

    const { bestFrequency, table } = await service.findBestCrossover(
      [makeMember('FL'), makeMember('FR')],
      [60, 80, 100],
    );

    expect(bestFrequency).toBe(80);
    expect(table.find(r => r.fc === 80).mean).toBeCloseTo(0.175, 6);
    expect(table.find(r => r.fc === 100).mean).toBeCloseTo(0.375, 6);
  });

  it('moyenne sur les valeurs ABSOLUES : deux shifts opposés ne s’annulent pas', async () => {
    const sweepFL = [
      { frequency: 80, requiredDelayMs: 0.5, delayMs: 0.5, withinBounds: true },
    ];
    const sweepFR = [
      { frequency: 80, requiredDelayMs: -0.5, delayMs: -0.5, withinBounds: true },
    ];
    const service = makeService({ FL: sweepFL, FR: sweepFR });

    const { table } = await service.findBestCrossover(
      [makeMember('FL'), makeMember('FR')],
      [80],
    );

    // Moyenne SIGNÉE = 0 ; moyenne des |shift| = 0.5 (pas de compensation).
    expect(table.find(r => r.fc === 80).mean).toBeCloseTo(0.5, 6);
  });

  it('classe sur le delayMs BORNÉ, pas sur le requiredDelayMs libre (sauts de cycle)', async () => {
    // Reproduit le bug : le pic libre saute d'un cycle (grande valeur), mais le
    // delayMs borné (checkAlignment / UI) est petit → c'est lui qui compte.
    // 120Hz : delayMs = (0, −0.36) → mean 0.18 (le meilleur).
    // 250Hz : requiredDelayMs plus petit (−2.5) MAIS delayMs borné ~0.9 → mean 0.9.
    const sweepFL = [
      { frequency: 120, requiredDelayMs: -8.635, delayMs: -0.36, withinBounds: true },
      { frequency: 250, requiredDelayMs: -3.705, delayMs: 0.95, withinBounds: true },
    ];
    const sweepFR = [
      { frequency: 120, requiredDelayMs: -4.075, delayMs: 0.0, withinBounds: true },
      { frequency: 250, requiredDelayMs: -2.562, delayMs: 0.85, withinBounds: true },
    ];
    const service = makeService({ FL: sweepFL, FR: sweepFR });

    const { bestFrequency, table } = await service.findBestCrossover(
      [makeMember('FL'), makeMember('FR')],
      [120, 250],
    );

    expect(table.find(r => r.fc === 120).mean).toBeCloseTo(0.18, 6);
    expect(table.find(r => r.fc === 250).mean).toBeCloseTo(0.9, 6);
    // Si on classait sur requiredDelayMs, 250 gagnerait (2.5<4) — le bug. Ici 120.
    expect(bestFrequency).toBe(120);
  });

  it('écarte un membre hors bornes même avec un delayMs fini (Delay too large)', async () => {
    const sweepFL = [
      { frequency: 60, requiredDelayMs: 0.05, delayMs: 0.05, withinBounds: true },
      { frequency: 80, requiredDelayMs: 0.2, delayMs: 0.2, withinBounds: true },
    ];
    const sweepFR = [
      // delayMs fini (clampé) mais withinBounds=false → traité comme Infinity.
      { frequency: 60, requiredDelayMs: 5.0, delayMs: 1.0, withinBounds: false },
      { frequency: 80, requiredDelayMs: 0.25, delayMs: 0.25, withinBounds: true },
    ];
    const service = makeService({ FL: sweepFL, FR: sweepFR });

    const { bestFrequency, table } = await service.findBestCrossover(
      [makeMember('FL'), makeMember('FR')],
      [60, 80],
    );

    // 60Hz écarté (FR hors bornes → ∞) malgré delayMs=1.0 fini → 80.
    expect(table.find(r => r.fc === 60).mean).toBe(Infinity);
    expect(bestFrequency).toBe(80);
  });

  it('rejette un crossover où un seul membre du groupe serait inversé (garde-fou §6)', async () => {
    // 60Hz : shifts petits MAIS FL inversé et FR non → incohérent → rejeté,
    // même s'il a le plus petit shift. 80Hz : inversion cohérente → retenu.
    const sweepFL = [
      { frequency: 60, requiredDelayMs: 0.1, delayMs: 0.1, withinBounds: true, invertB: true },
      { frequency: 80, requiredDelayMs: 0.3, delayMs: 0.3, withinBounds: true, invertB: false },
    ];
    const sweepFR = [
      { frequency: 60, requiredDelayMs: 0.1, delayMs: 0.1, withinBounds: true, invertB: false },
      { frequency: 80, requiredDelayMs: 0.3, delayMs: 0.3, withinBounds: true, invertB: false },
    ];
    const service = makeService({ FL: sweepFL, FR: sweepFR });

    const { bestFrequency, table } = await service.findBestCrossover(
      [makeMember('FL'), makeMember('FR')],
      [60, 80],
    );

    expect(table.find(r => r.fc === 60).inversionConsistent).toBe(false);
    expect(table.find(r => r.fc === 60).mean).toBe(Infinity); // rejeté
    expect(bestFrequency).toBe(80);
  });

  it('accepte un crossover où les DEUX membres sont inversés (cohérent)', async () => {
    const sweepFL = [
      { frequency: 80, requiredDelayMs: 0.2, delayMs: 0.2, withinBounds: true, invertB: true },
    ];
    const sweepFR = [
      { frequency: 80, requiredDelayMs: 0.2, delayMs: 0.2, withinBounds: true, invertB: true },
    ];
    const service = makeService({ FL: sweepFL, FR: sweepFR });

    const { bestFrequency, table } = await service.findBestCrossover(
      [makeMember('FL'), makeMember('FR')],
      [80],
    );

    expect(table.find(r => r.fc === 80).inversionConsistent).toBe(true);
    expect(bestFrequency).toBe(80);
  });

  it('renvoie bestFrequency null quand tous les candidats sont non finis', async () => {
    const infinite = fc => ({
      frequency: fc,
      requiredDelayMs: Infinity,
      delayMs: Infinity,
      withinBounds: false,
    });
    const service = makeService({
      FL: [infinite(60), infinite(80)],
      FR: [infinite(60), infinite(80)],
    });

    const { bestFrequency } = await service.findBestCrossover(
      [makeMember('FL'), makeMember('FR')],
      [60, 80],
    );

    expect(bestFrequency).toBeNull();
  });
});

describe('findBestLfeLowPass (choix du passe-bas LFE)', () => {
  const makeMember = uuid => ({ uuid, title: uuid });

  const makeService = sweepByMember =>
    createAlignmentService({
      session: { rewMeasurements: {} },
      crossoverFilteredIrPair: vi.fn(),
      setTargetLevelFromMeasurement: vi.fn(),
      relatedLfeFor: () => ({ uuid: 'lfe' }),
      relatedSubsFor: () => [{ uuid: 'sub', splOffsetdB: 0 }],
      lfeLowPassSummationSweep: vi.fn(member =>
        Promise.resolve(sweepByMember[member.uuid]),
      ),
    });

  const entry = (frequency, summationLossDb, worstLossDb = summationLossDb) => ({
    frequency,
    summationLossDb,
    worstLossDb,
    groupDelayMs: (1000 * Math.SQRT2) / (Math.PI * frequency),
  });

  it('retient le candidat à la plus faible perte de sommation moyenne', async () => {
    // Moyennes : 120→(1.2+0.8)/2=1.0, 150→(0.5+0.7)/2=0.6, 250→(0.9+0.9)/2=0.9
    // → 150 gagne (somme la plus constructive sur les fronts).
    const service = makeService({
      FL: [entry(120, 1.2), entry(150, 0.5), entry(250, 0.9)],
      FR: [entry(120, 0.8), entry(150, 0.7), entry(250, 0.9)],
    });

    const { bestFrequency, table } = await service.findBestLfeLowPass(
      [makeMember('FL'), makeMember('FR')],
      [120, 150, 250],
    );

    expect(bestFrequency).toBe(150);
    expect(table.find(r => r.fc === 150).mean).toBeCloseTo(0.6, 6);
    expect(table.find(r => r.fc === 120).mean).toBeCloseTo(1.0, 6);
    // Le décalage informatif du candidat est remonté dans la table.
    expect(table.find(r => r.fc === 150).groupDelayMs).toBeCloseTo(3.0, 1);
  });

  it('écarte un candidat dont un membre est non fini', async () => {
    const service = makeService({
      FL: [entry(120, 0.1), entry(250, 0.5)],
      FR: [entry(120, Infinity), entry(250, 0.6)],
    });

    const { bestFrequency, table } = await service.findBestLfeLowPass(
      [makeMember('FL'), makeMember('FR')],
      [120, 250],
    );

    // 120 écarté (FR non fini) malgré la meilleure perte de FL → 250.
    expect(table.find(r => r.fc === 120).mean).toBe(Infinity);
    expect(bestFrequency).toBe(250);
  });

  it('renvoie bestFrequency null quand tous les candidats sont non finis', async () => {
    const service = makeService({
      FL: [entry(120, NaN), entry(250, Infinity)],
      FR: [entry(120, Infinity), entry(250, NaN)],
    });

    const { bestFrequency } = await service.findBestLfeLowPass(
      [makeMember('FL'), makeMember('FR')],
      [120, 250],
    );

    expect(bestFrequency).toBeNull();
  });

  it('lève sans front ou sans candidat exploitable', async () => {
    const service = makeService({ FL: [entry(120, 0.1)] });

    await expect(service.findBestLfeLowPass([], [120])).rejects.toThrow(
      'No front speaker measurements',
    );
    await expect(
      service.findBestLfeLowPass([makeMember('FL')], [0, -3, NaN]),
    ).rejects.toThrow('No candidate LFE low-pass frequencies');
  });
});

describe('findAligment (aligneur interne, parité Align IRs)', () => {
  const SR = 48000;
  const alignBurst = (startSample, { invert = false } = {}) => {
    const out = new Float64Array(16384);
    for (let i = startSample; i < out.length; i++) {
      const t = (i - startSample) / SR;
      out[i] =
        (invert ? -1 : 1) * Math.sin(2 * Math.PI * 80 * t) * Math.exp(-t * 60);
    }
    return out;
  };
  const channel = data => ({
    uuid: 'x',
    getImpulseResponseInfo: vi
      .fn()
      .mockResolvedValue({ data, sampleRate: SR, startTime: 0 }),
  });

  it('computes the delay in seconds and the inversion internally', async () => {
    const { service } = createHarness();
    // B en retard de 48 échantillons (1 ms), non inversé
    const result = await service.findAligment(
      channel(alignBurst(2000)),
      channel(alignBurst(2048)),
      80,
      3,
      false,
      null,
      -3,
    );
    expect(Math.abs(Math.abs(result.shiftDelay) - 0.001)).toBeLessThan(0.0001);
    expect(result.isBInverted).toBe(false);
  });

  it('reports an inverted B', async () => {
    const { service } = createHarness();
    const result = await service.findAligment(
      channel(alignBurst(2000)),
      channel(alignBurst(2024, { invert: true })),
      80,
      3,
      false,
      null,
      -3,
    );
    expect(result.isBInverted).toBe(true);
  });

  it('throws the explicit Delay too large error with the required delay', async () => {
    const { service } = createHarness();
    // vrai délai 0.5 ms, bornes ±0.1 ms : la corrélation monte vers 0.5 ms,
    // le max contraint colle à la borne et l'affinage dérive dehors — le même
    // motif que le refus observé au golden (FL↔SW1@80, bornes serrées)
    await expect(
      service.findAligment(
        channel(alignBurst(2000)),
        channel(alignBurst(2024)),
        80,
        0.1,
        false,
        null,
        -0.1,
      ),
    ).rejects.toThrow(/Delay too large.*80 Hz.*ms/);
  });

  it('refuses the aligned-sum option (unused in production)', async () => {
    const { service } = createHarness();
    await expect(
      service.findAligment({}, {}, 80, 3, true, 'sum title', -0.5),
    ).rejects.toThrow(/Aligned sum is not supported/);
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
      crossoverFilteredIrPair: vi.fn(),
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
    const { service, crossoverFilteredIrPair } = createHarness();
    const speakerItem = {
      crossover: () => 80,
      relatedLfeMeasurement: () => null, // triggers the tolerated failure
      displayMeasurementTitle: () => '1: FL',
      update: vi.fn(),
    };

    await service.checkAlignment(speakerItem);

    expect(speakerItem.update).toHaveBeenCalledWith({ shiftDelay: Infinity });
    // No LFE: bails out before computing any filtered IR — no REW work at all.
    expect(crossoverFilteredIrPair).not.toHaveBeenCalled();
  });

  it('aligns the internally-filtered IRs and toggles inversion when required', async () => {
    const { service, crossoverFilteredIrPair } = createHarness();
    const PredictedLfe = { title: () => 'LFE predicted' };
    // Speaker IR is the LFE with inverted polarity (same arrival), so the
    // internal aligner must request a polarity toggle regardless of band.
    crossoverFilteredIrPair.mockResolvedValue({
      PredictedLfeFiltered: {
        data: alignmentBurst(480),
        sampleRate: 48000,
        startTime: 0,
      },
      speakerFiltered: {
        data: alignmentBurst(480).map(v => -v),
        sampleRate: 48000,
        startTime: 0,
      },
    });
    const speakerItem = {
      crossover: () => 80,
      relatedLfeMeasurement: () => PredictedLfe,
      title: () => 'FL',
      displayMeasurementTitle: () => '1: FL',
      update: vi.fn(),
      toggleInversion: vi.fn().mockResolvedValue(undefined),
    };

    await service.checkAlignment(speakerItem);

    // No injected subs → projection LFE fallback (empty subResponses).
    expect(crossoverFilteredIrPair).toHaveBeenCalledWith(PredictedLfe, speakerItem, 80, []);
    expect(speakerItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ shiftDelay: expect.any(Number) }),
    );
    const { shiftDelay } = speakerItem.update.mock.calls[0][0];
    expect(Number.isFinite(shiftDelay)).toBe(true);
    expect(speakerItem.toggleInversion).toHaveBeenCalledOnce();
  });

  it('feeds the position real subs as the somme-vraie référentiel', async () => {
    const subs = [{ uuid: 'SW1' }, { uuid: 'SW2' }];
    const { service, crossoverFilteredIrPair } = createHarness({
      relatedSubsFor: () => subs,
    });
    const PredictedLfe = { title: () => 'LFE predicted' };
    crossoverFilteredIrPair.mockResolvedValue({
      PredictedLfeFiltered: { data: alignmentBurst(480), sampleRate: 48000, startTime: 0 },
      speakerFiltered: { data: alignmentBurst(480), sampleRate: 48000, startTime: 0 },
    });
    const speakerItem = {
      crossover: () => 80,
      relatedLfeMeasurement: () => PredictedLfe,
      title: () => 'FL',
      displayMeasurementTitle: () => '1: FL',
      update: vi.fn(),
      toggleInversion: vi.fn().mockResolvedValue(undefined),
    };

    await service.checkAlignment(speakerItem);

    // The real subs of the position are passed through as subResponses (4th arg).
    expect(crossoverFilteredIrPair).toHaveBeenCalledWith(PredictedLfe, speakerItem, 80, subs);
    // Identical IRs → aligned, no inversion.
    expect(speakerItem.toggleInversion).not.toHaveBeenCalled();
    expect(speakerItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ shiftDelay: expect.any(Number) }),
    );
  });
});
