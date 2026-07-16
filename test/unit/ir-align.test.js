import { describe, expect, it } from 'vitest';

import {
  alignImpulseResponses,
  crossoverAlignmentWindowMs,
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
    // depuis le clamp du repli contraint : STRICTEMENT dans les bornes
    expect(result.delayMs).toBeGreaterThanOrEqual(-0.5);
    expect(result.delayMs).toBeLessThanOrEqual(3);
    expect(result.withinBounds).toBe(true);
  });

  it('clamps the constrained refinement overshoot to the max bound', () => {
    // B en AVANCE de 148 échantillons → délai requis +3.0833 ms, juste
    // au-delà de la borne haute : le repli contraint retient le lag entier à
    // la borne (l'épaule du vrai lobe), l'affinage sinc tire vers le vrai
    // pic et débordait avant le clamp — le mécanisme des 6 refus « Delay too
    // large » du golden ir-align (≤ 3 échantillons).
    const a = burst(16384, 2000);
    const b = burst(16384, 2000 - 148); // délai requis : +148/48 = 3.0833 ms
    const result = alignImpulseResponses(makeIr(a), makeIr(b), {
      frequency: 80,
      minDelayMs: -0.5,
      maxDelayMs: 3,
    });
    expect(Math.abs(result.requiredDelayMs - 3.0833)).toBeLessThan(0.05);
    expect(result.delayMs).toBe(3);
    expect(result.withinBounds).toBe(true);
  });

  it('clamps the constrained refinement overshoot to the min bound', () => {
    // Symétrique côté bas : B en RETARD de 28 échantillons → délai requis
    // −0.5833 ms, juste sous la borne basse −0.5 ms.
    const a = burst(16384, 2000);
    const b = burst(16384, 2000 + 28); // délai requis : −28/48 = −0.5833 ms
    const result = alignImpulseResponses(makeIr(a), makeIr(b), {
      frequency: 80,
      minDelayMs: -0.5,
      maxDelayMs: 3,
    });
    expect(Math.abs(result.requiredDelayMs - -0.5833)).toBeLessThan(0.05);
    expect(result.delayMs).toBe(-0.5);
    expect(result.withinBounds).toBe(true);
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

describe('crossoverAlignmentWindowMs (fenêtre partagée bouton/auto)', () => {
  it('fenêtre centrée = ±T/4 (±250/fc ms), largeur un demi-cycle', () => {
    expect(crossoverAlignmentWindowMs(250)).toEqual({ minMs: -1, maxMs: 1 });
    expect(crossoverAlignmentWindowMs(40)).toEqual({ minMs: -6.25, maxMs: 6.25 });
    const w120 = crossoverAlignmentWindowMs(120);
    expect(w120.maxMs).toBeCloseTo(2.0833, 3);
    expect(w120.minMs).toBeCloseTo(-2.0833, 3);
  });

  it('fenêtre avant = [0, T/2] (Find Sub Alignment), même valeur que produceAligned', () => {
    // produceAligned : Math.round((cutoffPeriod/2)*1000*100)/100.
    for (const fc of [40, 80, 120, 250]) {
      const { minMs, maxMs } = crossoverAlignmentWindowMs(fc, { forward: true });
      expect(minMs).toBe(0);
      const rounded = Math.round(maxMs * 100) / 100;
      const legacy = Math.round(((1 / fc) / 2) * 1000 * 100) / 100;
      expect(rounded).toBe(legacy);
    }
  });

  it('à 250 Hz la fenêtre centrée vaut l’ancien ±1 ms fixe', () => {
    expect(crossoverAlignmentWindowMs(250)).toEqual({ minMs: -1, maxMs: 1 });
  });

  it('rejette une fréquence non positive', () => {
    expect(() => crossoverAlignmentWindowMs(0)).toThrow(RangeError);
    expect(() => crossoverAlignmentWindowMs(-80)).toThrow(RangeError);
  });
});
