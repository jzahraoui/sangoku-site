import { describe, expect, it, vi } from 'vitest';
import { createBusinessTools } from '../../src/services/business-tools.js';

// IR de Dirac partagée par les tests des deux sweeps (crossover et passe-bas LFE).
const SWEEP_SR = 48000;
const makeDeltaIr = (peakSample = 200) => {
  const data = new Float64Array(4096);
  data[peakSample] = 1;
  return { data, sampleRate: SWEEP_SR, startTime: 0 };
};

// IR pour les chemins band-passés (bandPassedPeakSeconds) : delta éloigné des
// bords — le passe-bande zéro-phase étale l'énergie de part et d'autre du pic.
const alignDeltaIr = peakSample => {
  const data = new Float64Array(16384);
  data[peakSample] = 1;
  return {
    data,
    sampleRate: SWEEP_SR,
    startTime: 0,
    timeOfIRPeakSeconds: peakSample / SWEEP_SR,
  };
};

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
  function harness() {
    const operations = {
      getPredictedImpulseResponseInfo: vi
        .fn()
        .mockImplementation(async (_rew, m) =>
          makeDeltaIr(m.uuid === 'sub' ? 260 : 200),
        ),
      // Somme vraie des subs — déléguée à la couche operations (source unique
      // de la convention splOffsetdB).
      getCombinedSubsCrossoverFilteredIr: vi
        .fn()
        .mockImplementation(async () => makeDeltaIr(260)),
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

    // 1 lecture pour l'enceinte + 1 somme vraie pour les subs — PAS une
    // lecture par candidat.
    expect(operations.getPredictedImpulseResponseInfo).toHaveBeenCalledTimes(1);
    expect(operations.getCombinedSubsCrossoverFilteredIr).toHaveBeenCalledTimes(1);
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
    expect(operations.getCombinedSubsCrossoverFilteredIr).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
  });

  it('lève si ni sub ni LFE ne sont disponibles', async () => {
    const { tools } = harness();
    await expect(
      tools.crossoverRequiredShiftSweep({ uuid: 'FL', title: 'FL' }, null, [], [80]),
    ).rejects.toThrow('Cannot find predicted LFE');
  });
});

