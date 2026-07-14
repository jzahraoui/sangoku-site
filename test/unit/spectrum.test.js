import { describe, expect, it } from 'vitest';
import { complexSpectrumAt, logSpacedFrequencies } from '../../src/dsp/spectrum.js';
import { getCascadeComplexResponse } from '../../src/dsp/biquadResponse.js';
import { buildCrossoverCascade } from '../../src/measurement/rew-filter-bank.js';
import { processThroughCascade } from '../../src/dsp/impulseResponse.js';

const SR = 48000;

describe('logSpacedFrequencies', () => {
  it('inclut exactement les deux bornes et reste croissante', () => {
    const grid = logSpacedFrequencies(20, 120, 16);
    expect(grid[0]).toBe(20);
    expect(grid[grid.length - 1]).toBe(120);
    for (let i = 1; i < grid.length; i++) {
      expect(grid[i]).toBeGreaterThan(grid[i - 1]);
    }
    // ~2.585 octaves × 16 points/octave + 1
    expect(grid).toHaveLength(Math.ceil(Math.log2(120 / 20) * 16) + 1);
  });

  it('espace les points uniformément en log2', () => {
    const grid = logSpacedFrequencies(20, 80, 1);
    expect(Array.from(grid)).toEqual([20, 40, 80]);
  });

  it('rejette une bande ou une densité invalide', () => {
    expect(() => logSpacedFrequencies(0, 120, 16)).toThrow('Invalid frequency band');
    expect(() => logSpacedFrequencies(120, 20, 16)).toThrow('Invalid frequency band');
    expect(() => logSpacedFrequencies(20, 120, 0)).toThrow('points per octave');
  });
});

describe('complexSpectrumAt', () => {
  it('un Dirac décalé donne un module 1 et la phase −2πf·t du référentiel absolu', () => {
    const delaySamples = 480; // 10 ms à 48 kHz
    const startTime = 0.002;
    const data = new Float64Array(4096);
    data[delaySamples] = 1;

    const frequencies = [25, 60, 120];
    const { re, im } = complexSpectrumAt({ data, sampleRate: SR, startTime }, frequencies);

    for (let k = 0; k < frequencies.length; k++) {
      const t = startTime + delaySamples / SR;
      const expectedPhase = -2 * Math.PI * frequencies[k] * t;
      expect(Math.hypot(re[k], im[k])).toBeCloseTo(1, 9);
      expect(Math.atan2(im[k], re[k])).toBeCloseTo(
        Math.atan2(Math.sin(expectedPhase), Math.cos(expectedPhase)),
        9,
      );
    }
  });

  it('est linéaire : le spectre d\'une somme est la somme des spectres', () => {
    const a = new Float64Array(2048);
    const b = new Float64Array(2048);
    a[100] = 1;
    a[300] = -0.5;
    b[50] = 0.75;
    const sum = Float64Array.from(a, (v, i) => v + b[i]);
    const frequencies = [40, 90];

    const sa = complexSpectrumAt({ data: a, sampleRate: SR, startTime: 0 }, frequencies);
    const sb = complexSpectrumAt({ data: b, sampleRate: SR, startTime: 0 }, frequencies);
    const ss = complexSpectrumAt({ data: sum, sampleRate: SR, startTime: 0 }, frequencies);

    for (let k = 0; k < frequencies.length; k++) {
      expect(ss.re[k]).toBeCloseTo(sa.re[k] + sb.re[k], 9);
      expect(ss.im[k]).toBeCloseTo(sa.im[k] + sb.im[k], 9);
    }
  });

  it('filtrage temporel (processThroughCascade) ≡ réponse analytique de la cascade', () => {
    // Le cœur du sweep passe-bas LFE : appliquer le LR24 en fréquentiel doit
    // donner le même spectre que filtrer l'IR puis re-mesurer.
    const data = new Float64Array(8192);
    data[200] = 1;
    data[450] = -0.4;
    data[900] = 0.25;
    const ir = { data, sampleRate: SR, startTime: -0.001 };

    const cascade = buildCrossoverCascade(
      { type: 'Low pass', frequency: 80, shape: 'L-R', slopedBPerOctave: 24 },
      SR,
    );
    const filteredIr = { ...ir, data: processThroughCascade(data, cascade) };

    const grid = logSpacedFrequencies(20, 120, 8);
    const raw = complexSpectrumAt(ir, grid);
    const filtered = complexSpectrumAt(filteredIr, grid);

    for (let k = 0; k < grid.length; k++) {
      const h = getCascadeComplexResponse(cascade, grid[k], SR);
      expect(filtered.re[k]).toBeCloseTo(raw.re[k] * h.re - raw.im[k] * h.im, 8);
      expect(filtered.im[k]).toBeCloseTo(raw.re[k] * h.im + raw.im[k] * h.re, 8);
    }
  });

  it('rejette une IR invalide', () => {
    expect(() => complexSpectrumAt({ data: [], sampleRate: SR }, [40])).toThrow(
      'Invalid impulse response',
    );
  });
});

describe('getCascadeComplexResponse', () => {
  it('cascade vide = identité ; LR24 vaut −6 dB à fc', () => {
    const identity = getCascadeComplexResponse([], 80, SR);
    expect(identity).toEqual({ re: 1, im: 0 });

    const cascade = buildCrossoverCascade(
      { type: 'Low pass', frequency: 80, shape: 'L-R', slopedBPerOctave: 24 },
      SR,
    );
    const h = getCascadeComplexResponse(cascade, 80, SR);
    expect(20 * Math.log10(Math.hypot(h.re, h.im))).toBeCloseTo(-6.02, 1);
  });
});
