import { describe, expect, it, vi } from 'vitest';
import {
  createFiltersService,
  selectMeasurementsForBulkApply,
} from '../../src/services/filters.js';

function speaker(channel, overrides = {}) {
  return {
    uuid: `uuid-${channel}`,
    channelName: () => channel,
    displayMeasurementTitle: () => `1: ${channel}`,
    createPhaseMatchFilter: vi.fn().mockResolvedValue(undefined),
    previewMeasurement: vi.fn().mockResolvedValue(true),
    toggleInversion: vi.fn().mockResolvedValue(true),
    copyAllToOther: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function service() {
  return createFiltersService({});
}

describe('selectMeasurementsForBulkApply', () => {
  const valid = [
    { uuid: 'a', isFilter: false },
    { uuid: 'b', isFilter: true },
  ];

  it('filters the valid measurements', () => {
    expect(
      selectMeasurementsForBulkApply({
        validMeasurements: valid,
        filter: item => !item.isFilter,
      }),
    ).toEqual([{ uuid: 'a', isFilter: false }]);
  });

  it('appends the predicted LFE once when requested and matching', () => {
    const predicted = { uuid: 'lfe', isFilter: false };

    expect(
      selectMeasurementsForBulkApply({
        validMeasurements: valid,
        predicted,
        filter: item => !item.isFilter,
        includePredicted: true,
      }),
    ).toEqual([{ uuid: 'a', isFilter: false }, predicted]);

    // already selected → not duplicated
    expect(
      selectMeasurementsForBulkApply({
        validMeasurements: [predicted],
        predicted,
        includePredicted: true,
      }),
    ).toEqual([predicted]);

    // rejected by the filter → not appended
    expect(
      selectMeasurementsForBulkApply({
        validMeasurements: valid,
        predicted: { uuid: 'lfe', isFilter: true },
        filter: item => !item.isFilter,
        includePredicted: true,
      }),
    ).toEqual([{ uuid: 'a', isFilter: false }]);
  });
});

describe('createSpeakerFilterForSelectedMode', () => {
  it('creates the RCH phase-match filter (single calculation path)', async () => {
    const item = speaker('FL');
    await service().createSpeakerFilterForSelectedMode(item);
    expect(item.createPhaseMatchFilter).toHaveBeenCalledOnce();
  });
});

describe('generateSelectedFilters', () => {
  it('generates every speaker filter and returns the RCH label', async () => {
    const speakers = [speaker('FL'), speaker('FR')];

    await expect(service().generateSelectedFilters(speakers)).resolves.toBe('RCH');

    for (const item of speakers) {
      expect(item.createPhaseMatchFilter).toHaveBeenCalledOnce();
    }
  });
});

describe('generatePreviews', () => {
  it('stops at the first refused preview', async () => {
    const ok = speaker('FL');
    const refused = speaker('FR', {
      previewMeasurement: vi.fn().mockResolvedValue(false),
    });
    const untouched = speaker('C');

    await expect(
      service().generatePreviews([ok, refused, untouched]),
    ).resolves.toBe(false);

    expect(untouched.previewMeasurement).not.toHaveBeenCalled();
  });

  it('returns true when every preview is generated', async () => {
    await expect(service().generatePreviews([speaker('FL')])).resolves.toBe(true);
  });
});

describe('invertAll / copyMeasurementCommonAttributes', () => {
  it('loops over the given measurements', async () => {
    const speakers = [speaker('FL'), speaker('FR')];

    await service().invertAll(speakers);
    await service().copyMeasurementCommonAttributes(speakers);

    for (const item of speakers) {
      expect(item.toggleInversion).toHaveBeenCalledOnce();
      expect(item.copyAllToOther).toHaveBeenCalledOnce();
    }
  });
});

describe('mode rch sur le chemin operations (ADR 002)', () => {
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

  it('route la génération de filtre rch vers operations.createFilter (mode phase)', async () => {
    const operations = { createFilter: vi.fn().mockResolvedValue(true) };
    const session = { rewMeasurements: { id: 'rew' } };
    const service = createFiltersService({
      operations,
      session,
      boostsFor: () => ({ individual: 6, overall: 3 }),
      autoEqConfig: () => autoEqFixture,
    });
    const item = { uuid: 'fl', title: 'FLavg' };

    await service.createSpeakerFilterForSelectedMode(item);

    expect(operations.createFilter).toHaveBeenCalledTimes(1);
    const [rew, m, ctx, mode, useWorking, copyToOther] =
      operations.createFilter.mock.calls[0];
    expect(rew).toBe(session.rewMeasurements);
    expect(m).toBe(item);
    expect(mode).toBe('phase');
    expect(useWorking).toBe(true);
    expect(copyToOther).toBe(false);
    // Le contexte fabrique un vrai calculateur AutoEQ paramétré par le panneau RCH.
    const calculator = ctx.createCalculator(48000, 20, 200);
    expect(typeof calculator.calculate).toBe('function');
    expect(calculator.individualMaxBoostDb).toBe(6);
  });
});
