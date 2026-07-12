/**
 * impulseResponse.js
 *
 * Réponse impulsionnelle d'une cascade de biquads — génération interne de
 * l'IR d'un bank de filtres (export OCA), sans aller-retour REW.
 *
 * L'impulsion unité traverse chaque biquad en forme directe I ; le résultat
 * est exact pour des filtres IIR (pas de FFT, pas de fenêtrage) et calculé
 * directement au taux d'échantillonnage cible.
 */

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

  const output = new Float64Array(sampleCount);
  output[0] = 1;

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
