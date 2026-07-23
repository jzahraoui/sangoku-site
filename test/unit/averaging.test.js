import { describe, expect, it, vi } from 'vitest';
import {
  createAverages,
  createAveragingProcessor,
} from '../../src/services/averaging.js';

function item(title, overrides = {}) {
  return {
    displayMeasurementTitle: () => title,
    alignSPLOffsetdB: () => 0,
    splOffsetdB: () => 0,
    inverted: () => false,
    isAverage: false,
    IRPeakValue: 0.5,
    ...overrides,
  };
}

describe('createAverages', () => {
  it('validates the snapshots then delegates to the grouped-responses bridge', async () => {
    const processGroupedResponses = vi.fn().mockResolvedValue(undefined);
    const grouped = { FL: { items: [], count: 2 } };

    await createAverages({
      validMeasurements: [
        item('FL_P01'),
        item('FL_P02'),
        // High IR peak is NOT an exclusion criterion (2026-07-23).
        item('FL_P03', { IRPeakValue: 1.2 }),
        item('FLavg', { isAverage: true }), // excluded from the checks
      ],
      groupedMeasurements: grouped,
      averageMethod: 'Vector average',
      deleteOriginal: 'all',
      processGroupedResponses,
    });

    expect(processGroupedResponses).toHaveBeenCalledWith(
      grouped,
      'Vector average',
      'all',
    );
  });

  it('refuses inconsistent measurements before averaging', async () => {
    const processGroupedResponses = vi.fn();

    await expect(
      createAverages({
        validMeasurements: [
          item('FL_P01'),
          item('FL_P02', { inverted: () => true }),
        ],
        groupedMeasurements: {},
        averageMethod: 'Vector average',
        deleteOriginal: 'all',
        processGroupedResponses,
      }),
    ).rejects.toThrow(/appear to be inverted: FL_P02/);

    expect(processGroupedResponses).not.toHaveBeenCalled();
  });
});

