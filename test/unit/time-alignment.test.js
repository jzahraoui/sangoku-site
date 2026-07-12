import { describe, expect, it } from 'vitest';

import {
  computeHybridAlignmentOffsets,
  crossCorrelationLag,
  hilbertEnvelope,
  spectralCentroid,
} from '../../src/dsp/time-alignment.js';
import { forwardRealFft } from '../../src/dsp/fft.js';

const SAMPLE_RATE = 48000;

/** IR synthétique : sinusoïde amortie large bande démarrant à startSample. */
function burst(length, startSample, { freq = 2000, decay = 800, amplitude = 1 } = {}) {
  const out = new Float64Array(length);
  for (let i = Math.ceil(startSample); i < length; i++) {
    const t = (i - startSample) / SAMPLE_RATE;
    out[i] = amplitude * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * decay);
  }
  return out;
}

/** IR type sub : bande étroite, montée lente (enveloppe gaussienne). */
function narrowBurst(length, centerSample, { freq = 60, widthMs = 25 } = {}) {
  const out = new Float64Array(length);
  const width = (widthMs / 1000) * SAMPLE_RATE;
  for (let i = 0; i < length; i++) {
    const x = (i - centerSample) / width;
    out[i] =
      Math.sin((2 * Math.PI * freq * (i - centerSample)) / SAMPLE_RATE) *
      Math.exp(-x * x);
  }
  return out;
}

describe('hilbertEnvelope', () => {
  it('is flat for a pure tone and peaks at the burst', () => {
    const signal = burst(4096, 1000);
    const envelope = hilbertEnvelope(signal, 8192);
    let peakIndex = 0;
    for (let i = 0; i < 4096; i++) {
      if (envelope[i] > envelope[peakIndex]) peakIndex = i;
    }
    // Le pic d'enveloppe est au voisinage immédiat du départ du burst
    expect(Math.abs(peakIndex - 1000)).toBeLessThan(24);
    // L'enveloppe domine le signal redressé
    for (let i = 0; i < 4096; i++) {
      expect(envelope[i]).toBeGreaterThanOrEqual(Math.abs(signal[i]) - 1e-9);
    }
  });
});

describe('spectralCentroid', () => {
  it('lands near the dominant frequency', () => {
    const wideband = burst(4096, 500, { freq: 3000 });
    const narrow = narrowBurst(8192, 4000, { freq: 60 });
    const centroidWide = spectralCentroid(forwardRealFft(wideband, 8192), SAMPLE_RATE);
    const centroidNarrow = spectralCentroid(forwardRealFft(narrow, 16384), SAMPLE_RATE);
    expect(centroidWide).toBeGreaterThan(2000);
    expect(centroidWide).toBeLessThan(4500);
    expect(centroidNarrow).toBeGreaterThan(40);
    expect(centroidNarrow).toBeLessThan(90);
  });
});

describe('crossCorrelationLag', () => {
  it('recovers an integer lag', () => {
    const a = burst(4096, 1100);
    const b = burst(4096, 1000);
    const lag = crossCorrelationLag(forwardRealFft(a, 8192), forwardRealFft(b, 8192));
    expect(lag).toBeCloseTo(100, 1);
  });

  it('recovers a fractional lag', () => {
    const a = burst(4096, 1000.5);
    const b = burst(4096, 1000);
    const lag = crossCorrelationLag(forwardRealFft(a, 8192), forwardRealFft(b, 8192));
    expect(Math.abs(lag - 0.5)).toBeLessThan(0.1);
  });

  it('is polarity-insensitive by default', () => {
    const a = burst(4096, 1050).map(v => -v);
    const b = burst(4096, 1000);
    const lag = crossCorrelationLag(forwardRealFft(a, 8192), forwardRealFft(b, 8192));
    expect(lag).toBeCloseTo(50, 1);
  });

  it('honours the constrained search window', () => {
    const a = burst(4096, 1100);
    const b = burst(4096, 1000);
    const lag = crossCorrelationLag(forwardRealFft(a, 8192), forwardRealFft(b, 8192), {
      maxLag: 10,
      center: 95,
    });
    expect(lag).toBeGreaterThanOrEqual(85);
    expect(lag).toBeLessThanOrEqual(105);
  });
});

describe('computeHybridAlignmentOffsets', () => {
  it('recovers known delays on wideband bursts (reference = first)', () => {
    const irs = [burst(4096, 1000), burst(4096, 1240), burst(4096, 880)];
    const offsets = computeHybridAlignmentOffsets(irs, { sampleRate: SAMPLE_RATE });
    expect(offsets[0]).toBe(0);
    expect(offsets[1] * SAMPLE_RATE).toBeCloseTo(240, 0);
    expect(offsets[2] * SAMPLE_RATE).toBeCloseTo(-120, 0);
  });

  it('does not cycle-skip on narrowband (sub-like) IRs shifted by > 1 period', () => {
    // Période à 60 Hz = 800 échantillons ; décalage de 2000 ≈ 2.5 périodes.
    // Une corrélation brute non contrainte peut se verrouiller à ±1 période ;
    // l'estimation grossière par enveloppe doit garder le bon lobe.
    const irs = [narrowBurst(16384, 4000), narrowBurst(16384, 6000)];
    const offsets = computeHybridAlignmentOffsets(irs, { sampleRate: SAMPLE_RATE });
    expect(offsets[1] * SAMPLE_RATE).toBeCloseTo(2000, -1);
  });

  it('integrates the startTime differences into the offsets', () => {
    const irs = [burst(4096, 1000), burst(4096, 1000)];
    const offsets = computeHybridAlignmentOffsets(irs, {
      sampleRate: SAMPLE_RATE,
      startTimes: [0, 0.005],
    });
    // Mêmes données mais la 2e IR démarre 5 ms plus tard dans l'absolu
    expect(offsets[1]).toBeCloseTo(0.005, 6);
  });

  it('validates its inputs', () => {
    expect(() => computeHybridAlignmentOffsets([burst(64, 10)], { sampleRate: 48000 })).toThrow(
      TypeError,
    );
    expect(() =>
      computeHybridAlignmentOffsets([burst(64, 10), burst(64, 12)], { sampleRate: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      computeHybridAlignmentOffsets([burst(64, 10), burst(64, 12)], {
        sampleRate: 48000,
        startTimes: [0],
      }),
    ).toThrow(RangeError);
  });
});
