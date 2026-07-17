import { describe, expect, it } from 'vitest';

import { realInverseFft, forwardRealFft } from '../../src/dsp/fft.js';
import { makeExpSweep, estimateSweepInstFreq } from '../../src/dsp/sweep.js';
import { deconvolveFarina, kirkebyEps } from '../../src/dsp/farina-deconvolution.js';
import { linearSumAssignment } from '../../src/dsp/hungarian.js';

const SR = 48000;

describe('realInverseFft', () => {
  it('inverts forwardRealFft to recover the original real signal', () => {
    const n = 1024;
    const signal = Float64Array.from({ length: n }, (_, i) => Math.sin(i / 7) + 0.3 * Math.cos(i / 3));
    const { re, im } = forwardRealFft(signal, n);
    const back = realInverseFft(re, im, n);
    for (let i = 0; i < n; i++) expect(back[i]).toBeCloseTo(signal[i], 9);
  });
});

describe('makeExpSweep', () => {
  it('starts near zero and spans the requested duration', () => {
    const sweep = makeExpSweep(10, 5 / Math.log(2400), 5, SR);
    expect(sweep).toHaveLength(5 * SR);
    expect(sweep[0]).toBeCloseTo(0, 6);
    for (const v of sweep) expect(Math.abs(v)).toBeLessThanOrEqual(1.0000001);
  });
});

describe('deconvolveFarina', () => {
  it('recovers a known impulse response by Farina deconvolution (peak + echoes exact)', () => {
    const f1 = 10;
    const T = 5;
    const L = T / Math.log(SR / 2 / f1);
    const sweep = makeExpSweep(f1, L, T, SR);
    const irLen = 4096;
    const trueIr = new Float64Array(irLen);
    trueIr[1000] = 1.0;
    trueIr[1200] = -0.4;
    trueIr[1700] = 0.25;
    // record = sweep convolved with trueIr
    const rec = new Float64Array(sweep.length + irLen);
    for (let k = 0; k < irLen; k++) {
      const g = trueIr[k];
      if (g === 0) continue;
      for (let i = 0; i < sweep.length; i++) rec[k + i] += g * sweep[i];
    }
    const ir = deconvolveFarina(rec, sweep, { fLo: f1, sr: SR });
    let pk = 0;
    let pv = 0;
    for (let i = 0; i < 3000; i++) {
      if (Math.abs(ir[i]) > Math.abs(pv)) {
        pv = ir[i];
        pk = i;
      }
    }
    expect(pk).toBe(1000);
    expect(pv).toBeGreaterThan(0);
    expect(ir[1200] / pv).toBeCloseTo(-0.4, 2);
    expect(ir[1700] / pv).toBeCloseTo(0.25, 2);
  });
});

describe('kirkebyEps', () => {
  it('is small in-band and rises to epsOut out-of-band', () => {
    expect(kirkebyEps(1000, 10, 23900, 1e-3)).toBeCloseTo(1e-6, 9);
    expect(kirkebyEps(1, 10, 23900, 1e-3)).toBeCloseTo(1e-3, 9);
    expect(kirkebyEps(40000, 10, 23900, 1e-3)).toBeCloseTo(1e-3, 9);
  });
});

describe('estimateSweepInstFreq', () => {
  it('recovers f1/T/L of a synthetic log sweep within tight tolerance', () => {
    const f1 = 10;
    const T = 5;
    const L = T / Math.log(SR / 2 / f1);
    const sweep = makeExpSweep(f1, L, T, SR);
    const est = estimateSweepInstFreq(sweep, [[0, sweep.length]], SR);
    expect(est.f1).toBe(10);
    expect(est.f2).toBe(SR / 2);
    expect(est.T).toBe(5);
    expect(est.L).toBeCloseTo(L, 3);
    expect(est.residual).toBeLessThan(0.05);
  });
});

describe('linearSumAssignment', () => {
  it('solves a classic minimization', () => {
    const { assignment } = linearSumAssignment([
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ]);
    expect(assignment).toEqual([1, 0, 2]);
  });

  it('maximizes when costs are negated', () => {
    const score = [
      [0.9, 0.1],
      [0.2, 0.8],
    ];
    const { assignment } = linearSumAssignment(score.map(r => r.map(v => -v)));
    expect(assignment).toEqual([0, 1]);
  });

  it('handles rectangular matrices (more rows than columns)', () => {
    const { assignment } = linearSumAssignment([
      [1, 2],
      [2, 1],
      [3, 3],
    ]);
    // two of three rows get a column, one stays -1
    expect(assignment.filter(c => c >= 0)).toHaveLength(2);
    expect(new Set(assignment.filter(c => c >= 0)).size).toBe(2);
  });
});
