/**
 * sweep.js — [MOTEUR] module.
 *
 * Sweep exponentiel (log) de type Farina : generation et estimation.
 *
 *   x(t) = sin( 2π · f1 · L · (e^(t/L) − 1) ),   L = T / ln(f2/f1)
 *
 * L'estimation `estimateSweepInstFreq` remplace le spectrogramme scipy du
 * decodeur Python par une methode plus adaptee a JS et plus fine : la frequence
 * INSTANTANEE issue du signal analytique (Hilbert). Pour un sweep log,
 * `f_inst(t) = f1·e^(t/L)` donc `ln(f_inst(t))` est LINEAIRE en t : on l'estime
 * par regression lineaire robuste (rejets 3σ) sur des blocs medians, sans avoir
 * a repliquer la fenetre de Tukey ni le binning d'un spectrogramme.
 *
 * Reutilise `forwardRealFft`/`fftInPlace` (src/dsp/fft.js).
 */

import { forwardRealFft, fftInPlace, nextPowerOfTwo } from './fft.js';

/**
 * Genere le sweep exponentiel de reference.
 * @param {number} f1 - frequence de depart (Hz)
 * @param {number} L - constante de temps (s)
 * @param {number} T - duree (s)
 * @param {number} sr - frequence d'echantillonnage
 * @returns {Float64Array}
 */
export function makeExpSweep(f1, L, T, sr) {
  const n = Math.round(T * sr);
  const out = new Float64Array(n);
  const k = 2 * Math.PI * f1 * L;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = Math.sin(k * (Math.exp(t / L) - 1));
  }
  return out;
}

/**
 * Signal analytique (Hilbert) d'un segment reel : retourne {re, im} temporels
 * (les `seg.length` premiers echantillons). Frequences positives doublees,
 * negatives annulees.
 */
function analyticSignal(seg) {
  const size = nextPowerOfTwo(seg.length);
  const { re, im } = forwardRealFft(seg, size);
  for (let i = 1; i < size / 2; i++) {
    re[i] *= 2;
    im[i] *= 2;
  }
  for (let i = size / 2 + 1; i < size; i++) {
    re[i] = 0;
    im[i] = 0;
  }
  fftInPlace(re, im, true);
  return { re, im, size };
}

/** Moindres carres ordinaires y = a·x + b. Retourne {a, b} ou null si degenere. */
function olsFit(xs, ys) {
  const n = xs.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const a = (n * sxy - sx * sy) / denom;
  return { a, b: (sy - a * sx) / n };
}

/** Ecart-type des residus de la droite (a, b) sur (xs, ys). */
function residualStd(xs, ys, a, b) {
  let sse = 0;
  for (let i = 0; i < xs.length; i++) {
    const r = ys[i] - (a * xs[i] + b);
    sse += r * r;
  }
  return Math.sqrt(sse / xs.length);
}

/** Regression lineaire robuste y = a·x + b avec rejets iteratifs a 3σ. */
function robustLinearFit(xs, ys) {
  let keepX = xs;
  let keepY = ys;
  let a = 0;
  let b = 0;
  let std = 0;
  for (let iter = 0; iter < 5 && keepX.length >= 4; iter++) {
    const fit = olsFit(keepX, keepY);
    if (!fit) break;
    a = fit.a;
    b = fit.b;
    std = residualStd(keepX, keepY, a, b);
    if (std === 0) break;
    const nx = [];
    const ny = [];
    for (let i = 0; i < keepX.length; i++) {
      if (Math.abs(keepY[i] - (a * keepX[i] + b)) < 3 * std) {
        nx.push(keepX[i]);
        ny.push(keepY[i]);
      }
    }
    if (nx.length === keepX.length) break;
    keepX = nx;
    keepY = ny;
  }
  return { a, b, residStd: std };
}

/** Phase instantanee deroulee + amplitude d'un signal analytique {re, im}. */
function unwrappedPhaseAmp(re, im, n) {
  const amp = new Float64Array(n);
  const phase = new Float64Array(n);
  let prev = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    amp[i] = Math.hypot(re[i], im[i]);
    const ph = Math.atan2(im[i], re[i]);
    if (i > 0) {
      let d = ph - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      acc += d;
    }
    prev = ph;
    phase[i] = acc;
  }
  return { amp, phase };
}

/** Frequence mediane d'un bloc [start, start+len) au-dessus du seuil d'amplitude. */
function blockMedianFreq(phase, amp, start, len, sr, ampThresh) {
  const freqs = [];
  let ampSum = 0;
  const nyq = 0.98 * (sr / 2);
  for (let i = start; i < start + len; i++) {
    const f = ((phase[i] - phase[i - 1]) * sr) / (2 * Math.PI);
    if (f > 30 && f < nyq && amp[i] > ampThresh) freqs.push(f);
    ampSum += amp[i];
  }
  if (freqs.length < len * 0.3 || ampSum / len < ampThresh) return null;
  freqs.sort((p, q) => p - q);
  return freqs[freqs.length >> 1];
}

/** Ajuste f1 sur une valeur usuelle (10/20/5/15 Hz) si proche a 25 %. */
function snapF1(f1, f2, T) {
  for (const nice of [10, 20, 5, 15]) {
    if (Math.abs(f1 - nice) / nice < 0.25) {
      return { f1: nice, L: T / Math.log(f2 / nice) };
    }
  }
  return { f1, L: T / Math.log(f2 / f1) };
}

/**
 * Estime les parametres du sweep a partir d'un enregistrement et de ses bursts.
 * @param {Float64Array} x - enregistrement complet
 * @param {Array<[number,number]>} bursts - [debut, fin] en echantillons
 * @param {number} sr
 * @returns {{f1:number, f2:number, T:number, L:number, residual:number}}
 */
export function estimateSweepInstFreq(x, bursts, sr) {
  const durs = bursts.map(([a, b]) => (b - a) / sr);
  const tmax = Math.max(...durs);
  const longs = durs.filter(d => d > 0.8 * tmax);
  // Burst le plus long pour l'estimation de la pente.
  const [a0, b0] = bursts[durs.indexOf(tmax)];
  const segStart = Math.max(0, a0 - (sr >> 2));
  const seg = x.subarray(segStart, b0 + (sr >> 1));
  const nSeg = seg.length;

  const { re, im } = analyticSignal(seg);
  const { amp, phase } = unwrappedPhaseAmp(re, im, nSeg);

  let ampMax = 0;
  for (let i = 0; i < nSeg; i++) if (amp[i] > ampMax) ampMax = amp[i];
  const ampThresh = ampMax * 0.05;

  // Blocs medians pour lisser la frequence instantanee : ln(f) lineaire en t.
  const blockLen = Math.max(1, Math.floor(nSeg / 256));
  const xs = [];
  const ys = [];
  for (let start = 1; start + blockLen < nSeg; start += blockLen) {
    const medF = blockMedianFreq(phase, amp, start, blockLen, sr, ampThresh);
    if (medF == null) continue;
    xs.push((start + blockLen / 2 - (a0 - segStart)) / sr); // t=0 au debut du burst
    ys.push(Math.log(medF));
  }

  const fit = robustLinearFit(Float64Array.from(xs), Float64Array.from(ys));
  const f2 = sr / 2;
  const T = Math.round(median(longs) * 2) / 2; // duree nominale au 0,5 s pres
  const f1raw = f2 / Math.exp(T * fit.a);
  const { f1, L } = snapF1(f1raw, f2, T);
  return { f1, f2, T, L, residual: fit.residStd };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
