/**
 * ir-align.js — [MOTEUR] module.
 *
 * Réimplémentation interne de la commande « Align IRs » de l'alignment tool
 * de REW (rétro-ingénierie documentée dans work/docs/ALIGNMENT-TOOL-REW.md,
 * sources décompilées C1312c.m7225E / C0529H.m2163A / C0280I.m557A / hB).
 *
 * Pipeline : passe-bande 1/n octave à PHASE NULLE sur les deux IR →
 * extraction en référentiel commun (pic de A à l'origine, décalage
 * fractionnaire exact) → CARRÉ SIGNÉ → corrélation croisée FFT → pic |max|
 * affiné (suréchantillonnage sinc ×8 + parabole) → bornes min/max avec
 * recherche contrainte en repli → polarité par le signe du produit des IR
 * filtrées au pic de A.
 *
 * Ne bascule les appelants (findAligment) qu'à parité démontrée contre
 * l'outil réel (harnais golden).
 */

import { fftInPlace, forwardRealFft, nextPowerOfTwo } from './fft.js';

// ─── Passe-bande 1/n octave (hB.m8393A / m8396A) ─────────────────────────────

/**
 * Coefficients des sections du passe-bande fractionnaire d'octave (portage
 * exact de hB.m8393A). `order` est l'ordre des sections analogiques (n) ;
 * retourne { second: {g,a1,a2}|null, fourth: [{g,a1,a2,a3,a4}] }.
 */
export function designOctaveBandPass(order, fc, sampleRate, octaveFrac, zeroPhase) {
  const inv = 1 / octaveFrac;
  const omega = (2 * Math.PI * fc) / sampleRate;
  const sin = Math.sin(omega);
  const cos = Math.cos(omega);
  const tan = Math.tan(omega / 2);
  let pow = Math.pow(2, ((inv * omega) / sin) / 2);
  const pow2 = Math.pow(2, -inv);
  for (let i = 0; i < 3; i++) {
    pow = tan / Math.tan(pow2 * Math.atan(pow * tan));
  }
  let sinh = sin * Math.sinh(((2 * Math.log(pow)) / Math.LN2) * (Math.LN2 / 2));
  if (zeroPhase) {
    sinh *= 1 + 0.5 / order;
  }

  const sections = { second: null, fourth: [] };
  const odd = order & 1;
  if (odd === 1) {
    const d5 = sinh + 1;
    sections.second = {
      g: sinh / d5,
      a1: (-2 * cos) / d5,
      a2: (1 - sinh) / d5,
    };
  }
  const pairs = (order - odd) / 2;
  for (let k = 1; k <= pairs; k++) {
    const sin2 = Math.sin(((2 * k - 1) * Math.PI) / (2 * order));
    const s2 = sinh * sinh;
    const d8 = s2 + 2 * sin2 * sinh + 1;
    sections.fourth.push({
      g: s2 / d8,
      a1: (-4 * cos * (1 + sin2 * sinh)) / d8,
      a2: (2 * (1 + 2 * cos * cos - s2)) / d8,
      a3: (-4 * cos * (1 - sin2 * sinh)) / d8,
      a4: (s2 - 2 * sin2 * sinh + 1) / d8,
    });
  }
  return sections;
}

const DENORMAL_FLUSH = 1.1754943508222875e-38;

function applySecondOrder({ g, a1, a2 }, input, reversed) {
  const out = new Float64Array(input.length);
  let y1 = 0;
  let y2 = 0;
  let x1 = 0;
  let x2 = 0;
  const start = reversed ? input.length - 1 : 0;
  const end = reversed ? -1 : input.length;
  const step = reversed ? -1 : 1;
  for (let i = start; reversed ? i > end : i < end; i += step) {
    // section bandpass b = g·(1, 0, −1)
    let w = input[i] - a1 * y1 - a2 * y2;
    if (Math.abs(w) < DENORMAL_FLUSH) w = 0;
    out[i] = g * (w - x2);
    x2 = x1;
    x1 = w;
    y2 = y1;
    y1 = w;
  }
  return out;
}

function applyFourthOrder({ g, a1, a2, a3, a4 }, input, reversed) {
  const out = new Float64Array(input.length);
  let w1 = 0;
  let w2 = 0;
  let w3 = 0;
  let w4 = 0;
  const start = reversed ? input.length - 1 : 0;
  const end = reversed ? -1 : input.length;
  const step = reversed ? -1 : 1;
  for (let i = start; reversed ? i > end : i < end; i += step) {
    // section bandpass b = g·(1, 0, −2, 0, 1) (forme directe II)
    let w = input[i] - a1 * w1 - a2 * w2 - a3 * w3 - a4 * w4;
    if (Math.abs(w) < DENORMAL_FLUSH) w = 0;
    out[i] = g * (w - 2 * w2 + w4);
    w4 = w3;
    w3 = w2;
    w2 = w1;
    w1 = w;
  }
  return out;
}

