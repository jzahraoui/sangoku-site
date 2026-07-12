/**
 * time-alignment.js — [MOTEUR] module.
 *
 * Alignement temporel de plusieurs réponses impulsionnelles (positions d'un
 * même canal avant moyennage) par la stratégie hybride validée sur le corpus
 * ADY (work/bench-alignment/, 2026-07-12) :
 *
 *   1. grossier — corrélation croisée des enveloppes de Hilbert : insensible
 *      aux sauts de cycle et aux accrochages sur lobe secondaire, les deux
 *      modes de défaillance mesurés de la corrélation brute (type REW
 *      « Cross corr align ») et de l'alignement au pic ;
 *   2. fin — corrélation croisée brute contrainte à ±T/2 du centroïde
 *      spectral autour de l'estimation grossière : précision de phase
 *      sub-échantillon sans risque de changer de lobe.
 *
 * Module pur : entrées explicites, aucune dépendance REW/DOM. La décision
 * d'aligner et l'application des décalages appartiennent aux services.
 */

import { fftInPlace, forwardRealFft, nextPowerOfTwo } from './fft.js';

/**
 * Enveloppe de Hilbert (module du signal analytique), zéro-paddée à `size`.
 *
 * @param {ArrayLike<number>} samples
 * @param {number} size - Longueur FFT (puissance de 2 ≥ samples.length)
 * @returns {Float64Array}
 */
export function hilbertEnvelope(samples, size) {
  const { re, im } = forwardRealFft(samples, size);
  // Signal analytique : fréquences positives doublées, négatives annulées.
  for (let i = 1; i < size / 2; i++) {
    re[i] *= 2;
    im[i] *= 2;
  }
  for (let i = size / 2 + 1; i < size; i++) {
    re[i] = 0;
    im[i] = 0;
  }
  fftInPlace(re, im, true);
  const envelope = new Float64Array(size);
  for (let i = 0; i < size; i++) envelope[i] = Math.hypot(re[i], im[i]);
  return envelope;
}

/**
 * Centroïde spectral en Hz (pondéré par |H|², limité à [fLo, fHi]).
 * Sert à dimensionner la fenêtre de recherche fine (±T/2).
 *
 * @param {{ re: Float64Array, im: Float64Array }} spectrum
 * @param {number} sampleRate
 * @param {{ fLo?: number, fHi?: number }} [options]
 * @returns {number} Fréquence en Hz (fallback 1000 si énergie nulle)
 */
export function spectralCentroid(spectrum, sampleRate, { fLo = 20, fHi = 20000 } = {}) {
  const size = spectrum.re.length;
  let weighted = 0;
  let total = 0;
  for (let i = 1; i < size / 2; i++) {
    const freq = (i * sampleRate) / size;
    if (freq < fLo || freq > fHi) continue;
    const power = spectrum.re[i] * spectrum.re[i] + spectrum.im[i] * spectrum.im[i];
    weighted += freq * power;
    total += power;
  }
  return total > 0 ? weighted / total : 1000;
}

/** Interpolation parabolique du maximum sur trois points (offset ∈ [−1, 1]). */
function parabolicPeakOffset(yLeft, yCenter, yRight) {
  const denom = yLeft - 2 * yCenter + yRight;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-30) return 0;
  const delta = (0.5 * (yLeft - yRight)) / denom;
  return Math.max(-1, Math.min(1, delta));
}

/**
 * Lag (échantillons, fractionnaire) du maximum de corrélation croisée
 * circulaire entre `a` et `b` (positif = `a` en retard sur `b`).
 *
 * @param {{ re, im }} spectrumA - Spectre de a (forwardRealFft, même size)
 * @param {{ re, im }} spectrumB - Spectre de b
 * @param {Object} [options]
 * @param {number|null} [options.maxLag=null] - Rayon de recherche (échantillons)
 * @param {number} [options.center=0] - Centre de la recherche
 * @param {boolean} [options.useAbs=true] - Chercher le max de |corr|
 *   (insensible à la polarité) ou de corr signée
 * @returns {number}
 */
