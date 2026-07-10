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
    createStandardFilter: vi.fn().mockResolvedValue(undefined),
    previewMeasurement: vi.fn().mockResolvedValue(true),
    toggleInversion: vi.fn().mockResolvedValue(true),
    copyAllToOther: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function service(mode = 'rch') {
  return createFiltersService({ config: { selectedEqualizationMode: mode } });
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
  it('routes to the phase-match or standard filter by mode', async () => {
    const rchSpeaker = speaker('FL');
    await service('rch').createSpeakerFilterForSelectedMode(rchSpeaker);
    expect(rchSpeaker.createPhaseMatchFilter).toHaveBeenCalledOnce();
    expect(rchSpeaker.createStandardFilter).not.toHaveBeenCalled();

    const rewSpeaker = speaker('FL');
    await service('rew').createSpeakerFilterForSelectedMode(rewSpeaker);
    expect(rewSpeaker.createStandardFilter).toHaveBeenCalledOnce();
  });
});

describe('generateSelectedFilters', () => {
  it('generates every speaker filter and returns the mode label', async () => {
    const speakers = [speaker('FL'), speaker('FR')];

    await expect(service('rew').generateSelectedFilters(speakers)).resolves.toBe('REW');

    for (const item of speakers) {
      expect(item.createStandardFilter).toHaveBeenCalledOnce();
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