function applySections(sections, input, reversed) {
  let data = input;
  if (sections.second) {
    data = applySecondOrder(sections.second, data, reversed);
  }
  for (const section of sections.fourth) {
    data = applyFourthOrder(section, data, reversed);
  }
  return data;
}

/**
 * Passe-bande 1/n octave de REW appliqué à une IR (hB.m8394A). En zéro-phase
 * (celui de l'alignment tool), l'ordre effectif des sections est
 * n = (2·(order/2))/3 et le filtre est appliqué avant puis arrière.
 *
 * @param {ArrayLike<number>} data
 * @param {Object} params - { fc, sampleRate, octaveFrac=3, order=6,
 *   zeroPhase=true }
 * @returns {Float64Array}
 */
export function octaveBandPass(data, { fc, sampleRate, octaveFrac = 3, order = 6, zeroPhase = true }) {
  const input = Float64Array.from(data);
  const half = Math.floor(order / 2);
  if (!zeroPhase) {
    const sections = designOctaveBandPass(half, fc, sampleRate, octaveFrac, false);
    return applySections(sections, input, false);
  }
  const n = Math.floor((2 * half) / 3);
  const sections = designOctaveBandPass(n, fc, sampleRate, octaveFrac, true);
  return applySections(sections, applySections(sections, input, false), true);
}

// ─── Décalage fractionnaire (C0280I.m499A : rampe de phase FFT) ──────────────

/** Décale le signal de `shiftSeconds` (rampe de phase e^{+jω·d}). */
export function fractionalShift(data, shiftSeconds, samplePeriod) {
  if (shiftSeconds === 0) return Float64Array.from(data);
  const n = data.length;
  const size = nextPowerOfTwo(n);
  const { re, im } = forwardRealFft(data, size);
  for (let bin = 1; bin < size / 2; bin++) {
    const angle = (shiftSeconds * 2 * Math.PI * bin) / (size * samplePeriod);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const r0 = re[bin];
    const i0 = im[bin];
    re[bin] = r0 * c - i0 * s;
    im[bin] = r0 * s + i0 * c;
    re[size - bin] = re[bin];
    im[size - bin] = -im[bin];
  }
  re[size / 2] *= Math.cos((shiftSeconds * Math.PI) / samplePeriod);
  im[size / 2] = 0;
  fftInPlace(re, im, true);
  return Float64Array.from(re.subarray(0, n));
}

// ─── Extraction en référentiel commun (C0529H.m2163A) ────────────────────────

function rotateInPlace(arr, by) {
  const n = arr.length;
  let k = ((by % n) + n) % n;
  if (k === 0) return;
  const tmp = arr.slice(n - k);
  arr.copyWithin(k, 0, n - k);
  arr.set(tmp, 0);
}

/**
 * Buffer de longueur N où l'instant `refSeconds` (absolu) du signal se
 * retrouve à l'indice 0 (rotation entière + décalage fractionnaire), puis
 * CARRÉ SIGNÉ, puis spectre complexe.
 */
function referencedSpectrum(data, { size, refSeconds, startTimeSeconds, samplePeriod }) {
  const buffer = new Float64Array(size);
  buffer.set(data.subarray ? data.subarray(0, Math.min(data.length, size)) : data.slice(0, size));

  const refIndex = (refSeconds - startTimeSeconds) / samplePeriod;
  const round = Math.round(refIndex);
  const frac = refIndex - round;
  let shifted = buffer;
  if (frac !== 0) {
    shifted = fractionalShift(buffer, frac * samplePeriod, samplePeriod);
  }
  rotateInPlace(shifted, -round);
  for (let i = 0; i < size; i++) {
    const v = shifted[i];
    shifted[i] = Math.sign(v) * v * v;
  }
  const re = Float64Array.from(shifted);
  const im = new Float64Array(size);
  fftInPlace(re, im);
  return { re, im };
}

// ─── Pic de corrélation : affinage sinc ×8 + parabole (C0280I.m470A/m469D) ──

function parabolicRefine(values, index) {
  const n = values.length;
  const yl = values[(index - 1 + n) % n];
  const yc = values[index];
  const yr = values[(index + 1) % n];
  const denom = yl - 2 * yc + yr;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-30) {
    return { x: index, y: yc };
  }
  const delta = Math.max(-1, Math.min(1, (0.5 * (yl - yr)) / denom));
  return { x: index + delta, y: yc - 0.25 * (yl - yr) * delta };
}

