import { describe, expect, it } from 'vitest';

import {
  applyBankAndCrossoverToIr,
  buildCrossoverCascade,
} from '../../src/measurement/rew-filter-bank.js';
import {
  combineImpulseResponses,
  computeCascadeImpulseResponse,
  peakTimeSeconds,
  processThroughCascade,
} from '../../src/dsp/impulseResponse.js';
import { getCascadeComplexResponse } from '../../src/dsp/biquadResponse.js';

describe('buildCrossoverCascade', () => {
  it('realises the two simulated bass-management filters', () => {
    expect(
      buildCrossoverCascade(
        { type: 'Low pass', frequency: 80, shape: 'L-R', slopedBPerOctave: 24 },
        48000,
      ),
    ).toHaveLength(2);
    expect(
      buildCrossoverCascade(
        { type: 'High pass', frequency: 80, shape: 'BU', slopedBPerOctave: 12 },
        48000,
      ),
    ).toHaveLength(1);
  });

  it('rejects any other shape/slope explicitly', () => {
    expect(() =>
      buildCrossoverCascade(
        { type: 'Low pass', frequency: 80, shape: 'BU', slopedBPerOctave: 48 },
        48000,
      ),
    ).toThrow('Unsupported crossover filter');
    expect(() =>
      buildCrossoverCascade(
        { type: 'High pass', frequency: 80, shape: 'L-R', slopedBPerOctave: 12 },
        48000,
      ),
    ).toThrow('Unsupported crossover filter');
  });

  it('realises High pass L-R 24 as two cascaded BW12 (electrical high-pass option)', () => {
    const cascade = buildCrossoverCascade(
      { type: 'High pass', frequency: 80, shape: 'L-R', slopedBPerOctave: 24 },
      48000,
    );
    expect(cascade).toHaveLength(2);

    // −6.02 dB à fc (chaque BW2 HP vaut −3.01 dB à fc)
    const atFc = getCascadeComplexResponse(cascade, 80, 48000);
    const magDbAtFc = 20 * Math.log10(Math.hypot(atFc.re, atFc.im));
    expect(magDbAtFc).toBeCloseTo(-6.02, 1);

    // Propriété Linkwitz-Riley : LR24 HP + LR24 LP en phase partout →
    // |HP(f) + LP(f)| = 1 sur toute la bande.
    const lowPass = buildCrossoverCascade(
      { type: 'Low pass', frequency: 80, shape: 'L-R', slopedBPerOctave: 24 },
      48000,
    );
    for (const freq of [20, 40, 80, 160, 320, 1000]) {
      const hp = getCascadeComplexResponse(cascade, freq, 48000);
      const lp = getCascadeComplexResponse(lowPass, freq, 48000);
      const sum = Math.hypot(hp.re + lp.re, hp.im + lp.im);
      expect(sum).toBeCloseTo(1, 6);
    }
  });
});

describe('processThroughCascade / peakTimeSeconds', () => {
  it('matches the unit-impulse cascade on a delta input', () => {
    const cascade = buildCrossoverCascade(
      { type: 'Low pass', frequency: 80, shape: 'L-R', slopedBPerOctave: 24 },
      48000,
    );
    const delta = new Float64Array(64);
    delta[0] = 1;

    expect(Array.from(processThroughCascade(delta, cascade))).toEqual(
      Array.from(computeCascadeImpulseResponse(cascade, 64)),
    );
  });

  it('refines the peak below the sample grid (parabola on |x|)', () => {
    // symmetric triangle around index 3 → refinement lands exactly on 3
    const data = [0, 0, 0.5, 1, 0.5, 0, 0];
    expect(peakTimeSeconds({ data, sampleRate: 1000, startTime: -0.001 })).toBeCloseTo(
      -0.001 + 3 / 1000,
      12,
    );
    // asymmetric neighbours pull the refined peak toward the larger one
    const skewed = [0, 0, 0.4, 1, 0.8, 0, 0];
    const refined = peakTimeSeconds({ data: skewed, sampleRate: 1000, startTime: 0 });
    expect(refined).toBeGreaterThan(3 / 1000);
    expect(refined).toBeLessThan(4 / 1000);
  });
});

