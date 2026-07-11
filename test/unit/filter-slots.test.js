import { describe, expect, it } from 'vitest';
import {
  FILTER_BANK_SIZE,
  buildPhaseMatchFilters,
  countFiltersSlotsAvailable,
  createEmptyFilters,
  packFiltersIntoFreeSlots,
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

  it('packs the filters around the reserved slots and omits them', () => {
    const filters = buildPhaseMatchFilters(
      [
        { filterType: 'PEAKING', fc: 100, Q: 4, gain: -3 },
        { filterType: 'PEAKING', fc: 60, Q: 2, gain: -2 },
      ],
      [1, 3],
    );

    const indices = filters.map(f => f.index);
    expect(indices).not.toContain(1);
    expect(indices).not.toContain(3);
    expect(filters.find(f => f.index === 2)).toMatchObject({
      type: 'PK',
      frequency: 100,
      isAuto: true,
    });
    expect(filters.find(f => f.index === 4)).toMatchObject({
      type: 'PK',
      frequency: 60,
      isAuto: true,
    });
    expect(filters.find(f => f.index === 5).type).toBe('None');
  });

  it('drops the filter tail when the free slots run out', () => {
    const reserved = Array.from({ length: 19 }, (_, i) => i + 2); // 2..20
    const filters = buildPhaseMatchFilters(
      [
        { filterType: 'PEAKING', fc: 100, Q: 4, gain: -3 },
        { filterType: 'PEAKING', fc: 60, Q: 2, gain: -2 },
      ],
      reserved,
    );

    // Slot 1 is the only free one: first filter placed, second dropped.
    expect(filters.filter(f => f.type === 'PK')).toHaveLength(1);
    expect(filters.find(f => f.index === 1).frequency).toBe(100);
  });

  it('throws when every auto slot is reserved', () => {
    const reserved = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(() =>
      buildPhaseMatchFilters([{ filterType: 'PEAKING', fc: 100, Q: 4, gain: -3 }], reserved),
    ).toThrow('No free filter slots');
  });
});

describe('packFiltersIntoFreeSlots', () => {
  const pk = (index, frequency) => ({
    index,
    type: 'PK',
    enabled: true,
    isAuto: true,
    frequency,
    q: 4,
    gaindB: -3,
  });

  it('re-indexes the content into the free slots and empties the rest', () => {
    const { filters, dropped } = packFiltersIntoFreeSlots(
      [pk(1, 25), pk(4, 63)],
      [1, 2, 3],
    );

    expect(dropped).toEqual([]);
    expect(filters[0]).toMatchObject({ index: 4, type: 'PK', frequency: 25 });
    expect(filters[1]).toMatchObject({ index: 5, type: 'PK', frequency: 63 });
    expect(filters[2]).toEqual({ index: 6, type: 'None', enabled: true, isAuto: true });
    // free slots 4..20 only: no reserved slot, no manual slot 21-22
    expect(filters.map(f => f.index)).toEqual(
      Array.from({ length: 17 }, (unused, i) => i + 4),
    );
  });

  it('keeps the layout untouched when nothing is reserved', () => {
    const { filters } = packFiltersIntoFreeSlots([pk(1, 25)], []);

    expect(filters[0]).toMatchObject({ index: 1, type: 'PK', frequency: 25 });
    expect(filters).toHaveLength(20);
  });

  it('returns the overflowing filters as dropped', () => {
    const reserved = Array.from({ length: 19 }, (unused, i) => i + 1); // 1..19
    const { filters, dropped } = packFiltersIntoFreeSlots(
      [pk(1, 25), pk(2, 63)],
      reserved,
    );

    expect(filters).toEqual([expect.objectContaining({ index: 20, frequency: 25 })]);
    expect(dropped).toEqual([expect.objectContaining({ frequency: 63 })]);
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
