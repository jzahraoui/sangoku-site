import { describe, it, expect } from 'vitest';
import { AutoEQCalculator } from '../../src/autoeq/AutoEQCalculator.js';
import {
  createPeakingProfiles,
  sumProfilesDbAtFrequency,
} from '../../src/dsp/peakingProfiles.js';

const SAMPLE_RATE = 48000;

/**
 * Synthetic modal measurement: flat 75 dB target, measured = target + a
 * fused low-frequency mode doublet plus a broader mid bump.
 */
function makeResponses() {
  const minFreq = 20;
  const maxFreq = 2000;
  const ppo = 48;
  const octaves = Math.log2(maxFreq / minFreq);
  const count = Math.ceil(octaves * ppo) + 1;
  const freqs = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    freqs[i] = minFreq * Math.pow(2, (octaves * i) / (count - 1));
  }
  const profiles = createPeakingProfiles(
    [
      { fc: 60, Q: 6, gain: 7 },
      { fc: 76, Q: 6, gain: 6 },
      { fc: 320, Q: 2, gain: 4 },
    ],
    SAMPLE_RATE,
  );
  const measured = Float64Array.from(
    freqs,
    (f) => 75 + sumProfilesDbAtFrequency(profiles, f, SAMPLE_RATE),
  );
  const target = new Float64Array(count).fill(75);
  return {
    measuredSPL: { freqs, magnitude: measured },
    targetCurve: { freqs, magnitude: target },
  };
}

function makeConfig(overrides = {}, logs = null) {
  return {
    sampleRate: SAMPLE_RATE,
    numFilters: 6,
    matchRangeStart: 20,
    matchRangeEnd: 1900,
    onLog: logs ? (m) => logs.push(m) : () => {},
    onProgress: () => {},
    ...overrides,
  };
}

describe('modal seeding integration (enableModalSeeding)', () => {
  it('runs the modal challenger and never degrades the evaluator metrics', async () => {
    const { measuredSPL, targetCurve } = makeResponses();

    const offCalc = new AutoEQCalculator(makeConfig());
    await offCalc.calculate(measuredSPL, targetCurve);
    const off = offCalc.lastQualityReport;

    const logs = [];
    const onCalc = new AutoEQCalculator(
      makeConfig({ enableModalSeeding: true }, logs),
    );
    await onCalc.calculate(measuredSPL, targetCurve);
    const on = onCalc.lastQualityReport;

    // The modal challenger must have run and logged its seeds and verdict.
    expect(logs.some((m) => m.includes('Seeds modaux (LPC)'))).toBe(true);
    expect(logs.some((m) => m.includes('Challenger modal (LPC)'))).toBe(true);

    // Structural guarantee of the acceptance gate: no regression beyond the
    // challenger margins, whichever way the challenger verdict went.
    expect(on.fullRms).toBeLessThanOrEqual(off.fullRms + 0.011);
    expect(on.criticalRms).toBeLessThanOrEqual(off.criticalRms + 0.011);
    expect(on.maxOvershoot).toBeLessThanOrEqual(off.maxOvershoot + 0.101);
    expect(on.positiveRms).toBeLessThanOrEqual(off.positiveRms + 0.011);
    expect(onCalc.filterSet.getActiveFilters().length).toBeGreaterThan(0);
  });

  it('is bit-identical to the default pipeline when the flag is off', async () => {
    const { measuredSPL, targetCurve } = makeResponses();

    const a = new AutoEQCalculator(makeConfig());
    await a.calculate(measuredSPL, targetCurve);
    const b = new AutoEQCalculator(makeConfig({ enableModalSeeding: false }));
    await b.calculate(measuredSPL, targetCurve);

    expect(b.filterSet.getActiveFilters()).toEqual(a.filterSet.getActiveFilters());
  });
});
