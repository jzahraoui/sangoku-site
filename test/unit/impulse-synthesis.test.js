import { describe, expect, it } from 'vitest';
import { synthesizeImpulseFromResponse } from '../../src/dsp/impulse-synthesis.js';

const linearGrid = (start, stop, step) => {
  const freqs = [];
  for (let f = start; f <= stop; f += step) freqs.push(f);
  return freqs;
};

describe('synthesizeImpulseFromResponse', () => {
  it('places the impulse peak at the delay encoded by the phase slope', () => {
    const t0 = 0.01; // 10 ms
    const freqs = linearGrid(20, 20000, 20);
    const magnitude = freqs.map(() => 0); // 0 dB flat
    const phase = freqs.map(f => -360 * f * t0);

    const { data, sampleRate } = synthesizeImpulseFromResponse(
      { freqs, magnitude, phase, freqStep: 20 },
      { sampleRate: 48000 },
    );

    let peakIndex = 0;
    for (let i = 1; i < data.length; i++) {
      if (Math.abs(data[i]) > Math.abs(data[peakIndex])) peakIndex = i;
    }
    expect(peakIndex / sampleRate).toBeCloseTo(t0, 4);
    expect(data[peakIndex]).toBeGreaterThan(0);
  });

  it('handles a band-limited LFE-like response', () => {
    const t0 = 0.02;
    const freqs = linearGrid(10, 200, 1);
    const magnitude = freqs.map(() => 75);
    const phase = freqs.map(f => -360 * f * t0);

    const { data, sampleRate } = synthesizeImpulseFromResponse(
      { freqs, magnitude, phase, freqStep: 1 },
      { sampleRate: 48000 },
    );

    let peakIndex = 0;
    for (let i = 1; i < data.length; i++) {
      if (Math.abs(data[i]) > Math.abs(data[peakIndex])) peakIndex = i;
    }
    // band-limited: the main lobe is broad, the argmax stays on the delay
    expect(Math.abs(peakIndex / sampleRate - t0)).toBeLessThan(0.002);
  });

  it('sizes the buffer from the finest grid spacing — 96-ppo log export included', () => {
    // Grille log 96 ppo pleine bande, SANS champ freqStep : la forme
    // d'export de REW 5.40 (API 0.9.5) observée en réel. L'ancien
    // dimensionnement moyennait linéairement cette grille (~20 Hz) et
    // tombait au plancher 4096 (premier bin utile ~12 Hz — rien sous
    // 23 Hz à l'écran).
    const ppo = 96;
    const freqs = [];
    let f = 5.859375;
    while (f <= 24000) {
      freqs.push(f);
      f *= Math.pow(2, 1 / ppo);
    }
    const response = {
      freqs,
      magnitude: freqs.map(() => 75),
      phase: freqs.map(() => 0),
      ppo,
    };

    const { data, startTimeSeconds } = synthesizeImpulseFromResponse(response, {
      sampleRate: 48000,
      center: true,
    });
    // Pas le plus fin = premier intervalle (~0,042 Hz à 5,86 Hz) → plafond.
    expect(data).toHaveLength(262144);
    expect(startTimeSeconds).toBeCloseTo(-data.length / 2 / 48000, 9);
  });

  it('keeps coarse linear grids on the small-buffer path (unchanged sizing)', () => {
    const freqs = linearGrid(20, 20000, 20);
    const { data } = synthesizeImpulseFromResponse(
      { freqs, magnitude: freqs.map(() => 0), phase: freqs.map(() => 0), freqStep: 20 },
      { sampleRate: 48000 },
    );
    // 48000/20 = 2400 → plancher 4096, comme avant.
    expect(data).toHaveLength(4096);
  });

  it('rejects inconsistent inputs', () => {
    expect(() =>
      synthesizeImpulseFromResponse({ freqs: [1, 2], magnitude: [0], phase: [0, 0] }),
    ).toThrow('lengths differ');
    expect(() => synthesizeImpulseFromResponse({})).toThrow('freqs');
  });
});

describe('synthèse à phase nulle (Theo)', () => {
  const flatZeroPhase = () => {
    const freqs = linearGrid(10, 200, 1);
    return {
      freqs,
      magnitude: freqs.map(() => 75),
      phase: freqs.map(() => 0),
      freqStep: 1,
    };
  };

  const argmax = data => {
    let peak = 0;
    for (let i = 1; i < data.length; i++) {
      if (Math.abs(data[i]) > Math.abs(data[peak])) peak = i;
    }
    return peak;
  };

  it('raw: the acausal half wraps to the end of the buffer', () => {
    const { data } = synthesizeImpulseFromResponse(flatZeroPhase(), {
      sampleRate: 48000,
    });
    expect(argmax(data)).toBe(0);
    // energy present at the very end of the buffer (wrapped anticausal half)
    const tail = data.slice(-data.length / 8);
    expect(Math.hypot(...tail)).toBeGreaterThan(Math.hypot(...data) / 10);
  });

  it('center: the impulse sits at the middle of the buffer, symmetric', () => {
    const { data } = synthesizeImpulseFromResponse(flatZeroPhase(), {
      sampleRate: 48000,
      center: true,
    });
    expect(argmax(data)).toBe(data.length / 2);
    // the energy concentrates around the centre, not at the buffer
    // boundaries (only residual band-edge ringing remains there)
    const head = data.slice(0, data.length / 16);
    const tail = data.slice(-data.length / 16);
    const centralQuarter = data.slice((data.length * 3) / 8, (data.length * 5) / 8);
    expect(Math.hypot(...head)).toBeLessThan(Math.hypot(...centralQuarter) / 20);
    expect(Math.hypot(...tail)).toBeLessThan(Math.hypot(...centralQuarter) / 20);
  });
});
