import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_GROUP_NAME,
  channelDetailsFor,
  channelNameFromTitle,
  distanceInUnit,
  distanceSeverity,
  groupNameFor,
  isSubChannel,
  leftWindowWidthMilliseconds,
  predictedLfeTitle,
  speakerTypeFor,
  splForAvr,
  splIsAboveLimit,
} from '../../src/measurement/measurement-info.js';
import { CHANNEL_TYPES } from '../../src/audyssey.js';

describe('channelNameFromTitle', () => {
  it('extracts the channel code from measurement titles', () => {
    expect(channelNameFromTitle('FL_P01')).toBe('FL');
    expect(channelNameFromTitle('SW1avg')).toBe('SW1');
  });

  it('falls back to UNKNOWN for unrecognized titles', () => {
    expect(channelNameFromTitle('Target curve 75dB')).toBe(UNKNOWN_GROUP_NAME);
  });
});

describe('channelDetailsFor', () => {
  const flIndex = CHANNEL_TYPES.EnChannelType_FrontLeft.channelIndex;
  const detectedChannels = [{ commandId: 'FL', enChannelType: flIndex }];

  it('resolves AVR channel details from detected channels', () => {
    const details = channelDetailsFor('FL', detectedChannels);
    expect(details?.code).toBe('FL');
  });

  it('returns null without impulse response or unknown channel', () => {
    expect(channelDetailsFor('FL', detectedChannels, false)).toBeNull();
    expect(channelDetailsFor('XX', detectedChannels)).toBeNull();
  });
});

describe('group/speaker helpers', () => {
  it('derives group name and sub detection', () => {
    expect(groupNameFor({ group: 'Subwoofer' })).toBe('Subwoofer');
    expect(groupNameFor(null)).toBe('Unknown');
    expect(isSubChannel({ group: 'Subwoofer' })).toBe(true);
    expect(isSubChannel({ group: 'Front' })).toBe(false);
  });

  it('maps speaker types E/L/S', () => {
    expect(speakerTypeFor(true, 80)).toBe('E');
    expect(speakerTypeFor(false, 0)).toBe('L');
    expect(speakerTypeFor(false, 80)).toBe('S');
  });

  it('selects IR window width per type', () => {
    expect(leftWindowWidthMilliseconds(true)).toBe(70);
    expect(leftWindowWidthMilliseconds(false)).toBe(30);
  });
});

describe('SPL helpers', () => {
  it('rounds the AVR trim to 0.5 dB steps', () => {
    expect(splForAvr(1.3)).toBe(1.5);
    expect(splForAvr(-2.74)).toBe(-2.5);
  });

  it('flags trims above the AVR limit', () => {
    expect(splIsAboveLimit(12.5)).toBe(true);
    expect(splIsAboveLimit(-12.5)).toBe(true);
    expect(splIsAboveLimit(12)).toBe(false);
  });
});

describe('distance helpers', () => {
  it('converts distance to display units', () => {
    expect(distanceInUnit('M', 3.43, 0.01)).toBe(3.43);
    expect(distanceInUnit('ms', 3.43, 0.01)).toBe(10);
    expect(distanceInUnit('ft', 1, 0)).toBeCloseTo(3.28084);
    expect(() => distanceInUnit('yd', 1, 0)).toThrow('Unknown distance unit');
  });

  it('classifies distance severity', () => {
    expect(distanceSeverity(3, 6, 7.35)).toBe('normal');
    expect(distanceSeverity(6.5, 6, 7.35)).toBe('warning');
    expect(distanceSeverity(8, 6, 7.35)).toBe('error');
    expect(distanceSeverity(-1, 6, 7.35)).toBe('error');
    expect(distanceSeverity(8, Number.NaN, 7.35)).toBe('normal');
  });
});

describe('predictedLfeTitle', () => {
  it('builds the predicted LFE title for a position', () => {
    expect(predictedLfeTitle(2)).toBe('LFE predicted_P2');
  });
});
