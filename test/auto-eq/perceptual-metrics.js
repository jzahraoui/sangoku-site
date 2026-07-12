/**
 * perceptual-metrics.js — métriques perceptuelles du harnais (phase 0 du plan
 * qualité audio). Volontairement côté test : elles ne seront promues dans le
 * moteur (phase 5) que si les A/B le justifient.
 *
 * Lissage « variable » approximant celui de REW : fraction d'octave large en
 * basses (détail modal conservé) qui s'élargit vers les aigus (l'oreille
 * intègre par bandes critiques). Gaussien en log-fréquence, domaine dB.
 */

const LOG2 = Math.log(2);

function octaveFractionAt(freq, { lowFraction, highFraction, lowFreq, highFreq }) {
  if (freq <= lowFreq) return lowFraction;
  if (freq >= highFreq) return highFraction;
  const t = Math.log(freq / lowFreq) / Math.log(highFreq / lowFreq);
  // interpolation log-log de la largeur de bande
  return lowFraction * Math.pow(highFraction / lowFraction, t);
}

/**
 * Lissage gaussien à largeur variable sur une grille log-espacée.
 *
 * @param {ArrayLike<number>} freqs      - grille croissante (PPO ~constante)
 * @param {ArrayLike<number>} magnitude  - dB
 * @param {object} [options]
 * @param {number} [options.lowFraction=1/48]  - fraction d'octave sous lowFreq
 * @param {number} [options.highFraction=1/3]  - fraction d'octave au-dessus de highFreq
 * @param {number} [options.lowFreq=100]
 * @param {number} [options.highFreq=10000]
 * @returns {Float64Array} magnitude lissée (dB)
 */
export function variableSmoothMagnitude(freqs, magnitude, options = {}) {
  const params = {
    lowFraction: 1 / 48,
    highFraction: 1 / 3,
    lowFreq: 100,
    highFreq: 10000,
    ...options,
  };
  const n = freqs.length;
  const smoothed = new Float64Array(n);
  const logFreqs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    logFreqs[i] = Math.log(freqs[i]) / LOG2;
  }

  for (let i = 0; i < n; i++) {
    // sigma en octaves = demi-largeur de la fraction locale
    const sigma = octaveFractionAt(freqs[i], params) / 2;
    const reach = 3 * sigma;
    let sum = 0;
    let weightSum = 0;
    for (let j = i; j >= 0 && logFreqs[i] - logFreqs[j] <= reach; j--) {
      const x = (logFreqs[i] - logFreqs[j]) / sigma;
      const w = Math.exp(-0.5 * x * x);
      sum += w * magnitude[j];
      weightSum += w;
    }
    for (let j = i + 1; j < n && logFreqs[j] - logFreqs[i] <= reach; j++) {
      const x = (logFreqs[j] - logFreqs[i]) / sigma;
      const w = Math.exp(-0.5 * x * x);
      sum += w * magnitude[j];
      weightSum += w;
    }
    smoothed[i] = weightSum > 0 ? sum / weightSum : magnitude[i];
  }
  return smoothed;
}

/**
 * RMS de l'erreur vs cible APRÈS lissage variable de l'erreur — approximation
 * « ce que l'oreille retient » : l'ondulation fine inaudible se moyenne, les
 * écarts larges restent.
 *
 * @param {Array<{freq:number, spl:number}>} data
 * @param {(freq:number) => number} targetFn
 * @param {number} startFreq
 * @param {number} endFreq
 * @param {object} [smoothingOptions] - options de variableSmoothMagnitude
 * @returns {number} dB RMS
 */
export function calculatePerceptualRMSError(
  data,
  targetFn,
  startFreq,
  endFreq,
  smoothingOptions = {},
) {
  const inRange = data.filter(d => d.freq >= startFreq && d.freq <= endFreq);
  if (inRange.length === 0) return 0;
  const freqs = inRange.map(d => d.freq);
  const errors = inRange.map(d => d.spl - targetFn(d.freq));
  const smoothedErrors = variableSmoothMagnitude(freqs, errors, smoothingOptions);
  let sum = 0;
  for (const e of smoothedErrors) sum += e * e;
  return Math.sqrt(sum / smoothedErrors.length);
}

/**
 * Écart moyen (dB) entre deux courbes sur une bande — sert à quantifier le
 * biais de référentiel D(f) = brute − courbe de travail (fenêtrée / vector avg).
 *
 * @param {Array<{freq:number, spl:number}>} reference - courbe brute
 * @param {(freq:number) => number} otherFn            - accès à l'autre courbe
 * @param {number} startFreq
 * @param {number} endFreq
 * @returns {number} moyenne de (reference − other) sur la bande
 */
export function meanLevelDifference(reference, otherFn, startFreq, endFreq) {
  const inRange = reference.filter(d => d.freq >= startFreq && d.freq <= endFreq);
  if (inRange.length === 0) return 0;
  let sum = 0;
  for (const d of inRange) sum += d.spl - otherFn(d.freq);
  return sum / inRange.length;
}
