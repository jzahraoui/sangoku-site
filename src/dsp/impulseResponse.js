/**
 * impulseResponse.js
 *
 * Réponse impulsionnelle d'une cascade de biquads — génération interne de
 * l'IR d'un bank de filtres (export OCA), sans aller-retour REW — et
 * utilitaires d'IR (pic interpolé, somme temporelle pondérée).
 *
 * L'impulsion unité traverse chaque biquad en forme directe I ; le résultat
 * est exact pour des filtres IIR (pas de FFT, pas de fenêtrage) et calculé
 * directement au taux d'échantillonnage cible.
 */

import { fractionalShift } from './ir-align.js';

/**
 * Fait passer un signal à travers une cascade de biquads (forme directe I,
 * conditions initiales nulles). L'entrée n'est pas modifiée.
 *
 * @param {ArrayLike<number>} input - Signal d'entrée (IR mesurée, impulsion…)
 * @param {Array<import('./BiquadFilter.js').BiquadFilter>} filters
 *   Filtres actifs (les coefficients doivent être calculés au sampleRate visé).
 * @returns {Float64Array}
 */
export function processThroughCascade(input, filters) {
  const sampleCount = input.length;
  const output = Float64Array.from(input);

  for (const filter of filters) {
    if (filter.hasNoEffect?.() && filter.filterType !== 'ALL_PASS') {
      continue;
    }
    const { a0, a1, a2, b0, b1, b2 } = filter;
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < sampleCount; i++) {
      const x = output[i];
      const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      output[i] = y;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
    }
  }

  return output;
}

/**
 * Fait passer une impulsion unité à travers une cascade de biquads.
 *
 * @param {Array<import('./BiquadFilter.js').BiquadFilter>} filters
 *   Filtres actifs (les coefficients doivent être calculés au sampleRate visé).
 * @param {number} sampleCount - Longueur de l'IR à produire
 * @returns {Float64Array}
 */
export function computeCascadeImpulseResponse(filters, sampleCount) {
  if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
    throw new TypeError(`Invalid sample count: ${sampleCount}`);
  }

  const unitImpulse = new Float64Array(sampleCount);
  unitImpulse[0] = 1;
  return processThroughCascade(unitImpulse, filters);
}

/**
 * Instant du pic (|max|) d'une réponse impulsionnelle, dans le référentiel
 * absolu de REW — le pendant interne du champ `timeOfIRPeakSeconds`.
 * Affinage sous-échantillon par parabole sur |x| : même convention que REW
 * (écart mesuré 1.6e-13 s sur le corpus, sonde live 5.40 B128).
 *
 * @param {{ data: ArrayLike<number>, sampleRate: number, startTime: number }} ir
 * @returns {number} secondes
 */
export function peakTimeSeconds({ data, sampleRate, startTime = 0 }) {
  let peak = -1;
  let peakIndex = 0;
  for (let i = 0; i < data.length; i++) {
    const magnitude = Math.abs(data[i]);
    if (magnitude > peak) {
      peak = magnitude;
      peakIndex = i;
    }
  }
  if (!(peak > 0)) {
    throw new Error('Empty impulse response');
  }

  const left = Math.abs(data[peakIndex - 1] ?? 0);
  const right = Math.abs(data[peakIndex + 1] ?? 0);
  const curvature = left - 2 * peak + right;
  const refinement = curvature === 0 ? 0 : (0.5 * (left - right)) / curvature;

  return startTime + (peakIndex + refinement) / sampleRate;
}

/**
 * Somme temporelle de réponses impulsionnelles dans le référentiel absolu —
 * la « somme vraie » des subs, indépendante de toute projection intermédiaire.
 *
 * Les exports d'IR de REW n'intègrent PAS le SPL offset (mesuré, 5.40 B128) :
 * les poids relatifs sont rétablis via `weightsDb` (typiquement le
 * splOffsetdB de chaque mesure). Les startTimes de REW sont quantifiés à
 * l'échantillon (la fraction d'un offset t=0 part dans les données) ; un
 * éventuel résidu fractionnaire est tout de même absorbé par rampe de phase.
 *
 * @param {Array<{ data: ArrayLike<number>, sampleRate: number, startTime: number }>} irs
 * @param {Array<number>|null} weightsDb - Poids en dB par IR (même longueur), ou null.
 * @returns {{ data: Float64Array, sampleRate: number, startTime: number }}
 */
export function combineImpulseResponses(irs, weightsDb = null) {
  if (!irs?.length) {
    throw new Error('No impulse responses to combine');
  }
  if (weightsDb && weightsDb.length !== irs.length) {
    throw new Error('weightsDb length must match the impulse response count');
  }
  const sampleRate = irs[0].sampleRate;
  for (const ir of irs) {
    if (ir.sampleRate !== sampleRate) {
      throw new Error(
        `Sample rates differ: ${ir.sampleRate} vs ${sampleRate}`,
      );
    }
  }

  const startTime = Math.min(...irs.map(ir => ir.startTime ?? 0));
  const length = Math.max(
    ...irs.map(
      ir => Math.round(((ir.startTime ?? 0) - startTime) * sampleRate) + ir.data.length,
    ),
  );

  const data = new Float64Array(length);
  irs.forEach((ir, k) => {
    const weight = weightsDb ? 10 ** (weightsDb[k] / 20) : 1;
    const offsetSamples = ((ir.startTime ?? 0) - startTime) * sampleRate;
    const wholeSamples = Math.round(offsetSamples);
    const fracSamples = offsetSamples - wholeSamples;
    const samples =
      Math.abs(fracSamples) > 1e-9
        ? fractionalShift(ir.data, -fracSamples / sampleRate, 1 / sampleRate)
        : ir.data;
    for (let i = 0; i < samples.length; i++) {
      data[wholeSamples + i] += weight * samples[i];
    }
  });

  return { data, sampleRate, startTime };
}

/**
 * IR normalisée d'un bank de filtres : pic ramené à 1 (parité avec la lecture
 * REW `getImpulseResponse(unit: 'percent', normalised: true)` du chemin
 * d'export historique).
 *
 * @param {Array<import('./BiquadFilter.js').BiquadFilter>} filters
 * @param {number} sampleCount
 * @returns {Float64Array}
 * @throws {Error} Si le pic de l'IR n'est pas à l'échantillon 0 (l'IR d'un
 *   bank d'EQ minimum-phase doit démarrer à son maximum — même garde que le
 *   chemin historique qui exigeait un premier échantillon > 0.9).
 */
export function computeNormalizedBankImpulseResponse(filters, sampleCount) {
  const impulseResponse = computeCascadeImpulseResponse(filters, sampleCount);

  let peak = 0;
  for (let i = 0; i < sampleCount; i++) {
    const magnitude = Math.abs(impulseResponse[i]);
    if (magnitude > peak) peak = magnitude;
  }
  if (!(peak > 0)) {
    throw new Error('Empty impulse response');
  }

  for (let i = 0; i < sampleCount; i++) {
    impulseResponse[i] /= peak;
  }

  if (impulseResponse[0] <= 0.9) {
    throw new Error(
      `Unexpected impulse response start value: ${impulseResponse[0]}`,
    );
  }

  return impulseResponse;
}
