/**
 * clock-drift.js — [MOTEUR] module.
 *
 * Estime la derive d'horloge lecture/capture (DAC de l'AVR vs ADC du micro USB)
 * a partir du burst de controle (le ch0 rejoue en fin de session). Port de
 * `estimate_clock_drift` (extract_impulses.py).
 *
 * L'ecart temporel entre les deux pics ch0, compare a la grille de lecture
 * nominale, donne la derive en fraction (~−30 ppm). On reutilise
 * `crossCorrelationLag` (FFT, affinage parabolique) pour l'alignement fin des
 * deux fenetres.
 */

import { forwardRealFft, nextPowerOfTwo } from '../dsp/fft.js';
import { crossCorrelationLag } from '../dsp/time-alignment.js';

/**
 * @param {Float64Array} irFull - IR deconvoluee de tout l'enregistrement
 * @param {Array<[number,number]>} bursts
 * @param {number} nch
 * @param {number} [sr=48000]
 * @returns {number|null} derive (fraction) ou null si absente/aberrante
 */
export function estimateClockDrift(irFull, bursts, nch, sr = 48000) {
  if (bursts.length <= nch) return null;
  const k2 = bursts.length - 1;
  const w = 4096;

  const peakAndWin = k => {
    const [a, b] = bursts[k];
    const s = Math.max(0, a - (sr >> 1));
    let p = s;
    let pv = -Infinity;
    for (let i = s; i < b; i++) {
      const v = Math.abs(irFull[i]);
      if (v > pv) {
        pv = v;
        p = i;
      }
    }
    const win = irFull.subarray(p - (w >> 1), p + (w >> 1));
    return { p, win };
  };

  const r0 = peakAndWin(0);
  const r1 = peakAndWin(k2);
  if (r0.win.length !== r1.win.length || r0.win.length === 0) return null;

  const size = nextPowerOfTwo(r0.win.length);
  const specA = forwardRealFft(r1.win, size);
  const specB = forwardRealFft(r0.win, size);
  // lag tel que r1 ≈ r0 decale de `lag` (fin, sub-echantillon)
  const lag = crossCorrelationLag(specA, specB, { maxLag: w >> 2, center: 0, useAbs: true });

  const delta = lag + (r1.p - r0.p);
  // periode nominale (arrondie a 0,1 s) a partir des debuts de burst
  const starts = bursts.map(([a]) => a);
  const diffs = [];
  for (let i = 1; i < starts.length; i++) diffs.push(starts[i] - starts[i - 1]);
  diffs.sort((a, b) => a - b);
  const medDiff = diffs[diffs.length >> 1];
  const periodNom = Math.round((medDiff / sr) * 10) / 10;
  const nominal = k2 * periodNom * sr;
  if (nominal <= 0) return null;
  const d = delta / nominal - 1;
  return Math.abs(d) < 200e-6 ? d : null;
}