describe('createBusinessTools.lfeLowPassSummationSweep', () => {
  function harness() {
    const operations = {
      getPredictedImpulseResponseInfo: vi
        .fn()
        .mockImplementation(async () => makeDeltaIr(200)),
      getCombinedSubsCrossoverFilteredIr: vi
        .fn()
        .mockImplementation(async () => makeDeltaIr(200)),
    };
    const session = { rewMeasurements: { id: 'rew' } };
    const tools = createBusinessTools({ operations, session });
    return { operations, tools };
  }

  it('lit chaque IR une fois et renvoie un résultat fini par candidat', async () => {
    const { operations, tools } = harness();
    const speaker = { uuid: 'FL', title: 'FL', crossover: () => 0 };
    const subs = [{ uuid: 'sub', title: 'SW', splOffsetdB: 0 }];

    const results = await tools.lfeLowPassSummationSweep(
      speaker,
      null,
      subs,
      [80, 120, 250],
    );

    // 1 lecture pour l'enceinte + 1 somme vraie pour les subs — PAS une
    // lecture par candidat.
    expect(operations.getPredictedImpulseResponseInfo).toHaveBeenCalledTimes(1);
    expect(operations.getCombinedSubsCrossoverFilteredIr).toHaveBeenCalledTimes(1);
    expect(results.map(r => r.frequency)).toEqual([80, 120, 250]);
    for (const r of results) {
      expect(Number.isFinite(r.summationLossDb)).toBe(true);
      expect(r.summationLossDb).toBeGreaterThanOrEqual(0);
      // Le pire creux borne la moyenne par construction.
      expect(r.worstLossDb).toBeGreaterThanOrEqual(r.summationLossDb);
      // Retard de groupe passe-bande du LR24 : √2/(π·fc).
      expect(r.groupDelayMs).toBeCloseTo((1000 * Math.SQRT2) / (Math.PI * r.frequency), 9);
    }
  });

  it('IR coïncidentes (enceinte Large) : la perte diminue quand fc monte', async () => {
    // Enceinte et sub parfaitement alignés : seul le déphasage du LR24 candidat
    // dégrade la somme → un passe-bas plus haut (moins de retard de groupe dans
    // la bande ≤120 Hz) doit toujours gagner.
    const { tools } = harness();
    const speaker = { uuid: 'FL', title: 'FL', crossover: () => 0 };
    const subs = [{ uuid: 'sub', title: 'SW', splOffsetdB: 0 }];

    const results = await tools.lfeLowPassSummationSweep(
      speaker,
      null,
      subs,
      [80, 120, 250],
    );

    const byFreq = new Map(results.map(r => [r.frequency, r.summationLossDb]));
    expect(byFreq.get(80)).toBeGreaterThan(byFreq.get(120));
    expect(byFreq.get(120)).toBeGreaterThan(byFreq.get(250));
    expect(byFreq.get(250)).toBeGreaterThan(0);
  });

  it('applique le HP LR24 de l’enceinte (chaîne réelle) : résultat différent du cas Large', async () => {
    const { tools } = harness();
    const subs = [{ uuid: 'sub', title: 'SW', splOffsetdB: 0 }];
    const large = { uuid: 'FL', title: 'FL', crossover: () => 0 };
    const small = { uuid: 'FL', title: 'FL', crossover: () => 80 };

    const [withLarge] = await tools.lfeLowPassSummationSweep(large, null, subs, [120]);
    const [withHp] = await tools.lfeLowPassSummationSweep(small, null, subs, [120]);

    expect(withHp.summationLossDb).not.toBeCloseTo(withLarge.summationLossDb, 6);
  });

  it('remet chaque voie à son niveau affiché (splOffsetdB) — l’équilibre pilote le critère', async () => {
    // Les exports d'IR REW n'intègrent pas le SPL offset : sans repondération
    // de l'enceinte, son poids face aux subs serait arbitraire et le critère
    // dégénérerait en atténuation du LR24 seul (observé grandeur nature).
    const { tools } = harness();
    const subs = [{ uuid: 'sub', title: 'SW', splOffsetdB: 0 }];
    const loud = { uuid: 'FL', title: 'FL', crossover: () => 0, splOffsetdB: 80 };
    const quiet = { uuid: 'FL', title: 'FL', crossover: () => 0, splOffsetdB: -80 };

    const [loud80] = await tools.lfeLowPassSummationSweep(loud, null, subs, [80]);
    const [quiet80] = await tools.lfeLowPassSummationSweep(quiet, null, subs, [80]);

    // Enceinte dominante : le passe-bas candidat ne pèse presque plus rien.
    expect(loud80.summationLossDb).toBeLessThan(0.02);
    // Enceinte écrasée : la perte tend vers l'atténuation moyenne du LR24 seul.
    expect(quiet80.summationLossDb).toBeGreaterThan(1);
  });

  it('inclut le grave redirigé du canal front : parité analytique à candidat = crossover', async () => {
    // Enceinte muette (−300 dB) et crossover 80 : la voie front se réduit au
    // grave redirigé subs×LR24(80). Au candidat fc = 80, le LFE traverse le
    // MÊME filtre → phase identique, somme = 2·L·H. Avec |L| = 1 (Dirac), la
    // perte vaut exactement 20·log10((|H|+1)/(2·|H|)) en chaque point —
    // vérification analytique du modèle « chemin bass management complet ».
    const { tools } = harness();
    const speaker = { uuid: 'FL', title: 'FL', crossover: () => 80, splOffsetdB: -300 };
    const subs = [{ uuid: 'sub', title: 'SW', splOffsetdB: 0 }];

    const [result] = await tools.lfeLowPassSummationSweep(speaker, null, subs, [80]);

    const { logSpacedFrequencies } = await import('../../src/dsp/spectrum.js');
    const { getCascadeComplexResponse } = await import('../../src/dsp/biquadResponse.js');
    const { buildCrossoverCascade } = await import(
      '../../src/measurement/rew-filter-bank.js'
    );
    const grid = logSpacedFrequencies(20, 120, 16);
    const cascade = buildCrossoverCascade(
      { type: 'Low pass', frequency: 80, shape: 'L-R', slopedBPerOctave: 24 },
      SWEEP_SR,
    );
    let expected = 0;
    for (const freq of grid) {
      const h = getCascadeComplexResponse(cascade, freq, SWEEP_SR);
      const magnitude = Math.hypot(h.re, h.im);
      expected += 20 * Math.log10((magnitude + 1) / (2 * magnitude));
    }
    expected /= grid.length;

    expect(result.summationLossDb).toBeCloseTo(expected, 6);
  });

  it('pondère aussi la projection LFE de repli par son splOffsetdB', async () => {
    const { tools } = harness();
    const speaker = { uuid: 'FL', title: 'FL', crossover: () => 0, splOffsetdB: 0 };
    const lfeQuiet = { uuid: 'lfe', title: 'LFE', splOffsetdB: -80 };

    const [result] = await tools.lfeLowPassSummationSweep(speaker, lfeQuiet, [], [80]);

    // LFE écrasé de 80 dB → l'enceinte domine, la perte devient négligeable.
    // Sans la pondération du repli, le LFE resterait au niveau natif (~ celui
    // de l'enceinte) et la perte serait celle d'un mélange 50/50.
    expect(result.summationLossDb).toBeLessThan(0.02);
  });

  it('utilise le LFE prédictif en repli et garde les entrées', async () => {
    const { operations, tools } = harness();
    const speaker = { uuid: 'FL', title: 'FL', crossover: () => 0 };
    const lfe = { uuid: 'lfe', title: 'LFE' };

    const results = await tools.lfeLowPassSummationSweep(speaker, lfe, [], [120]);
    expect(operations.getPredictedImpulseResponseInfo).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);

    await expect(
      tools.lfeLowPassSummationSweep(speaker, null, [], [120]),
    ).rejects.toThrow('Cannot find predicted LFE');
    await expect(tools.lfeLowPassSummationSweep(speaker, lfe, [], [])).rejects.toThrow(
      'No candidate LFE low-pass frequencies',
    );
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
      // IR brute interne : le LFE pique 1 ms après l'enceinte (0.101 s vs
      // 0.100 s) — deltas réels, le pré-positionnement passe par le pic
      // band-passé (bandPassedPeakSeconds), plus par timeOfIRPeakSeconds.
      getCrossoverFilteredIr: vi
        .fn()
        .mockImplementation(async (_rew, m) =>
          alignDeltaIr(m.role === 'lfe' ? 4848 : 4800),
        ),
      // somme vraie des subs (même pic que le LFE projeté dans ces tests)
      getCombinedSubsCrossoverFilteredIr: vi
        .fn()
        .mockResolvedValue(alignDeltaIr(4848)),
      // relecture du High pass L-R 24 posé par la preview (garde REW)
      getFilters: vi.fn().mockImplementation(async () => [
        {
          index: 20,
          enabled: true,
          isAuto: false,
          type: 'High pass',
          frequency: 80,
          shape: 'L-R',
          slopedBPerOctave: 24,
        },
      ]),
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

  it('alignmentGapSeconds measures the junction-filtered peak gap on raw IRs', async () => {
    const { operations, tools, session } = harness();
    const speaker = { uuid: 'fl', title: 'FL', role: 'spk' };

    const gap = await tools.alignmentGapSeconds(speaker);

    // Ancre = pics des IR brutes vues à travers la paire LR24|LR24 (aucune
    // phase relative ajoutée) — même formule que la parité golden align-sub.
    const { buildCrossoverCascade, subLowPassSetting, simulationSpeakerHighPassSetting } =
      await import('../../src/measurement/rew-filter-bank.js');
    const { processThroughCascade, peakTimeSeconds } = await import(
      '../../src/dsp/impulseResponse.js'
    );
    const peakThrough = (ir, setting) =>
      peakTimeSeconds({
        data: processThroughCascade(ir.data, buildCrossoverCascade(setting, SWEEP_SR)),
        sampleRate: SWEEP_SR,
        startTime: 0,
      });
    const expected =
      peakThrough(alignDeltaIr(4848), subLowPassSetting(80)) -
      peakThrough(alignDeltaIr(4800), simulationSpeakerHighPassSetting(80));
    expect(gap).toBeCloseTo(expected, 9);
    // Deltas espacés de 1 ms : le LP retarde le pic du grave (retard de
    // groupe du LR24), le HP garde le front — le gap dépasse l'écart brut.
    expect(gap).toBeGreaterThan(0.001);
    // internal path: IR predicted BRUTES (doctrine « mesures sur courbes
    // brutes » — aucun filtre de raccord), no REW temporary measurement.
    expect(operations.getCrossoverFilteredIr).toHaveBeenCalledWith(
      session.rewMeasurements,
      speaker,
      null,
    );
    expect(operations.getCrossoverFilteredIr).toHaveBeenCalledWith(
      session.rewMeasurements,
      expect.objectContaining({ uuid: 'lfe' }),
      null,
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

  it('applyCutOffFilter (preview) sets the LR24/LR24 pair then restores to None', async () => {
    const { operations, tools } = harness();
    const sub = { uuid: 's', role: 'lfe' };
    const speaker = { uuid: 'fl', role: 'spk' };

    await tools.applyCutOffFilter(sub, speaker, 80);

    // Low pass on the sub + High pass L-R 24 on the speaker — la preview
    // simule la chaîne ampli complète (BW12 de la FIR OCA × BW12 AVR),
    // then two None resets
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
      shape: 'L-R',
      slopedBPerOctave: 24,
    });
    expect(operations.setSingleFilter.mock.calls[2][2]).toMatchObject({ type: 'None' });
    expect(operations.setSingleFilter.mock.calls[3][2]).toMatchObject({ type: 'None' });
  });

  it('applyCutOffFilter échoue net si REW dégrade le High pass L-R 24', async () => {
    // Shape « L-R » sondé sur 5.40 B128 uniquement : un build REW qui le
    // refuse laisserait la preview sans passe-haut enceinte — l'échec doit
    // être explicite, pas silencieux.
    const { operations, tools } = harness();
    operations.getFilters.mockResolvedValue([{ index: 20, type: 'None' }]);

    await expect(
      tools.applyCutOffFilter({ uuid: 's', role: 'lfe' }, { uuid: 'fl', role: 'spk' }, 80),
    ).rejects.toThrow(/did not accept the High pass L-R 24/);

    // les filtres temporaires sont tout de même remis à None (finally)
    expect(operations.setSingleFilter.mock.calls.at(-1)[2]).toMatchObject({
      type: 'None',
    });
    expect(operations.setSingleFilter.mock.calls.at(-2)[2]).toMatchObject({
      type: 'None',
    });
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
    // the LFE side is the TRUE weighted sum of the real subs, not the
    // projection — read RAW (doctrine « mesures sur courbes brutes »)
    expect(operations.getCombinedSubsCrossoverFilteredIr).toHaveBeenCalledWith(
      session.rewMeasurements,
      subs,
      null,
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