describe('applyBankAndCrossoverToIr', () => {
  it('applies the bank then the crossover and reports the peak', () => {
    const ir = {
      data: (() => {
        const data = new Float64Array(256);
        data[10] = 1;
        return data;
      })(),
      sampleRate: 48000,
      startTime: -0.001,
    };
    const bank = [
      { index: 1, type: 'PK', enabled: true, isAuto: true, frequency: 60, q: 2, gaindB: -4 },
    ];

    const filtered = applyBankAndCrossoverToIr(ir, bank, {
      type: 'Low pass',
      frequency: 80,
      shape: 'L-R',
      slopedBPerOctave: 24,
    });

    expect(filtered.sampleRate).toBe(48000);
    expect(filtered.startTime).toBe(-0.001);
    expect(filtered.data).toHaveLength(256);
    // the low pass delays and spreads the impulse: the peak moves after t=10
    expect(filtered.timeOfIRPeakSeconds).toBeGreaterThan(-0.001 + 10 / 48000);
    // input untouched
    expect(ir.data[10]).toBe(1);
  });

  it('is a plain copy analysis with an empty bank and no crossover', () => {
    const data = [0, 1, 0, 0];
    const filtered = applyBankAndCrossoverToIr({ data, sampleRate: 48000, startTime: 0 }, []);
    expect(Array.from(filtered.data)).toEqual(data);
    expect(filtered.timeOfIRPeakSeconds).toBeCloseTo(1 / 48000, 12);
  });
});

describe('combineImpulseResponses', () => {
  const fs = 48000;

  it('sums on the common absolute grid (integer startTime offsets)', () => {
    // impulse A at absolute sample 2, impulse B at absolute sample 5
    const a = { data: [0, 0, 1, 0, 0, 0], sampleRate: fs, startTime: 0 };
    const b = { data: [0, 1, 0, 0], sampleRate: fs, startTime: 4 / fs };
    const sum = combineImpulseResponses([a, b]);

    expect(sum.startTime).toBe(0);
    expect(Array.from(sum.data)).toEqual([0, 0, 1, 0, 0, 1, 0, 0]);
  });

  it('applies the relative dB weights (IR exports carry no SPL offset)', () => {
    const a = { data: [1, 0], sampleRate: fs, startTime: 0 };
    const b = { data: [0, 1], sampleRate: fs, startTime: 0 };
    const sum = combineImpulseResponses([a, b], [0, 20]);

    expect(sum.data[0]).toBeCloseTo(1, 12);
    expect(sum.data[1]).toBeCloseTo(10, 12);
  });

  it('preserves absolute peak times across a fractional startTime residue', () => {
    // sinusoid burst whose peak sits at absolute time (16 + 0.5 + 8)/fs
    const burst = Array.from({ length: 64 }, (_, i) =>
      Math.exp(-((i - 8) ** 2) / 18),
    );
    const whole = { data: burst, sampleRate: fs, startTime: 16 / fs };
    const fractional = { data: burst, sampleRate: fs, startTime: 16.5 / fs };

    const sumWhole = combineImpulseResponses([whole]);
    const sumFractional = combineImpulseResponses([fractional]);

    const peakWhole = peakTimeSeconds(sumWhole);
    const peakFractional = peakTimeSeconds(sumFractional);
    expect((peakFractional - peakWhole) * fs).toBeCloseTo(0.5, 1);
  });

  it('rejects mismatched sample rates and empty input', () => {
    expect(() => combineImpulseResponses([])).toThrow('No impulse responses');
    expect(() =>
      combineImpulseResponses([
        { data: [1], sampleRate: 48000, startTime: 0 },
        { data: [1], sampleRate: 44100, startTime: 0 },
      ]),
    ).toThrow('Sample rates differ');
  });
});
