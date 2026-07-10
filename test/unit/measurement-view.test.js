import { describe, expect, it } from 'vitest';
import {
  deriveMeasurements,
  otherPositionMeasurements,
} from '../../src/measurement/measurement-view.js';
import { CHANNEL_TYPES } from '../../src/audyssey.js';

const detectedChannels = [
  { commandId: 'FL', enChannelType: CHANNEL_TYPES.EnChannelType_FrontLeft.channelIndex },
  { commandId: 'C', enChannelType: CHANNEL_TYPES.EnChannelType_Center.channelIndex },
  { commandId: 'SW1', enChannelType: CHANNEL_TYPES.EnChannelType_SWLFE.channelIndex },
];

const record = title => ({ uuid: title, title, haveImpulseResponse: true });

describe('deriveMeasurements — grouped/filtered lists', () => {
  const records = [
    record('FL_P01'),
    record('FL_P02'),
    record('C_P01'),
    record('C_P02'),
    record('SW1_P01'),
    record('SW1_P02'),
  ];

  const derived = deriveMeasurements(records, {
    detectedChannels,
    currentSelectedPosition: 1,
  });

  const titles = list => list.map(item => item.title);

  it('groups by channel with per-position indexing', () => {
    expect(Object.keys(derived.grouped)).toEqual(['FL', 'C', 'SW1']);
    expect(derived.grouped.FL.count).toBe(2);
    expect(derived.byRecord.get(records[1]).position).toBe(2);
    expect(derived.byRecord.get(records[1]).displayPositionText).toBe('Pos. 2/2');
  });

  it('derives valid / selected / speaker / sub lists', () => {
    expect(titles(derived.validMeasurements)).toEqual([
      'FL_P01',
      'FL_P02',
      'C_P01',
      'C_P02',
      'SW1_P01',
      'SW1_P02',
    ]);
    expect(titles(derived.uniqueMeasurements)).toEqual(['FL_P01', 'C_P01', 'SW1_P01']);
    expect(titles(derived.uniqueSpeakersMeasurements)).toEqual(['FL_P01', 'C_P01']);
    expect(titles(derived.uniqueSubsMeasurements)).toEqual(['SW1_P01']);
    expect(titles(derived.subsMeasurements)).toEqual(['SW1_P01', 'SW1_P02']);
    expect(derived.firstMeasurement.title).toBe('FL_P01');
  });

  it('builds the de-duplicated position list', () => {
    expect(derived.positionList).toEqual([
      { value: 1, text: 'Pos. 1/2' },
      { value: 2, text: 'Pos. 2/2' },
    ]);
  });

  it('lists same-channel measurements at other positions', () => {
    const others = otherPositionMeasurements(records[0], derived);
    expect(others.map(item => item.title)).toEqual(['FL_P02']);
  });
});

describe('deriveMeasurements — identity flags', () => {
  const avg = record('SW1avg');
  const predicted = record('final C_P01');
  const lfe = record('LFE predicted_P1');
  const target = record('Target harman 75dB');
  const records = [record('SW1_P01'), avg, predicted, lfe, target];

  const derived = deriveMeasurements(records, { detectedChannels });

  it('includes sub-operation results in subsLikeMeasurements', () => {
    const opResult = { uuid: 'sum', title: 'Sub sum', haveImpulseResponse: true, isSubOperationResult: true };
    const local = deriveMeasurements([record('SW1_P01'), opResult], { detectedChannels });
    expect(local.subsLikeMeasurements.map(item => item.title).sort()).toEqual([
      'SW1_P01',
      'Sub sum',
    ]);
  });

  it('flags averages, predictions, LFE predictions and unknown channels', () => {
    expect(derived.byRecord.get(avg).isAverage).toBe(true);
    expect(derived.byRecord.get(avg).isSub).toBe(true);
    expect(derived.byRecord.get(predicted).isPredicted).toBe(true);
    expect(derived.byRecord.get(lfe).isLfePredicted).toBe(true);
    expect(derived.byRecord.get(target).isUnknownChannel).toBe(true);
  });

  it('excludes predicted / LFE / unknown from validMeasurements', () => {
    const titles = derived.validMeasurements.map(item => item.title);
    expect(titles).not.toContain('final C_P01');
    expect(titles).not.toContain('LFE predicted_P1');
    expect(titles).not.toContain('Target harman 75dB');
    expect(derived.allPredictedLfeMeasurement.map(item => item.title)).toEqual([
      'LFE predicted_P1',
    ]);
  });
});