/** Sinc fenêtré (Hann, ±32 taps) : valeur du signal à une position réelle. */
function sincInterpolate(values, position) {
  const n = values.length;
  const center = Math.floor(position);
  const frac = position - center;
  if (frac === 0) return values[((center % n) + n) % n];
  const TAPS = 32;
  let sum = 0;
  for (let k = -TAPS + 1; k <= TAPS; k++) {
    const idx = (((center + k) % n) + n) % n;
    const x = frac - k;
    const sinc = Math.sin(Math.PI * x) / (Math.PI * x);
    const window = 0.5 * (1 + Math.cos((Math.PI * x) / TAPS));
    sum += values[idx] * sinc * window;
  }
  return sum;
}

/**
 * Position fractionnaire du pic de |corr| autour de `index` : recherche sur
 * une grille suréchantillonnée ×8 (±3 échantillons), puis parabole locale —
 * même esprit que C0280I.m470A (sinc ×8 + m469D).
 */
function refinePeak(corr, index) {
  const OVERSAMPLE = 8;
  const RANGE = 3;
  let bestX = index;
  let bestY = Math.abs(corr[((index % corr.length) + corr.length) % corr.length]);
  const samples = [];
  for (let i = -RANGE * OVERSAMPLE; i <= RANGE * OVERSAMPLE; i++) {
    const x = index + i / OVERSAMPLE;
    const y = Math.abs(sincInterpolate(corr, x));
    samples.push(y);
    if (y > bestY) {
      bestY = y;
      bestX = x;
    }
  }
  // parabole sur la grille ×8 autour du meilleur point
  const bestIdx = Math.round((bestX - index) * OVERSAMPLE) + RANGE * OVERSAMPLE;
  if (bestIdx > 0 && bestIdx < samples.length - 1) {
    const { x } = parabolicRefine(samples, bestIdx);
    bestX = index + (x - RANGE * OVERSAMPLE) / OVERSAMPLE;
  }
  return bestX;
}

// ─── Alignement complet (C1312c.m7225E) ──────────────────────────────────────

/**
 * Aligne l'IR B sur l'IR A à la fréquence de crossover donnée — parité avec
 * la commande « Align IRs » de l'alignment tool de REW.
 *
 * @param {Object} irA - { data, sampleRate, startTime } (IR brute, non filtrée)
 * @param {Object} irB - idem (même sampleRate)
 * @param {Object} params
 * @param {number} params.frequency - Fréquence d'alignement (Hz, ≥ 20)
 * @param {number} [params.minDelayMs=-0.5] - Borne basse du délai B
 * @param {number} [params.maxDelayMs=3] - Borne haute du délai B
 * @param {number} [params.octaveFrac=3]
 * @param {number} [params.order=6]
 * @returns {{ delayMs: number, invertB: boolean, withinBounds: boolean,
 *   requiredDelayMs: number }} `requiredDelayMs` = délai libre (celui que REW
 *   affiche dans « Delay too large ») ; `delayMs` = résultat contraint.
 * @throws {TypeError|RangeError} Entrées invalides.
 */
