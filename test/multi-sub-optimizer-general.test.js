import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Polar — provide minimal implementation needed by constructor path
vi.mock('./Polar.js', () => {
  class MockPolar {
    constructor(magnitude, phase) {
      this._magnitude = magnitude;
      this._phase = phase;
    }
    static fromDb(dbValue, phaseDegrees) {
      const magnitude = Math.pow(10, dbValue / 20);
      const phaseRadians = (phaseDegrees * Math.PI) / 180;
      return new MockPolar(magnitude, phaseRadians);
    }
    static DbToLinearGain(db) {
      return Math.pow(10, db / 20);
    }
    static normalizePhase(p) {
      return p;
    }
    static degreesToRadians(d) {
      return (d * Math.PI) / 180;
    }
    static radiansToDegrees(r) {
      return (r * 180) / Math.PI;
    }
    get magnitudeDb() {
      return 20 * Math.log10(Math.max(this._magnitude, Number.EPSILON));
    }
    get phaseDegrees() {
      return (this._phase * 180) / Math.PI;
    }
    toComplex() {
      return {
        re: this._magnitude * Math.cos(this._phase),
        im: this._magnitude * Math.sin(this._phase),
        add(other) {
          return { re: this.re + other.re, im: this.im + other.im };
        },
      };
    }
    add(other) {
      const c = this.toComplex();
      const o = other.toComplex();
      const sum = { re: c.re + o.re, im: c.im + o.im };
      const mag = Math.hypot(sum.re, sum.im);
      const phase = Math.atan2(sum.im, sum.re);
      return new MockPolar(mag, phase);
    }
  }
  return { default: MockPolar };
});

vi.mock('./frequency-response-processor.js', () => ({
  default: {
    calculateMinimumPhase: magnitude => new Float32Array(magnitude.length).fill(0),
  },
}));

import MultiSubOptimizer from '../src/multi-sub-optimizer.js';

// Helper: build a fake measurement object with the given frequency array
function makeMeasurement(freqs, { name = 'Sub', measurement = 'uuid-1' } = {}) {
  const len = freqs.length;
  return {
    freqs: Float32Array.from(freqs),
    magnitude: new Float32Array(len).fill(80), // flat 80 dB
    phase: new Float32Array(len).fill(0),
    name,
    measurement,
    freqStep: freqs.length > 1 ? freqs[1] - freqs[0] : 1,
    ppo: 48,
  };
}

// Minimal logger stub
const lm = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
};

/**
 * Directly exercise the binary search logic that lives inside prepareMeasurements()
 * by constructing a MultiSubOptimizer with controlled frequency arrays and checking
 * the resulting filtered frequency content.
 */