describe('createAveragingProcessor (records)', () => {
  const record = (uuid, title, IRPeakValue = 0.5) => ({ uuid, title, IRPeakValue });

  /** IR synthétique : burst large bande démarrant à startSample (48 kHz). */
  function burstIR(startSample) {
    const out = new Float64Array(512);
    for (let i = startSample; i < out.length; i++) {
      const t = (i - startSample) / 48000;
      out[i] = Math.sin(2 * Math.PI * 3000 * t) * Math.exp(-t * 3000);
    }
    return out;
  }

  function harness({ irByUuid = {}, sampleRateByUuid = {} } = {}) {
    const created = record('avg-uuid', 'created');
    const session = {
      rewMeasurements: {
        processMeasurements: vi.fn().mockResolvedValue({ ok: true }),
      },
      analyseApiResponse: vi.fn().mockResolvedValue(created),
      removeMeasurements: vi.fn().mockResolvedValue(true),
      removeMeasurementUuid: vi.fn().mockResolvedValue(true),
    };
    const operations = {
      setTitle: vi.fn().mockResolvedValue(true),
      getImpulseResponseInfo: vi.fn(async (rew, m) => ({
        data: irByUuid[m.uuid] ?? burstIR(50),
        sampleRate: sampleRateByUuid[m.uuid] ?? 48000,
        startTime: 0,
      })),
      addIROffsetSeconds: vi.fn().mockResolvedValue(true),
    };
    const { processGroupedResponses } = createAveragingProcessor({ session, operations });
    return { session, operations, created, processGroupedResponses };
  }

  it('averages each usable channel group, renames via operations, deletes originals', async () => {
    // fl2 arrive 100 échantillons après fl1 → l'alignement interne doit
    // appliquer ≈ +100/48000 s à fl2 avant le moyennage REW.
    const { session, operations, created, processGroupedResponses } = harness({
      irByUuid: { fl1: burstIR(50), fl2: burstIR(150), c1: burstIR(60), c2: burstIR(60) },
    });
    const fl1 = record('fl1', 'FL_P01');
    // Peak above digital full scale: stays a full member of the average.
    const fl2 = record('fl2', 'FL_P02', 1.05);
    const c1 = record('c1', 'C_P01');
    const c2 = record('c2', 'C_P02');
    const grouped = {
      FL: { items: [fl1, fl2], count: 2 },
      C: { items: [c1, c2], count: 2 },
    };

    await expect(processGroupedResponses(grouped, 'Vector average', 'all')).resolves.toBe(
      true,
    );

    // Alignement interne : offset ≈ 100 échantillons appliqué à fl2, ≈ 0 à c2
    const offsetCalls = operations.addIROffsetSeconds.mock.calls;
    expect(offsetCalls.map(call => call[1].uuid)).toEqual(['fl2', 'c2']);
    expect(offsetCalls[0][2] * 48000).toBeCloseTo(100, 0);
    expect(Math.abs(offsetCalls[1][2] * 48000)).toBeLessThan(1);

    expect(session.rewMeasurements.processMeasurements).toHaveBeenCalledWith(
      'Vector average',
      ['fl1', 'fl2'],
    );
    expect(operations.setTitle).toHaveBeenCalledWith(
      session.rewMeasurements,
      created,
      'FLavg',
    );
    // deleteOriginal 'all' → the 4 source uuids are removed
    expect(session.removeMeasurementUuid.mock.calls.map(c => c[0])).toEqual([
      'fl1',
      'fl2',
      'c1',
      'c2',
    ]);
  });

  it('averages without alignment when an impulse response is missing', async () => {
    const { session, operations, processGroupedResponses } = harness();
    const grouped = {
      FL: {
        items: [
          { ...record('fl1', 'FL_P01'), haveImpulseResponse: false },
          record('fl2', 'FL_P02'),
        ],
        count: 2,
      },
      C: { items: [record('c1', 'C_P01'), record('c2', 'C_P02')], count: 2 },
    };

    await expect(processGroupedResponses(grouped, 'Vector average', 'none')).resolves.toBe(
      true,
    );
    // FL non aligné (IR manquante) mais moyenné quand même ; C aligné.
    expect(operations.getImpulseResponseInfo.mock.calls.map(c => c[1].uuid)).toEqual([
      'c1',
      'c2',
    ]);
    expect(session.rewMeasurements.processMeasurements).toHaveBeenCalledWith(
      'Vector average',
      ['fl1', 'fl2'],
    );
  });

  it('averages without alignment on mixed sample rates', async () => {
    const { session, operations, processGroupedResponses } = harness({
      sampleRateByUuid: { fl1: 48000, fl2: 44100, c1: 48000, c2: 48000 },
    });
    const grouped = {
      FL: { items: [record('fl1', 'FL_P01'), record('fl2', 'FL_P02')], count: 2 },
      C: { items: [record('c1', 'C_P01'), record('c2', 'C_P02')], count: 2 },
    };

    await expect(processGroupedResponses(grouped, 'Vector average', 'none')).resolves.toBe(
      true,
    );
    // FL : rates mélangés → aucun offset appliqué ; C : aligné normalement.
    expect(operations.addIROffsetSeconds.mock.calls.map(c => c[1].uuid)).toEqual(['c2']);
    expect(session.rewMeasurements.processMeasurements).toHaveBeenCalledTimes(2);
  });

  it('excludes existing averages/predictions and rejects groups below 2 usable', async () => {
    const { processGroupedResponses } = harness();
    const grouped = {
      FL: { items: [record('fl1', 'FL_P01'), record('fla', 'FLavg')], count: 2 },
      C: { items: [record('c1', 'C_P01'), record('c2', 'C_P02')], count: 2 },
    };

    await expect(processGroupedResponses(grouped, 'Vector average', 'all')).rejects.toThrow(
      'Need at least 2 measurements to make an average: FL',
    );
  });
});
