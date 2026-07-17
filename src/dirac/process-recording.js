/**
 * process-recording.js — [MOTEUR] module.
 *
 * Pipeline de reconstruction d'un enregistrement micro -> IR par canal. Port de
 * `process_recording` (extract_impulses.py).
 *
 * Etapes : segmentation des bursts -> estimation du sweep -> deconvolution de
 * Farina -> correction de derive d'horloge -> calibration micro -> fenetrage a
 * base de temps COMMUNE (pas de recentrage sur le pic : les delais/distances
 * relatifs sont preserves) -> annulation du trim de lecture par canal.
 */

import { makeExpSweep, estimateSweepInstFreq } from '../dsp/sweep.js';
import { deconvolveFarina } from '../dsp/farina-deconvolution.js';
import { segmentBursts } from './burst-segmentation.js';
import { estimateClockDrift } from './clock-drift.js';
import { applyMicCal } from './mic-cal.js';

export const PRE_S = 0.05; // marge de silence avant t=0 dans les IR exportees

function argmaxAbs(arr, from, to) {
  let p = from;
  let pv = -Infinity;
  for (let i = from; i < to; i++) {
    const v = Math.abs(arr[i]);
    if (v > pv) {
      pv = v;
      p = i;
    }
  }
  return p;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Periode de la grille de lecture, ancree sur le burst de controle si present
 * (ch0 rejoue en fin de session -> periode exacte au sample pres), sinon mediane
 * des ecarts entre pics.
 */
function estimatePeriod(peaks, numBursts, nch) {
  if (numBursts > nch) {
    const ctrl = numBursts - 1;
    return (peaks[ctrl] - peaks[0]) / ctrl;
  }
  if (nch > 1) {
    const d = [];
    for (let k = 1; k < nch; k++) d.push(peaks[k] - peaks[k - 1]);
    return median(d);
  }
  return 0;
}

/** Temps de vol de l'enceinte la plus proche (le T0 d'emission commun s'annule). */
function nearestTof(peaks, period, nch) {
  let tofRef = Infinity;
  for (let k = 0; k < nch; k++) {
    const tof = peaks[k] - k * period;
    if (tof < tofRef) tofRef = tof;
  }
  return Number.isFinite(tofRef) ? tofRef : 0;
}

/**
 * @param {Float64Array} x - enregistrement decode (mono)
 * @param {{nch:number, irLen:number, cal:{freqs:number[]|Float32Array, gainsDb:number[]|Float32Array}, trims?:Float32Array|number[]|null, sr?:number}} opts
 * @returns {null | {sweep:object, clockDriftPpm:number|null, numBursts:number, irs:Float64Array[], period:number, trimsDb:number[]|null}}
 */
export function processRecording(x, { nch, irLen, cal, trims = null, sr = 48000 }) {
  const bursts = segmentBursts(x, { sr });
  if (bursts.length < nch) return null;

  const { f1, f2, T, L, residual } = estimateSweepInstFreq(x, bursts, sr);
  let irFull = deconvolveFarina(x, makeExpSweep(f1, L, T, sr), { fLo: f1, sr });

  const drift = estimateClockDrift(irFull, bursts, nch, sr);
  if (drift != null && Math.abs(drift) > 2e-6) {
    // sweep vu par l'horloge de capture : duree etiree d'un facteur (1+d)
    irFull = deconvolveFarina(x, makeExpSweep(f1, L * (1 + drift), T * (1 + drift), sr), { fLo: f1, sr });
  }
  irFull = applyMicCal(irFull, cal.freqs, cal.gainsDb, sr);

  const pre = Math.round(PRE_S * sr);
  const nIr = Math.round(irLen * sr);

  // pic (arrivee du son direct) de chaque burst sur l'IR deconvoluee
  const peaks = bursts.map(([a, b]) => argmaxAbs(irFull, Math.max(0, a - (sr >> 1)), b));
  const period = estimatePeriod(peaks, bursts.length, nch);
  const tofRef = nearestTof(peaks, period, nch);

  const irs = [];
  for (let k = 0; k < nch; k++) {
    const start = Math.max(0, period > 0 ? Math.round(k * period + tofRef) - pre : peaks[k] - pre);
    const ir = new Float64Array(nIr);
    ir.set(irFull.subarray(start, Math.min(x.length, start + nIr)));
    // defait le trim de lecture par canal (§6.3) : restitue le niveau relatif vrai
    if (trims && k < trims.length && trims[k]) {
      const g = Math.pow(10, -trims[k] / 20);
      for (let i = 0; i < ir.length; i++) ir[i] *= g;
    }
    irs.push(ir);
  }

  return {
    sweep: { f1Hz: f1, f2Hz: f2, durationS: T, Ls: Number(L.toFixed(6)), ridgeFitResidual: Number(residual.toFixed(4)) },
    clockDriftPpm: drift != null ? Number((drift * 1e6).toFixed(2)) : null,
    numBursts: bursts.length,
    irs,
    period,
    trimsDb: trims ? Array.from(trims) : null,
  };
}
