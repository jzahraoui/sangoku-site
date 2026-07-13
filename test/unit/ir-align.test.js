import { describe, expect, it } from 'vitest';

import {
  alignImpulseResponses,
  fractionalShift,
  octaveBandPass,
} from '../../src/dsp/ir-align.js';

const SR = 48000;

/** Burst amorti large bande démarrant à startSample. */
function burst(length, startSample, { freq = 80, decay = 60, amplitude = 1 } = {}) {
  const out = new Float64Array(length);
  for (let i = Math.ceil(startSample); i < length; i++) {
    const t = (i - startSample) / SR;
    out[i] = amplitude * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * decay);
  }
  return out;
}

describe('octaveBandPass (1/3 octave, ordre 6, zéro phase)', () => {
  it('passes the centre frequency without phase shift and rejects far bands', () => {
    const n = 16384;
    const tone = f =>
      Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / SR));
    const atFc = octaveBandPass(tone(80), { fc: 80, sampleRate: SR });
    const far = octaveBandPass(tone(640), { fc: 80, sampleRate: SR });
    // amplitude au centre ≈ 1, phase nulle (échantillons alignés sur l'entrée)
    const mid = n / 2;
    const inputMid = Math.sin((2 * Math.PI * 80 * mid) / SR);
    expect(atFc[mid]).toBeCloseTo(inputMid, 1);
    let rmsFar = 0;
    let rmsFc = 0;
    for (let i = n / 4; i < (3 * n) / 4; i++) {
      rmsFar += far[i] * far[i];
      rmsFc += atFc[i] * atFc[i];
    }
    expect(Math.sqrt(rmsFar / rmsFc)).toBeLessThan(0.01); // > 40 dB de réjection
  });
});

describe('fractionalShift', () => {
  it('shifts a signal by a fractional sample (round trip)', () => {
    const signal = burst(4096, 1000, { freq: 500, decay: 0 });
    const forth = fractionalShift(signal, 0.5 / SR, 1 / SR);
    const back = fractionalShift(forth, -0.5 / SR, 1 / SR);
    // le tour circulaire FFT laisse ~1e-4 de fuite aux bords : sans effet sur
    // la précision du délai (cible ~0.01 ms)
    for (let i = 1200; i < 2800; i++) {
      expect(back[i]).toBeCloseTo(signal[i], 3);
    }
  });
});

describe('alignImpulseResponses', () => {
  const makeIr = (data, startTime = 0) => ({ data, sampleRate: SR, startTime });

  it('recovers a known delay within bounds, no inversion', () => {
    const a = burst(16384, 2000);
    const b = burst(16384, 2000 + 48); // B en retard de 1 ms
    const result = alignImpulseResponses(makeIr(a), makeIr(b), {
      frequency: 80,
      minDelayMs: -3,
      maxDelayMs: 3,
    });
    expect(result.withinBounds).toBe(true);
    expect(Math.abs(Math.abs(result.delayMs) - 1)).toBeLessThan(0.05);
    expect(result.invertB).toBe(false);
  });

  it('detects an inverted B', () => {
    const a = burst(16384, 2000);
    const b = burst(16384, 2000 + 24).map(v => -v);
    const result = alignImpulseResponses(makeIr(a), makeIr(Float64Array.from(b)), {
      frequency: 80,
      minDelayMs: -3,
      maxDelayMs: 3,
    });
    expect(result.invertB).toBe(true);
    expect(Math.abs(Math.abs(result.delayMs) - 0.5)).toBeLessThan(0.05);
  });

  it('reports the required delay and falls back to the constrained search', () => {
    const a = burst(16384, 2000);
    const b = burst(16384, 2000 + 480); // 10 ms — hors bornes [−0.5, 3]
    const result = alignImpulseResponses(makeIr(a), makeIr(b), {
      frequency: 80,
      minDelayMs: -0.5,
      maxDelayMs: 3,
    });
    expect(Math.abs(Math.abs(result.requiredDelayMs) - 10)).toBeLessThan(0.2);
    // le résultat contraint reste dans les bornes
    expect(result.delayMs).toBeGreaterThanOrEqual(-0.5 - 0.13);
    expect(result.delayMs).toBeLessThanOrEqual(3 + 0.13);
  });

  it('honours differing start times through the common reference', () => {
    const a = burst(16384, 2000);
    const b = burst(16384, 2000); // mêmes données…
    const result = alignImpulseResponses(
      makeIr(a, 0),
      makeIr(b, 0.001), // …mais B démarre 1 ms plus tard dans l'absolu
      { frequency: 80, minDelayMs: -3, maxDelayMs: 3 },
    );
    expect(Math.abs(Math.abs(result.delayMs) - 1)).toBeLessThan(0.05);
  });

  it('validates its inputs', () => {
    const a = makeIr(burst(1024, 100));
    expect(() => alignImpulseResponses(a, { data: [], sampleRate: SR }, { frequency: 80 })).toThrow(
      TypeError,
    );
    expect(() =>
      alignImpulseResponses(a, { data: burst(1024, 100), sampleRate: 44100 }, { frequency: 80 }),
    ).toThrow(RangeError);
    expect(() =>
      alignImpulseResponses(a, makeIr(burst(1024, 100)), { frequency: 10 }),
    ).toThrow(RangeError);
  });
});
