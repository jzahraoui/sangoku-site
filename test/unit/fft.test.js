import { describe, expect, it } from 'vitest';
import { fft as mathFft, ifft as mathIfft } from 'mathjs';

import { fftInPlace, forwardRealFft, nextPowerOfTwo } from '../../src/dsp/fft.js';

function randomSignal(n, seed = 42) {
  // LCG déterministe — pas de dépendance à Math.random
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
  return Float64Array.from({ length: n }, next);
}

describe('fftInPlace', () => {
  it('matches mathjs fft on a real signal', () => {
    const n = 1024;
    const signal = randomSignal(n);
    const { re, im } = forwardRealFft(signal, n);
    const reference = mathFft(Array.from(signal));
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(reference[i].re, 8);
      expect(im[i]).toBeCloseTo(reference[i].im, 8);
    }
  });

  it('matches mathjs ifft (inverse transform)', () => {
    const n = 512;
    const signal = randomSignal(n, 7);
    const { re, im } = forwardRealFft(signal, n);
    fftInPlace(re, im, true);
    const reference = mathIfft(mathFft(Array.from(signal)));
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(reference[i].re, 8);
      expect(im[i]).toBeCloseTo(reference[i].im, 8);
    }
  });

  it('round-trips fft → ifft back to the input', () => {
    const n = 2048;
    const signal = randomSignal(n, 99);
    const { re, im } = forwardRealFft(signal, n);
    fftInPlace(re, im, true);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(signal[i], 10);
      expect(im[i]).toBeCloseTo(0, 10);
    }
  });

  it('rejects non power-of-two lengths', () => {
    expect(() => fftInPlace(new Float64Array(100), new Float64Array(100))).toThrow(
      RangeError,
    );
    expect(() => fftInPlace(new Float64Array(8), new Float64Array(4))).toThrow(
      RangeError,
    );
  });
});

describe('forwardRealFft / nextPowerOfTwo', () => {
  it('zero-pads to the requested size', () => {
    const { re, im } = forwardRealFft([1, 0, 0], 8);
    // Impulsion → spectre plat unitaire
    for (let i = 0; i < 8; i++) {
      expect(re[i]).toBeCloseTo(1, 12);
      expect(im[i]).toBeCloseTo(0, 12);
    }
  });

  it('rejects a size smaller than the signal', () => {
    expect(() => forwardRealFft(new Float64Array(16), 8)).toThrow(RangeError);
  });

  it('nextPowerOfTwo covers edge cases', () => {
    expect(nextPowerOfTwo(1)).toBe(2);
    expect(nextPowerOfTwo(2)).toBe(2);
    expect(nextPowerOfTwo(3)).toBe(4);
    expect(nextPowerOfTwo(16384)).toBe(16384);
    expect(nextPowerOfTwo(16385)).toBe(32768);
  });
});
