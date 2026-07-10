import { describe, expect, it } from 'vitest';
import {
  arraysMatchWithTolerance,
  binarySearchLowerBound,
  cleanFloat32Value,
  compareIrWindows,
  compareObjectsSorted,
  metersToSeconds,
  secondsToMeters,
} from '../../src/measurement/measurement-calculations.js';

describe('cleanFloat32Value', () => {
  it('rounds to the requested precision', () => {
    expect(cleanFloat32Value(1.23456789, 4)).toBe(1.2346);
    expect(cleanFloat32Value('2.5')).toBe(2.5);
  });

  it('returns 0 and reports invalid values', () => {
    let reported = null;
    expect(cleanFloat32Value('abc', 7, raw => (reported = raw))).toBe(0);
    expect(reported).toBe('abc');
    expect(cleanFloat32Value(Number.NaN)).toBe(0);
    expect(cleanFloat32Value(Infinity)).toBe(0);
  });
});

describe('seconds/meters conversions', () => {
  it('converts using the provided speed of sound', () => {
    expect(secondsToMeters(0.01, 343)).toBeCloseTo(3.43);
    expect(metersToSeconds(3.43, 343)).toBeCloseTo(0.01);
  });

  it('returns 0 for non-finite inputs', () => {
    expect(secondsToMeters(Number.NaN, 343)).toBe(0);
    expect(metersToSeconds(undefined, 343)).toBe(0);
  });
});

describe('arraysMatchWithTolerance', () => {
  it('matches arrays within tolerance', () => {
    expect(arraysMatchWithTolerance([1, 2], [1.005, 2.005])).toBe(true);
    expect(arraysMatchWithTolerance([1, 2], [1.02, 2])).toBe(false);
    expect(arraysMatchWithTolerance([1], [1, 2])).toBe(false);
    expect(arraysMatchWithTolerance(null, [1])).toBe(false);
  });
});

describe('compareIrWindows', () => {
  const source = {
    leftWindowType: 'Rectangular',
    rightWindowType: 'Rectangular',
    leftWindowWidthms: 125,
    rightWindowWidthms: 500,
    refTimems: 0,
    addFDW: false,
  };

  it('accepts a target that omits attributes', () => {
    expect(compareIrWindows(source, { leftWindowType: 'Rectangular' })).toBe(true);
  });

  it('compares numbers at 2-decimal precision', () => {
    expect(compareIrWindows(source, { leftWindowWidthms: 125.001 })).toBe(true);
    expect(compareIrWindows(source, { leftWindowWidthms: 124 })).toBe(false);
  });

  it('rejects when the target requires a missing source attribute', () => {
    expect(compareIrWindows({}, { leftWindowWidthms: 125 })).toBe(false);
    expect(compareIrWindows(null, source)).toBe(false);
  });

  it('compares mtwTimesms with tolerance when present in target', () => {
    expect(
      compareIrWindows(
        { ...source, mtwTimesms: [1, 2, 3] },
        { mtwTimesms: [1.005, 2.005, 3.005] },
      ),
    ).toBe(true);
    expect(
      compareIrWindows({ ...source, mtwTimesms: [1, 2, 3] }, { mtwTimesms: [1, 2, 4] }),
    ).toBe(false);
  });
});

describe('compareObjectsSorted', () => {
  it('ignores key order', () => {
    expect(compareObjectsSorted({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(compareObjectsSorted({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('binarySearchLowerBound', () => {
  it('finds the first index >= value', () => {
    expect(binarySearchLowerBound([10, 20, 30], 20)).toBe(1);
    expect(binarySearchLowerBound([10, 20, 30], 21)).toBe(2);
    expect(binarySearchLowerBound([10, 20, 30], 5)).toBe(0);
    expect(binarySearchLowerBound([10, 20, 30], 40)).toBe(3);
    expect(binarySearchLowerBound([], 1)).toBe(0);
  });
});
