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
 * Temps d'arrivée d'une IR par la phase en excès (méthode « Estimate IR
 * delay » de REW) : lag de corrélation entre l'IR et sa contrepartie à phase
 * minimale (cepstre du log-module, quefrences positives doublées). Insensible
 * aux pics accrochés sur une réflexion dominante — mesuré sur le corpus ADY
 * (barmatic/TML P3 : pic à 27.2 ms sur une réflexion, arrivée réelle 9.2 ms
 * retrouvée) — et identique au pic sur les canaux sains.
 *
 * Le temps renvoyé est relatif au premier échantillon de l'IR fournie
 * (ajouter le startTime de la mesure pour un temps absolu).
 *
 * @param {ArrayLike<number>} impulseResponse
 * @param {Object} params
 * @param {number} params.sampleRate - Taux d'échantillonnage (Hz)
 * @param {number} [params.maxSamples=65536] - Longueur d'analyse maximale :
 *   l'arrivée est dans le premier front d'énergie, inutile (et coûteux l'IR
 *   étant longue) d'analyser toute la queue
 * @returns {number} Temps d'arrivée en secondes (fractionnaire)
 * @throws {TypeError|RangeError} Entrées invalides.
 */
export function excessPhaseArrivalSeconds(impulseResponse, { sampleRate, maxSamples = 65536 } = {}) {
  if (!impulseResponse?.length) {
    throw new TypeError('excessPhaseArrivalSeconds needs a non-empty impulse response');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`Invalid sampleRate: ${sampleRate}`);
  }
  const length = Math.min(impulseResponse.length, maxSamples);
  const size = nextPowerOfTwo(length * 2);

  const { re, im } = forwardRealFft(
    length === impulseResponse.length
      ? impulseResponse
      : Array.prototype.slice.call(impulseResponse, 0, length),
    size,
  );

  // log|H| avec plancher à −200 dB du max (bins quasi nuls du zéro-padding)
  const magnitude = new Float64Array(size);
  let maxMagnitude = Number.MIN_VALUE;
  for (let i = 0; i < size; i++) {
    magnitude[i] = Math.hypot(re[i], im[i]);
    if (magnitude[i] > maxMagnitude) maxMagnitude = magnitude[i];
  }
  const floor = maxMagnitude * 1e-10;
  const logRe = new Float64Array(size);
  const logIm = new Float64Array(size);
  for (let i = 0; i < size; i++) logRe[i] = Math.log(Math.max(magnitude[i], floor));

  // Cepstre réel → fenêtre de phase minimale → spectre à phase minimale
  fftInPlace(logRe, logIm, true);
  for (let i = 1; i < size / 2; i++) {
    logRe[i] *= 2;
    logIm[i] *= 2;
  }
  for (let i = size / 2 + 1; i < size; i++) {
    logRe[i] = 0;
    logIm[i] = 0;
  }
  fftInPlace(logRe, logIm);
  const minPhase = { re: new Float64Array(size), im: new Float64Array(size) };
  for (let i = 0; i < size; i++) {
    const gain = Math.exp(logRe[i]);
    minPhase.re[i] = gain * Math.cos(logIm[i]);
    minPhase.im[i] = gain * Math.sin(logIm[i]);
  }

  // Le lag IR ↔ phase minimale est le retard en excès = temps d'arrivée
  const lagSamples = crossCorrelationLag({ re, im }, minPhase);
  return lagSamples / sampleRate;
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
