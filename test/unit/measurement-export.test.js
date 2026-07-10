import { describe, expect, it } from 'vitest';
import {
  crossoverOf,
  distanceContext,
  distanceInMeters,
  exceedsDistance,
  shiftInMeters,
  speakerTypeOf,
  splForAvrOf,
  splIsAboveLimitOf,
  splOffsetDeltadB,
} from '../../src/measurement/measurement-export.js';

const record = fields => ({
  haveImpulseResponse: true,
  cumulativeIRShiftSeconds: 0,
  timeOfIRPeakSeconds: 0,
  splOffsetdB: 0,
  initialSplOffsetdB: 0,
  ...fields,
});

describe('distance derivations', () => {
  it('converts the cumulative IR shift to metres plus the global shift', () => {
    const r = record({ cumulativeIRShiftSeconds: 0.01 });
    expect(distanceInMeters(r, { speedOfSound: 343, shift: 0 })).toBeCloseTo(3.43, 5);
    expect(distanceInMeters(r, { speedOfSound: 343, shift: 3 })).toBeCloseTo(6.43, 5);
    expect(distanceInMeters(record({ haveImpulseResponse: false }))).toBe(0);
  });

  it('applies a 3 m shift when the closest raw peak is under 1 m', () => {
    // peak 0.001 s → 0.343 m < 1 → shift 3
    expect(shiftInMeters([record({ timeOfIRPeakSeconds: 0.001 })], 343)).toBe(3);
    // peak 0.01 s → 3.43 m ≥ 1 → no shift
    expect(shiftInMeters([record({ timeOfIRPeakSeconds: 0.01 })], 343)).toBe(0);
  });

  it('builds the distance context and flags severity', () => {
    const records = [
      record({ cumulativeIRShiftSeconds: 0.01, timeOfIRPeakSeconds: 0.01 }),
      record({ cumulativeIRShiftSeconds: 0.02, timeOfIRPeakSeconds: 0.02 }),
    ];
    const ctx = distanceContext(records, 343);
    expect(ctx.shift).toBe(0);
    expect(ctx.minDistanceInMeters).toBeCloseTo(3.43, 2);
    expect(ctx.maxDistanceWarning).toBeCloseTo(9.43, 2);
    expect(ctx.maxDistanceError).toBeCloseTo(10.78, 2);
    expect(exceedsDistance(3.43, ctx)).toBe('normal');
    expect(exceedsDistance(11, ctx)).toBe('error');
  });
});

describe('SPL derivations', () => {
  it('derives the delta, the AVR trim and the limit flag', () => {
    const r = record({ splOffsetdB: 5, initialSplOffsetdB: 2 });
    expect(splOffsetDeltadB(r)).toBe(3);
    expect(splForAvrOf(r)).toBe(3);
    expect(splIsAboveLimitOf(r)).toBe(false);
    expect(splIsAboveLimitOf(record({ splOffsetdB: 15 }))).toBe(true);
  });
});

describe('crossover / speaker type', () => {
  const speaker = { isSub: false, channelDetails: { group: 'Front' } };
  const sub = { isSub: true, channelDetails: { group: 'Subwoofer' } };

  it('defaults the crossover and honours the per-group override', () => {
    expect(crossoverOf(sub)).toBe(0);
    expect(crossoverOf(speaker)).toBe(80);
    expect(crossoverOf(speaker, { crossoverByGroup: { Front: 120 } })).toBe(120);
  });

  it('maps the speaker type E/L/S', () => {
    expect(speakerTypeOf(sub, 0)).toBe('E');
    expect(speakerTypeOf(speaker, 0)).toBe('L');
    expect(speakerTypeOf(speaker, 80)).toBe('S');
  });
});
