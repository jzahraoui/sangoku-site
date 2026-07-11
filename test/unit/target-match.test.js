import { describe, expect, it } from 'vitest';
import MultiSubOptimizer from '../../src/multi-sub-optimizer.js';
import Scorer from '../../src/optimizer/scoring.js';
import { normalizeParam } from '../../src/optimizer/config.js';
import { hashParam } from '../../src/optimizer/cache.js';
import { resampleCurveToGrid } from '../../src/optimizer/measurements.js';
import { calculateResponseWithParams } from '../../src/optimizer/response.js';
import deps from '../mocks/logs.js';

function makeSub(name, id, { points = 96, level = 80, startFreq = 15 } = {}) {
  const freqs = [];
  const ppo = 24;
  let f = startFreq;
  while (freqs.length < points) {
    freqs.push(f);
    f *= Math.pow(2, 1 / ppo);
  }
  return {
    measurement: id,
    name,
    freqs,
    magnitude: new Float32Array(freqs.length).fill(level),
    phase: new Float32Array(freqs.length),
    freqStep: Math.pow(2, 1 / ppo),
    ppo,
  };
}

describe('param.filters contract', () => {
  it('defaults to an empty array and survives normalization', () => {
    expect(normalizeParam({}).filters).toEqual([]);
    const param = normalizeParam({
      filters: [{ frequency: 60, gain: -6, q: 4 }],
    });
    expect(param.filters).toEqual([{ frequency: 60, gain: -6, q: 4 }]);
  });

  it('rejects malformed filters', () => {
    expect(() => normalizeParam({ filters: [{ frequency: 0, gain: 0, q: 1 }] })).toThrow(
      /frequency/,
    );
    expect(() =>
      normalizeParam({ filters: [{ frequency: 60, gain: Infinity, q: 1 }] }),
    ).toThrow(/gain/);
    expect(() => normalizeParam({ filters: [{ frequency: 60, gain: 0, q: 0 }] })).toThrow(
      /q/,
    );
    expect(() => normalizeParam({ filters: 'nope' })).toThrow(/array/);
  });

  it('distinguishes filters in the evaluation cache hash', () => {
    const base = { delay: 0, gain: 0, polarity: 1 };
    const withFilter = { ...base, filters: [{ frequency: 60, gain: -6, q: 4 }] };
    const withOtherFilter = { ...base, filters: [{ frequency: 60, gain: -5.9, q: 4 }] };

    expect(hashParam(base)).not.toEqual(hashParam(withFilter));
    expect(hashParam(withFilter)).not.toEqual(hashParam(withOtherFilter));
  });
});

describe('calculateResponseWithParams with per-sub filters', () => {
  it('applies a peaking cut at its center frequency and stays neutral far away', () => {
    const sub = makeSub('SW1', 'uuid-1');
    const fc = sub.freqs[64]; // ~95 Hz, 2.7 octaves above the 15 Hz grid start
    sub.param = {
      delay: 0,
      gain: 0,
      polarity: 1,
      allPass: { frequency: 0, q: 0, enabled: false },
      filters: [{ frequency: fc, gain: -6, q: 4 }],
    };

    const response = calculateResponseWithParams(sub);
    expect(response.magnitude[64]).toBeCloseTo(80 - 6, 2);
    // Nearly three octaves below fc a Q=4 peaking filter is transparent.
    expect(response.magnitude[0]).toBeCloseTo(80, 1);
  });

  it('shifts the phase around the filter, not in the far field', () => {
    const sub = makeSub('SW1', 'uuid-1');
    const fc = sub.freqs[64];
    sub.param = {
      delay: 0,
      gain: 0,
      polarity: 1,
      allPass: { frequency: 0, q: 0, enabled: false },
      filters: [{ frequency: fc, gain: -6, q: 4 }],
    };

    const response = calculateResponseWithParams(sub);
    // A minimum-phase cut rotates the phase on the filter's skirts
    // (antisymmetric around fc, near zero at fc and in the far field).
    expect(Math.abs(response.phase[58])).toBeGreaterThan(10);
    expect(Math.abs(response.phase[0])).toBeLessThan(3);
  });

  it('treats near-zero filter gains as neutral', () => {
    const sub = makeSub('SW1', 'uuid-1');
    sub.param = {
      delay: 0,
      gain: 0,
      polarity: 1,
      allPass: { frequency: 0, q: 0, enabled: false },
      filters: [{ frequency: 60, gain: 0.001, q: 4 }],
    };
    const response = calculateResponseWithParams(sub);
    expect(response.magnitude[10]).toBeCloseTo(80, 5);
    expect(response.phase[10]).toBeCloseTo(0, 5);
  });
});

