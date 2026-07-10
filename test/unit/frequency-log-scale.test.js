import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_LOG,
  createFrequencyLogScale,
  getDecimalPlaces,
  readNumber,
  roundFrequency,
} from '../../src/measurement/frequency-log-scale.js';

describe('roundFrequency (progressive snap)', () => {
  it('snaps 1 Hz below 1 kHz, 100 Hz to 10 kHz, 1 kHz above', () => {
    expect(roundFrequency(543)).toBe(543);
    expect(roundFrequency(1234)).toBe(1200);
    expect(roundFrequency(15678)).toBe(16000);
  });
});

describe('getDecimalPlaces / readNumber', () => {
  it('reads decimals from a step string, default otherwise', () => {
    expect(getDecimalPlaces('0.0001')).toBe(4);
    expect(getDecimalPlaces('0.01')).toBe(2);
    expect(getDecimalPlaces('1')).toBe(4); // no fraction → default
  });

  it('parses numbers with a fallback', () => {
    expect(readNumber('3.5', 0)).toBe(3.5);
    expect(readNumber('nope', 7)).toBe(7);
    expect(readNumber(Number.NaN, 9)).toBe(9);
    expect(readNumber(42, 0)).toBe(42);
  });
});

describe('createFrequencyLogScale (default 10 Hz .. 20 kHz)', () => {
  const scale = createFrequencyLogScale();

  it('exposes the window bounds', () => {
    expect(scale.minLog).toBe(1);
    expect(scale.maxLog).toBeCloseTo(DEFAULT_MAX_LOG, 6);
    expect(scale.minFrequency).toBeCloseTo(10, 6);
    expect(scale.maxFrequency).toBeCloseTo(20000, 6);
  });

  it('clamps frequency to the window', () => {
    expect(scale.clampFrequency(5)).toBeCloseTo(10, 6);
    expect(scale.clampFrequency(30000)).toBeCloseTo(20000, 6);
    expect(scale.clampFrequency(1000)).toBe(1000);
    expect(scale.clampFrequency('bad')).toBeCloseTo(10, 6); // non-finite → min
  });

  it('maps frequency ↔ log10 within the window', () => {
    expect(scale.logFromFrequency(1000)).toBeCloseTo(3, 6);
    expect(scale.logFromFrequency(5)).toBeCloseTo(1, 6); // clamped to 10 Hz
    expect(scale.frequencyFromLog(3)).toBe(1000);
  });

  it('maps a linear ratio (0..1) onto snapped frequencies', () => {
    expect(scale.frequencyFromRatio(0)).toBe(10);
    expect(scale.frequencyFromRatio(1)).toBe(20000);
    // half-way in log space is the geometric mean (~447 Hz), snapped
    expect(scale.frequencyFromRatio(0.5)).toBe(roundFrequency(10 ** ((1 + DEFAULT_MAX_LOG) / 2)));
  });

  it('reports track percentage for the fill gradient', () => {
    expect(scale.percentForLog(scale.minLog)).toBeCloseTo(0, 6);
    expect(scale.percentForLog(scale.maxLog)).toBeCloseTo(100, 6);
    expect(scale.percentForFrequency(scale.minFrequency)).toBeCloseTo(0, 6);
    expect(scale.percentForFrequency(scale.maxFrequency)).toBeCloseTo(100, 6);
  });

  it('formats the log value with the configured decimals', () => {
    expect(createFrequencyLogScale({ decimalPlaces: 4 }).formatLog(3)).toBe('3.0000');
    expect(createFrequencyLogScale({ decimalPlaces: 2 }).formatLog(3)).toBe('3.00');
    // out-of-window logs are clamped before formatting
    expect(scale.formatLog(0)).toBe(scale.minLog.toFixed(4));
  });

  it('normalizes a bound pair (clamp + snap + order)', () => {
    expect(scale.normalizeBounds(16000, 20)).toEqual({ lower: 20, upper: 16000 });
    expect(scale.normalizeBounds(5, 30000)).toEqual({ lower: 10, upper: 20000 });
    expect(scale.normalizeBounds(1234, 5678)).toEqual({ lower: 1200, upper: 5700 });
  });
});