describe('prepareMeasurements – binary search for startIdx / endIdx', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Normal case: frequencies span outside the range on both sides ──
  it('filters to the correct inclusive range [min, max]', () => {
    // freqs: 5, 10, 15, 20, 25, ..., 195, 200, 205, 210
    const freqs = Array.from({ length: 42 }, (_, i) => 5 + i * 5);
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    const prepared = opt.preparedSubs[0];
    expect(prepared.freqs[0]).toBe(20);
    expect(prepared.freqs[prepared.freqs.length - 1]).toBe(200);
    // Every frequency should be within [20, 200]
    for (const f of prepared.freqs) {
      expect(f).toBeGreaterThanOrEqual(20);
      expect(f).toBeLessThanOrEqual(200);
    }
  });

  // ── All frequencies inside the range ──
  it('keeps all frequencies when all are inside the range', () => {
    const freqs = [30, 50, 80, 100, 150];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    expect(Array.from(opt.preparedSubs[0].freqs)).toEqual(freqs);
  });

  // ── No frequencies inside the range → empty after filter → should throw ──
  it('throws when no frequencies lie in the range', () => {
    const freqs = [5, 10, 15]; // all below min 20
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };

    expect(
      () =>
        new MultiSubOptimizer(
          [
            makeMeasurement(freqs, { measurement: 'a' }),
            makeMeasurement(freqs, { measurement: 'b' }),
          ],
          config,
          lm,
        ),
    ).toThrow(); // prepareMeasurements checks firstLen === 0
  });

  // ── All frequencies above the range → empty ──
  it('throws when all frequencies are above the range', () => {
    const freqs = [250, 300, 400];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };

    expect(
      () =>
        new MultiSubOptimizer(
          [
            makeMeasurement(freqs, { measurement: 'a' }),
            makeMeasurement(freqs, { measurement: 'b' }),
          ],
          config,
          lm,
        ),
    ).toThrow();
  });

  // ── Exact boundary values are included ──
  it('includes exact boundary frequencies (min and max)', () => {
    const freqs = [10, 20, 100, 200, 300];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    const filtered = Array.from(opt.preparedSubs[0].freqs);
    expect(filtered).toContain(20);
    expect(filtered).toContain(200);
    expect(filtered).not.toContain(10);
    expect(filtered).not.toContain(300);
  });

  // ── Single frequency equal to min ──
  it('handles single frequency equal to range min', () => {
    const freqs = [20];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    expect(Array.from(opt.preparedSubs[0].freqs)).toEqual([20]);
  });

  // ── Single frequency equal to max ──
  it('handles single frequency equal to range max', () => {
    const freqs = [200];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    expect(Array.from(opt.preparedSubs[0].freqs)).toEqual([200]);
  });

  // ── Single frequency outside the range ──
  it('throws for a single frequency outside the range', () => {
    const freqs = [10];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };

    expect(
      () =>
        new MultiSubOptimizer(
          [
            makeMeasurement(freqs, { measurement: 'a' }),
            makeMeasurement(freqs, { measurement: 'b' }),
          ],
          config,
          lm,
        ),
    ).toThrow();
  });

  // ── startIdx and endIdx correctness with dense data ──
  it('correctly identifies start and end indices with 1 Hz resolution', () => {
    // 1 Hz steps from 1 to 500
    const freqs = Array.from({ length: 500 }, (_, i) => i + 1);
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 50, max: 120 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    const filtered = Array.from(opt.preparedSubs[0].freqs);
    expect(filtered[0]).toBe(50);
    expect(filtered.at(-1)).toBe(120);
    expect(filtered.length).toBe(71); // 50..120 inclusive
  });

  // ── startFreq and endFreq properties ──
  it('sets startFreq and endFreq correctly on the prepared sub', () => {
    const freqs = [10, 20, 50, 100, 150, 200, 300];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    expect(opt.preparedSubs[0].startFreq).toBe(20);
    expect(opt.preparedSubs[0].endFreq).toBe(200);
  });

  // ── Magnitude and phase arrays sliced in sync with freqs ──
  it('slices magnitude and phase arrays consistently with freqs', () => {
    const freqs = [10, 30, 60, 100, 250];
    const magnitude = Float32Array.from([1, 2, 3, 4, 5]);
    const phase = Float32Array.from([10, 20, 30, 40, 50]);
    const sub = {
      freqs: Float32Array.from(freqs),
      magnitude,
      phase,
      name: 'Sub',
      measurement: 'a',
      freqStep: 1,
      ppo: 48,
    };
    const sub2 = { ...sub, measurement: 'b' };
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer([sub, sub2], config, lm);

    const p = opt.preparedSubs[0];
    // Expected filtered: indices 1,2,3 → freqs [30,60,100], mag [2,3,4], phase [20,30,40]
    expect(Array.from(p.freqs)).toEqual([30, 60, 100]);
    expect(Array.from(p.magnitude)).toEqual([2, 3, 4]);
    expect(Array.from(p.phase)).toEqual([20, 30, 40]);
  });

  // ── Narrow range containing a single frequency ──
  it('correctly filters a narrow range that matches one point', () => {
    const freqs = [10, 50, 100, 150, 200];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 100, max: 100 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    expect(Array.from(opt.preparedSubs[0].freqs)).toEqual([100]);
  });

  // ── Range sits between two consecutive frequency points ──
  it('returns empty (throws) when range falls between two frequency points', () => {
    const freqs = [10, 50, 200, 300];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 51, max: 199 },
    };

    expect(
      () =>
        new MultiSubOptimizer(
          [
            makeMeasurement(freqs, { measurement: 'a' }),
            makeMeasurement(freqs, { measurement: 'b' }),
          ],
          config,
          lm,
        ),
    ).toThrow();
  });

  // ── Floating-point frequencies ──
  it('handles floating-point frequencies correctly', () => {
    const freqs = [19.9, 20, 20.1, 99.9, 100, 100.1, 199.9, 200, 200.1];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    const filtered = Array.from(opt.preparedSubs[0].freqs);
    // 19.9 < 20 → excluded ; 200.1 > 200 → excluded
    expect(filtered[0]).toBeCloseTo(20);
    expect(filtered.at(-1)).toBeCloseTo(200);
    expect(filtered).not.toContain(19.9);
    expect(filtered.length).toBe(7); // 20, 20.1, 99.9, 100, 100.1, 199.9, 200
  });

  // ── Both subs get the same filtering ──
  it('applies the same binary search result to all subs', () => {
    const freqs = [5, 10, 20, 50, 100, 200, 300];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    const f0 = Array.from(opt.preparedSubs[0].freqs);
    const f1 = Array.from(opt.preparedSubs[1].freqs);
    expect(f0).toEqual(f1);
  });

  // ── Large array performance / correctness ──
  it('handles a large logarithmic frequency array', () => {
    // 1000 points logarithmically spaced from 1 Hz to 20 kHz
    const freqs = Array.from({ length: 1000 }, (_, i) =>
      Math.pow(10, 0 + (i / 999) * Math.log10(20000)),
    );
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    const filtered = opt.preparedSubs[0].freqs;
    expect(filtered[0]).toBeGreaterThanOrEqual(20);
    expect(filtered[filtered.length - 1]).toBeLessThanOrEqual(200);
    expect(filtered.length).toBeGreaterThan(0);
    // Check ordering preserved
    for (let i = 1; i < filtered.length; i++) {
      expect(filtered[i]).toBeGreaterThanOrEqual(filtered[i - 1]);
    }
  });

  // ── Param set to EMPTY_CONFIG ──
  it('assigns EMPTY_CONFIG param to each prepared sub', () => {
    const freqs = [20, 50, 100, 200];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    for (const sub of opt.preparedSubs) {
      expect(sub.param).toEqual(MultiSubOptimizer.EMPTY_CONFIG);
    }
  });
});