export function crossCorrelationLag(spectrumA, spectrumB, options = {}) {
  const { maxLag = null, center = 0, useAbs = true } = options;
  const size = spectrumA.re.length;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    // A · conj(B)
    re[i] = spectrumA.re[i] * spectrumB.re[i] + spectrumA.im[i] * spectrumB.im[i];
    im[i] = spectrumA.im[i] * spectrumB.re[i] - spectrumA.re[i] * spectrumB.im[i];
  }
  fftInPlace(re, im, true);

  const wrap = k => ((k % size) + size) % size;
  const valueAt = k => (useAbs ? Math.abs(re[wrap(k)]) : re[wrap(k)]);
  const lo = maxLag === null ? -size / 2 : Math.ceil(center - maxLag);
  const hi = maxLag === null ? size / 2 - 1 : Math.floor(center + maxLag);

  let bestLag = lo;
  let bestValue = -Infinity;
  for (let k = lo; k <= hi; k++) {
    const value = valueAt(k);
    if (value > bestValue) {
      bestValue = value;
      bestLag = k;
    }
  }
  return (
    bestLag + parabolicPeakOffset(valueAt(bestLag - 1), valueAt(bestLag), valueAt(bestLag + 1))
  );
}

/**
 * Décalages d'alignement hybride d'un groupe d'IR, relatifs à la première
 * (référence, décalage 0) — même convention que « Cross corr align » de REW.
 *
 * Un décalage positif signifie que la mesure arrive APRÈS la référence de ce
 * temps : le retirer (Offset t=0 de ce montant) aligne les mesures.
 *
 * @param {Array<ArrayLike<number>>} impulseResponses - IR par position
 * @param {Object} params
 * @param {number} params.sampleRate - Taux d'échantillonnage commun (Hz)
 * @param {Array<number>} [params.startTimes] - Temps du premier échantillon de
 *   chaque IR (s) ; les écarts sont réintégrés dans les décalages renvoyés
 * @returns {Array<number>} Décalages en secondes (index 0 = 0)
 * @throws {TypeError|RangeError} Entrées invalides ou IR vides.
 */
export function computeHybridAlignmentOffsets(impulseResponses, { sampleRate, startTimes } = {}) {
  if (!Array.isArray(impulseResponses) || impulseResponses.length < 2) {
    throw new TypeError('computeHybridAlignmentOffsets needs at least 2 impulse responses');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Invalid sampleRate: ${sampleRate}`);
  }
  if (startTimes && startTimes.length !== impulseResponses.length) {
    throw new RangeError('startTimes length must match impulseResponses length');
  }
  const maxLength = Math.max(...impulseResponses.map(ir => ir.length));
  if (!maxLength) {
    throw new RangeError('Empty impulse response');
  }
  // ×2 : corrélations circulaires sans repliement des lags utiles.
  const size = nextPowerOfTwo(maxLength * 2);

  const spectra = impulseResponses.map(ir => forwardRealFft(ir, size));
  const envelopeSpectra = impulseResponses.map(ir =>
    forwardRealFft(hilbertEnvelope(ir, size), size),
  );

  const reference = 0;
  return impulseResponses.map((ir, index) => {
    let lagSamples = 0;
    if (index !== reference) {
      const coarse = crossCorrelationLag(envelopeSpectra[index], envelopeSpectra[reference], {
        useAbs: false,
      });
      const centroidHz = spectralCentroid(spectra[index], sampleRate);
      const halfPeriodSamples = sampleRate / (2 * centroidHz);
      lagSamples = crossCorrelationLag(spectra[index], spectra[reference], {
        maxLag: Math.max(2, halfPeriodSamples),
        center: Math.round(coarse),
      });
    }
    const startDelta = startTimes ? startTimes[index] - startTimes[reference] : 0;
    return lagSamples / sampleRate + startDelta;
  });
}