export function alignImpulseResponses(irA, irB, params) {
  const { frequency, minDelayMs = -0.5, maxDelayMs = 3, octaveFrac = 3, order = 6 } = params;
  if (!irA?.data?.length || !irB?.data?.length) {
    throw new TypeError('alignImpulseResponses needs two impulse responses');
  }
  if (
    irA.sampleRate !== irB.sampleRate ||
    !Number.isFinite(irA.sampleRate) ||
    irA.sampleRate <= 0
  ) {
    throw new RangeError('alignImpulseResponses needs a common positive sampleRate');
  }
  if (!Number.isFinite(frequency) || frequency < 20) {
    throw new RangeError(`Alignment frequency must be ≥ 20 Hz (got ${frequency})`);
  }
  const sampleRate = irA.sampleRate;
  const samplePeriod = 1 / sampleRate;

  // 1. passe-bande 1/3 octave zéro phase sur les deux IR
  const filteredA = octaveBandPass(irA.data, { fc: frequency, sampleRate, octaveFrac, order });
  const filteredB = octaveBandPass(irB.data, { fc: frequency, sampleRate, octaveFrac, order });

  // 2. référence = pic (affiné) de l'IR A FILTRÉE
  let peakIndexA = 0;
  for (let i = 1; i < filteredA.length; i++) {
    if (Math.abs(filteredA[i]) > Math.abs(filteredA[peakIndexA])) peakIndexA = i;
  }
  const refinedPeakA = parabolicRefine(Array.from(filteredA, Math.abs), peakIndexA).x;
  const peakSecondsA = (irA.startTime ?? 0) + refinedPeakA * samplePeriod;

  // 3. extraction + carré signé + FFT
  const size = nextPowerOfTwo(Math.max(filteredA.length, filteredB.length));
  const specA = referencedSpectrum(filteredA, {
    size,
    refSeconds: peakSecondsA,
    startTimeSeconds: irA.startTime ?? 0,
    samplePeriod,
  });
  const specB = referencedSpectrum(filteredB, {
    size,
    refSeconds: peakSecondsA,
    startTimeSeconds: irB.startTime ?? 0,
    samplePeriod,
  });

  // 4. corrélation croisée A·conj(B) → temporel
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    re[i] = specA.re[i] * specB.re[i] + specA.im[i] * specB.im[i];
    im[i] = specA.im[i] * specB.re[i] - specA.re[i] * specB.im[i];
  }
  fftInPlace(re, im, true);
  const corr = re;

  // pic libre
  let peak = 0;
  for (let i = 1; i < size; i++) {
    if (Math.abs(corr[i]) > Math.abs(corr[peak])) peak = i;
  }
  let lag = refinePeak(corr, peak);
  if (lag > size / 2) lag -= size;
  const requiredDelayMs = lag * samplePeriod * 1000;

  let delayMs = requiredDelayMs;
  let withinBounds = delayMs >= minDelayMs && delayMs <= maxDelayMs;

  // 5. recherche contrainte dans les bornes si le pic libre en sort
  if (!withinBounds) {
    const lo = Math.ceil((minDelayMs * 0.001) / samplePeriod);
    const hi = Math.floor((maxDelayMs * 0.001) / samplePeriod);
    let bestLag = lo;
    let bestValue = -Infinity;
    for (let k = lo; k <= hi; k++) {
      const value = Math.abs(corr[((k % size) + size) % size]);
      if (value > bestValue) {
        bestValue = value;
        bestLag = k;
      }
    }
    let refined = refinePeak(corr, ((bestLag % size) + size) % size);
    if (refined > size / 2) refined -= size;
    delayMs = refined * samplePeriod * 1000;
    withinBounds = delayMs >= minDelayMs && delayMs <= maxDelayMs;
  }

  // 6. polarité : signe du produit des IR FILTRÉES au pic de A (B décalée)
  const valueAtSeconds = (data, startTime, seconds) => {
    const position = (seconds - startTime) / samplePeriod;
    if (position < 0 || position >= data.length) return 0;
    return sincInterpolate(data, position);
  };
  const aAtPeak = valueAtSeconds(filteredA, irA.startTime ?? 0, peakSecondsA);
  const bAtPeak = valueAtSeconds(
    filteredB,
    (irB.startTime ?? 0) + delayMs * 0.001,
    peakSecondsA,
  );
  const invertB = aAtPeak * bAtPeak < 0;

  return { delayMs, invertB, withinBounds, requiredDelayMs };
}

/**
 * Fenêtre de recherche d'alignement au raccord, dérivée de la période du
 * crossover (T = 1/fc). **Source unique** partagée par les trois chemins
 * d'alignement pour qu'ils ne divergent jamais.
 *
 * Deux formes, même **largeur d'un demi-cycle (T/2)** :
 * - `forward: true` → `[0, T/2]` (T/2 = 500/fc ms). Find Sub Alignment
 *   (`produceAligned`) : le sub est d'abord pré-positionné sur le pic de
 *   l'enceinte puis on cherche le délai à APPLIQUER, forcément vers l'avant.
 * - défaut (centré) → `[−T/4, +T/4]` (±250/fc ms). checkAlignment (bouton
 *   required shift) et le sweep « find best crossover » : on MESURE un résidu
 *   signé (positif ou négatif) depuis la position courante.
 *
 * Pourquoi pas plus large. Les lobes de la corrélation (carré signé) se
 * répètent tous les **T/2** — le lobe à T/2 est l'alignement **inversé** (180°
 * au raccord ; c'est le −4 ms parasite observé à 120 Hz). Une fenêtre centrée
 * d'un cycle entier (±T/2) ré-inclurait ce lobe inversé au bord → sauts de
 * cycle. ±T/4 isole un **seul** lobe → pic unique ; combiné au drapeau
 * d'inversion, il représente déjà TOUS les alignements (le décalage minimal,
 * éventuellement inversé). Le ±1 ms fixe historique n'était juste que ±T/4 à
 * 250 Hz — trop étroit dans le grave.
 *
 * @param {number} frequency Hz (> 0)
 * @param {{ forward?: boolean }} [options]
 * @returns {{ minMs: number, maxMs: number }}
 */
export function crossoverAlignmentWindowMs(frequency, { forward = false } = {}) {
  if (!Number.isFinite(frequency) || frequency <= 0) {
    throw new RangeError(
      `crossoverAlignmentWindowMs needs a positive frequency (got ${frequency})`,
    );
  }
  const halfPeriodMs = 500 / frequency; // T/2 en ms = 1000 / (2 * frequency)
  if (forward) {
    return { minMs: 0, maxMs: halfPeriodMs };
  }
  const quarterPeriodMs = halfPeriodMs / 2; // T/4
  return { minMs: -quarterPeriodMs, maxMs: quarterPeriodMs };
}
