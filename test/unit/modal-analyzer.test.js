import { describe, it, expect } from 'vitest';
import {
  detectModalFrequencies,
  seedQFromPeakWidth,
} from '../../src/autoeq/math/modalAnalyzer.js';
import {
  createPeakingProfiles,
  sumProfilesDbAtFrequency,
} from '../../src/dsp/peakingProfiles.js';

const SAMPLE_RATE = 48000;
const BAND = { minFreq: 20, maxFreq: 300 };

/** Log-spaced scan grid, same shape as the AutoEQ scan grid. */
function makeGrid(minFreq = 15, maxFreq = 500, ppo = 96) {
  const octaves = Math.log2(maxFreq / minFreq);
  const count = Math.ceil(octaves * ppo) + 1;
  const freqs = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    freqs[i] = minFreq * Math.pow(2, (octaves * i) / (count - 1));
  }
  return freqs;
}

/** Residual curve synthesized from known peaking biquads (dB above target). */
function makeResidual(freqs, filters) {
  const profiles = createPeakingProfiles(filters, SAMPLE_RATE);
  return Float64Array.from(freqs, (f) =>
    sumProfilesDbAtFrequency(profiles, f, SAMPLE_RATE),
  );
}

function detect(freqs, residuals, overrides = {}) {
  return detectModalFrequencies({ freqs, residuals, ...BAND, ...overrides });
}

describe('detectModalFrequencies', () => {
  it('finds an isolated mode within ±2 %', () => {
    const freqs = makeGrid();
    const residuals = makeResidual(freqs, [{ fc: 75, Q: 4, gain: 8 }]);
    const modes = detect(freqs, residuals);
    expect(modes).toHaveLength(1);
    expect(modes[0].fc).toBeGreaterThan(75 * 0.98);
    expect(modes[0].fc).toBeLessThan(75 * 1.02);
  });

  it('separates a fused doublet a third of an octave apart', () => {
    const freqs = makeGrid();
    const residuals = makeResidual(freqs, [
      { fc: 60, Q: 6, gain: 6 },
      { fc: 76, Q: 6, gain: 6 },
    ]);
    const modes = detect(freqs, residuals);
    expect(modes).toHaveLength(2);
    expect(modes[0].fc).toBeGreaterThan(60 * 0.97);
    expect(modes[0].fc).toBeLessThan(60 * 1.03);
    expect(modes[1].fc).toBeGreaterThan(76 * 0.97);
    expect(modes[1].fc).toBeLessThan(76 * 1.03);
  });

  it('reports nothing on a smooth tilted residual', () => {
    const freqs = makeGrid();
    const residuals = Float64Array.from(freqs, (f) => {
      const t = Math.log2(f / 15) / Math.log2(500 / 15);
      return 2 - 4 * t;
    });
    expect(detect(freqs, residuals)).toHaveLength(0);
  });

  it('ignores dips (below-target residual has no positive mode)', () => {
    const freqs = makeGrid();
    const residuals = makeResidual(freqs, [{ fc: 90, Q: 4, gain: -8 }]);
    expect(detect(freqs, residuals)).toHaveLength(0);
  });

  it('returns an empty list on a degenerate band', () => {
    const freqs = makeGrid();
    const residuals = makeResidual(freqs, [{ fc: 75, Q: 4, gain: 8 }]);
    expect(
      detectModalFrequencies({
        freqs,
        residuals,
        minFreq: 300,
        maxFreq: 300,
      }),
    ).toHaveLength(0);
  });
});

describe('seedQFromPeakWidth', () => {
  function seedQ(freqs, residuals, fc) {
    return seedQFromPeakWidth({ freqs, residuals, fc, ...BAND });
  }

  it('recovers the Q of an isolated peak (patent G/√2.5 criterion)', () => {
    const freqs = makeGrid();
    const residuals = makeResidual(freqs, [{ fc: 120, Q: 2, gain: 4 }]);
    const q = seedQ(freqs, residuals, 120);
    // Patent worked example: G=4 dB, Q=2 → Q̂ ≈ 2.1
    expect(q).toBeGreaterThan(1.6);
    expect(q).toBeLessThan(2.6);
  });

  it('recovers a narrow modal Q within ±30 %', () => {
    const freqs = makeGrid();
    const residuals = makeResidual(freqs, [{ fc: 75, Q: 6, gain: 8 }]);
    const q = seedQ(freqs, residuals, 75);
    expect(q).toBeGreaterThan(6 * 0.7);
    expect(q).toBeLessThan(6 * 1.3);
  });

  it('mirrors the half-width for a peak truncated by the band edge', () => {
    const freqs = makeGrid();
    const residuals = makeResidual(freqs, [{ fc: 24, Q: 2, gain: 6 }]);
    const q = seedQFromPeakWidth({
      freqs,
      residuals,
      fc: 24,
      minFreq: 22,
      maxFreq: 300,
    });
    expect(q).toBeGreaterThan(1);
    expect(q).toBeLessThan(4);
  });

  it('falls back to valley spacing for a buried shoulder peak', () => {
    const freqs = makeGrid();
    const residuals = makeResidual(freqs, [
      { fc: 80, Q: 3, gain: 8 },
      { fc: 115, Q: 8, gain: 3 },
    ]);
    const q = seedQ(freqs, residuals, 115);
    expect(q).not.toBeNull();
    expect(q).toBeGreaterThan(0.5);
    expect(q).toBeLessThanOrEqual(20);
  });

  it('returns null when there is nothing to measure at fc', () => {
    const freqs = makeGrid();
    const residuals = makeResidual(freqs, [{ fc: 80, Q: 3, gain: -6 }]);
    expect(seedQ(freqs, residuals, 80)).toBeNull();
  });
});
