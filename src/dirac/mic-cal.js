/**
 * mic-cal.js — [MOTEUR] module.
 *
 * Applique la calibration micro embarquee a une IR (correction de magnitude,
 * phase nulle) et calcule une magnitude lissee pour l'appariement/validation.
 * Port de `apply_mic_cal` et `smooth_mag_db` (extract_impulses.py).
 *
 * Convention Dirac : la cal est la REPONSE du micro ⇒ on corrige `mesure − cal`
 * (multiplication du spectre par `10^(−gain/20)`). Le gain reel etant symetrique
 * (indexe par `fAbs = min(b, N−b)·sr/N`), le resultat reste reel.
 */

import { forwardRealFft, realInverseFft, nextPowerOfTwo } from '../dsp/fft.js';

/** Interpolation lineaire bornee aux extremites (equiv. numpy.interp clampe). */
function interpClamped(f, calF, calDb) {
  const n = calF.length;
  if (f <= calF[0]) return calDb[0];
  if (f >= calF[n - 1]) return calDb[n - 1];
  // recherche dichotomique
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (calF[mid] <= f) lo = mid;
    else hi = mid;
  }
  const t = (f - calF[lo]) / (calF[hi] - calF[lo]);
  return calDb[lo] + t * (calDb[hi] - calDb[lo]);
}

/**
 * Applique la cal micro a `ir`.
 * @param {Float64Array} ir
 * @param {number[]|Float32Array} calF - frequences (croissantes)
 * @param {number[]|Float32Array} calDb - gains dB
 * @param {number} sr
 * @returns {Float64Array} IR corrigee (meme longueur)
 */
export function applyMicCal(ir, calF, calDb, sr) {
  const N = nextPowerOfTwo(ir.length * 2);
  const { re, im } = forwardRealFft(ir, N);
  const binHz = sr / N;
  for (let b = 0; b < N; b++) {
    const fAbs = Math.min(b, N - b) * binHz;
    const gainDb = interpClamped(fAbs, calF, calDb);
    const g = Math.pow(10, -gainDb / 20);
    re[b] *= g;
    im[b] *= g;
  }
  return realInverseFft(re, im, ir.length);
}

/**
 * Magnitude en dB de l'IR, lissee 1/frac octave, echantillonnee sur `fgrid`.
 * frac=24 : parite avec la resolution quasi non lissee des courbes Dirac.
 * @param {Float64Array} ir
 * @param {Float64Array|number[]} fgrid - grille de frequences cible
 * @param {{frac?:number, sr?:number}} [opts]
 * @returns {Float64Array} magnitude dB (NaN la ou la bande est vide)
 */
export function smoothMagDb(ir, fgrid, { frac = 24, sr = 48000 } = {}) {
  const N = nextPowerOfTwo(Math.max(ir.length, 8192));
  const { re, im } = forwardRealFft(ir, N);
  const half = N >> 1;
  const M = new Float64Array(half + 1);
  for (let b = 0; b <= half; b++) M[b] = 20 * Math.log10(Math.hypot(re[b], im[b]) + 1e-15);
  const binHz = sr / N;
  const loMul = 2 ** (-0.5 / frac);
  const hiMul = 2 ** (0.5 / frac);
  const out = new Float64Array(fgrid.length);
  for (let k = 0; k < fgrid.length; k++) {
    const loF = fgrid[k] * loMul;
    const hiF = fgrid[k] * hiMul;
    let a = Math.ceil(loF / binHz);
    let b = Math.ceil(hiF / binHz);
    if (a < 0) a = 0;
    if (b > half + 1) b = half + 1;
    if (b > a) {
      let sum = 0;
      for (let i = a; i < b; i++) sum += M[i];
      out[k] = sum / (b - a);
    } else {
      out[k] = NaN;
    }
  }
  return out;
}
