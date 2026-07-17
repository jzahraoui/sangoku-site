/**
 * farina-deconvolution.js — [MOTEUR] module.
 *
 * Deconvolution de Farina regularisee (Kirkeby, bande limitee) de tout un
 * enregistrement par le sweep de reference. Port de `deconvolve_all`
 * (extract_impulses.py), exprime sur le spectre complet via src/dsp/fft.js.
 *
 *   IR = irfft( X · conj(S) / (|S|² + ε(f)) )
 *
 * Regularisation : inverse propre (ε ≈ −60 dB) dans la bande [fLo, fHi],
 * amorti hors bande (ε = epsOut, ~−30 dB) ou le sweep log n'a pas d'energie —
 * reglage critique de l'aigu (§7.1 du doc de retro-ingenierie).
 *
 * L'epsilon est indexe par la frequence SYMETRIQUE `fAbs = min(b, N−b)·sr/N`
 * pour que le profil soit hermitien : le resultat reste alors reel.
 */

import { forwardRealFft, realInverseFft, nextPowerOfTwo } from './fft.js';

const THIRD_OCTAVE = 1 / 3;

function clip01(v) {
  return Math.max(0, Math.min(1, v));
}

/**
 * Profil d'epsilon de Kirkeby pour une frequence absolue donnee (facteur, a
 * multiplier par `m = max(|S|²)`).
 */
export function kirkebyEps(fAbs, fLo, fHi, epsOut) {
  const logf = Math.log2(Math.max(fAbs, 1e-3));
  const rampLo = clip01((logf - Math.log2(fLo)) / THIRD_OCTAVE);
  const rampHi = clip01((Math.log2(fHi) - logf) / THIRD_OCTAVE);
  const inband = rampLo * rampHi;
  return 1e-6 * inband + epsOut * (1 - inband);
}

/**
 * Deconvolue `x` par `sweep`. Base de temps unique -> les delais relatifs entre
 * canaux sont preserves.
 *
 * @param {Float64Array|number[]} x
 * @param {Float64Array|number[]} sweep
 * @param {{fLo?:number, fHi?:number, epsOut?:number, sr:number}} opts
 * @returns {Float64Array} IR pleine bande (longueur = x.length)
 */
export function deconvolveFarina(x, sweep, { fLo = 10, fHi = 23900, epsOut = 1e-3, sr }) {
  const N = nextPowerOfTwo(x.length + sweep.length);
  const X = forwardRealFft(x, N);
  const S = forwardRealFft(sweep, N);

  // m = max(|S|²)
  let m = 0;
  for (let b = 0; b < N; b++) {
    const mag2 = S.re[b] * S.re[b] + S.im[b] * S.im[b];
    if (mag2 > m) m = mag2;
  }

  const Hr = new Float64Array(N);
  const Hi = new Float64Array(N);
  const nyBin = sr / N;
  for (let b = 0; b < N; b++) {
    const sr2 = S.re[b];
    const si2 = S.im[b];
    const mag2 = sr2 * sr2 + si2 * si2;
    const fAbs = Math.min(b, N - b) * nyBin;
    const eps = m * kirkebyEps(fAbs, fLo, fHi, epsOut);
    const denom = mag2 + eps;
    // X · conj(S) = (Xr·Sr + Xi·Si) + i(Xi·Sr − Xr·Si)
    const xr = X.re[b];
    const xi = X.im[b];
    Hr[b] = (xr * sr2 + xi * si2) / denom;
    Hi[b] = (xi * sr2 - xr * si2) / denom;
  }

  return realInverseFft(Hr, Hi, x.length);
}
