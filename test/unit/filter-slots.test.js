import { describe, expect, it } from 'vitest';
import {
  FILTER_BANK_SIZE,
  buildPhaseMatchFilters,
  countFiltersSlotsAvailable,
  createEmptyFilters,
  validatePhaseMatchRange,
} from '../../src/measurement/filter-slots.js';

describe('createEmptyFilters', () => {
  it('creates the fixed REW bank of 22 auto slots', () => {
    const filters = createEmptyFilters();
    expect(filters).toHaveLength(FILTER_BANK_SIZE);
    expect(filters[0]).toEqual({ index: 1, type: 'None', enabled: true, isAuto: true });
    expect(filters.at(-1).index).toBe(22);
  });
});

describe('countFiltersSlotsAvailable', () => {
  it('counts auto slots up to index 20 only', () => {
    const filters = createEmptyFilters();
    expect(countFiltersSlotsAvailable(filters)).toBe(20);

    filters[0].isAuto = false;
    expect(countFiltersSlotsAvailable(filters)).toBe(19);
  });

  it('throws on invalid input', () => {
    expect(() => countFiltersSlotsAvailable(null)).toThrow('Invalid filters');
    expect(() => countFiltersSlotsAvailable({})).toThrow('Invalid filters');
  });
});

describe('buildPhaseMatchFilters', () => {
  it('maps optimizer filters onto a fresh bank', () => {
    const filters = buildPhaseMatchFilters([
      { filterType: 'PEAKING', fc: 100, Q: 4, gain: -3 },
      { filterType: 'LS', fc: 50, Q: 0.7, gain: 2 },
    ]);

    expect(filters).toHaveLength(FILTER_BANK_SIZE);
    expect(filters[0]).toEqual({
      index: 1,
      type: 'PK',
      enabled: true,
      isAuto: true,
      frequency: 100,
      q: 4,
      gaindB: -3,
    });
    expect(filters[1].type).toBe('LS');
    expect(filters[2].type).toBe('None');
  });

  it('throws when the optimizer produced nothing', () => {
    expect(() => buildPhaseMatchFilters([])).toThrow('No filters generated');
    expect(() => buildPhaseMatchFilters(null)).toThrow('No filters generated');
  });
});

describe('validatePhaseMatchRange', () => {
  it('accepts a valid range', () => {
    expect(() => validatePhaseMatchRange(20, 200)).not.toThrow();
  });

  it('rejects inverted or non-finite ranges', () => {
    expect(() => validatePhaseMatchRange(200, 20, 'Cavg')).toThrow(/Cavg/);
    expect(() => validatePhaseMatchRange(Number.NaN, 20)).toThrow(RangeError);
    expect(() => validatePhaseMatchRange(20, 20)).toThrow(RangeError);
  });
});