describe('resampleCurveToGrid', () => {
  it('passes through an identical grid and interpolates a coarser one', () => {
    const grid = [20, 40, 80, 160];
    const same = resampleCurveToGrid({ freqs: grid, magnitude: [1, 2, 3, 4] }, grid);
    expect(Array.from(same)).toEqual([1, 2, 3, 4]);

    // Coarse curve 20→80 Hz: log-interpolated midpoint at 40 Hz.
    const coarse = resampleCurveToGrid({ freqs: [20, 80], magnitude: [0, 10] }, grid);
    expect(coarse[1]).toBeCloseTo(5, 6);
    // Flat extrapolation beyond the last point.
    expect(coarse[3]).toBeCloseTo(10, 6);
  });
});

describe('target-match objective', () => {
  function scorerWithUnitWeights(length) {
    return new Scorer(new Float32Array(length).fill(1));
  }

  it('scores a perfect match at the base and penalizes shortfalls 4x overshoots', () => {
    const freqs = [30, 40, 50, 60, 70];
    const scorer = scorerWithUnitWeights(freqs.length);
    const target = new Float64Array(freqs.length).fill(80);
    const perfect = {
      freqs,
      magnitude: Float32Array.from(target),
      phase: new Float32Array(freqs.length),
    };
    const below = {
      ...perfect,
      magnitude: Float32Array.from([80, 80, 77, 80, 80]),
    };
    const above = {
      ...perfect,
      magnitude: Float32Array.from([80, 80, 83, 80, 80]),
    };

    const perfectScore = scorer.calculateTargetMatchScore(perfect, target);
    const belowScore = scorer.calculateTargetMatchScore(below, target);
    const aboveScore = scorer.calculateTargetMatchScore(above, target);

    expect(perfectScore).toBeCloseTo(100, 5);
    expect(perfectScore - belowScore).toBeCloseTo(4 * (perfectScore - aboveScore), 5);
  });

  it('requires the optimizer config to provide a target curve', () => {
    const sub1 = makeSub('SW1', 'uuid-1');
    const sub2 = makeSub('SW2', 'uuid-2');
    expect(
      () =>
        new MultiSubOptimizer(
          [sub1, sub2],
          { optimization: { objective: 'target-match' } },
          deps,
        ),
    ).toThrow(/targetCurve/);
  });

  it('clamps the effective target to the theoretical ceiling', () => {
    const sub1 = makeSub('SW1', 'uuid-1');
    const sub2 = makeSub('SW2', 'uuid-2');
    const optimizer = new MultiSubOptimizer(
      [sub1, sub2],
      {
        frequency: { min: 20, max: 200 },
        optimization: {
          objective: 'target-match',
          // Two coherent 80 dB subs peak at 86 dB: a 95 dB request is
          // structurally unreachable and must be clamped to the ceiling —
          // otherwise the asymmetric cost pulls boost forever chasing it.
          targetCurve: { freqs: [10, 400], magnitude: [95, 95] },
        },
      },
      deps,
    );
    const prepared = optimizer.prepareMeasurements();

    for (const value of optimizer.targetMagnitude) {
      expect(value).toBeCloseTo(86.02, 1);
    }

    // The perfectly coherent pair reaches the clamped target: base score.
    prepared[0].param = MultiSubOptimizer.EMPTY_CONFIG;
    prepared[1].param = MultiSubOptimizer.EMPTY_CONFIG;
    const result = optimizer.evaluateParameters(prepared[1], prepared[0], null);
    expect(result.score).toBeCloseTo(100, 1);
  });

  it('evaluates parameters against the resampled target through the standard path', () => {
    const sub1 = makeSub('SW1', 'uuid-1');
    const sub2 = makeSub('SW2', 'uuid-2');
    const optimizer = new MultiSubOptimizer(
      [sub1, sub2],
      {
        frequency: { min: 20, max: 200 },
        optimization: {
          objective: 'target-match',
          targetCurve: { freqs: [10, 400], magnitude: [86, 86] },
        },
      },
      deps,
    );
    const prepared = optimizer.prepareMeasurements();
    expect(optimizer.targetMagnitude.length).toBe(prepared[0].freqs.length);

    prepared[0].param = MultiSubOptimizer.EMPTY_CONFIG;
    prepared[1].param = MultiSubOptimizer.EMPTY_CONFIG;
    // Two identical in-phase 80 dB subs sum to exactly 86 dB = the target:
    // the score must sit at the base (perfect match, flat group delay).
    const result = optimizer.evaluateParameters(prepared[1], prepared[0], null);
    expect(result.score).toBeCloseTo(100, 1);

    // A polarity flip cancels the pair entirely — far below the target.
    prepared[1].param = { ...MultiSubOptimizer.EMPTY_CONFIG, polarity: -1 };
    const cancelled = optimizer.evaluateParameters(prepared[1], prepared[0], null);
    expect(cancelled.score).toBeLessThan(result.score - 100);
  });

  it('charges boosts superlinearly and caps the cumulative per-sub boost', () => {
    const sub1 = makeSub('SW1', 'uuid-1');
    const sub2 = makeSub('SW2', 'uuid-2');
    const optimizer = new MultiSubOptimizer(
      [sub1, sub2],
      {
        frequency: { min: 20, max: 200 },
        optimization: {
          objective: 'target-match',
          targetCurve: { freqs: [10, 400], magnitude: [86, 86] },
        },
      },
      deps,
    );
    const prepared = optimizer.prepareMeasurements();
    prepared[0].param = MultiSubOptimizer.EMPTY_CONFIG;

    // Filters far above the band are acoustically neutral on the grid: the
    // only score difference is the effort regularizer itself.
    const farAway = (...gains) => ({
      ...MultiSubOptimizer.EMPTY_CONFIG,
      filters: gains.map(gain => ({ frequency: 20000, gain, q: 8 })),
    });

    prepared[1].param = MultiSubOptimizer.EMPTY_CONFIG;
    const neutral = optimizer.evaluateParameters(prepared[1], prepared[0], null);
    const costOf = param => {
      prepared[1].param = param;
      return (
        neutral.score - optimizer.evaluateParameters(prepared[1], prepared[0], null).score
      );
    };

    const cut2 = costOf(farAway(-2));
    const boost2 = costOf(farAway(2));
    const boost6 = costOf(farAway(6));
    // Boosting costs more than cutting, and superlinearly beyond the knee:
    // filling an interference dip with +dB must lose against re-aligning the
    // other subs or cutting the destructive contributor.
    expect(cut2).toBeGreaterThan(0);
    expect(boost2).toBeCloseTo(2 * cut2, 3);
    expect(boost6).toBeGreaterThan(5 * boost2);

    // Cumulative per-sub boost above the overall cap (default 3 dB) is
    // charged even when each individual filter respects its own bound:
    // two stacked +2 dB boosts cost far more than twice one +2 dB boost.
    const stacked = costOf(farAway(2, 2));
    expect(stacked).toBeGreaterThan(2 * boost2 + 1);
  });
});
