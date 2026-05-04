/**
 * filterSetResponse.js
 *
 * Fonctions pures de calcul de réponse cumulée pour un ensemble de filtres biquad.
 * Ces fonctions opèrent sur un tableau de BiquadFilter et ne modifient aucun état.
 * Les filtres fautifs sont ignorés silencieusement (sans console.warn).
 */

/**
 * Calcule la réponse cumulée de tous les filtres actifs en dB.
 *
 * @param {import('./BiquadFilter.js').BiquadFilter[]} filters
 * @param {number} freq - Fréquence en Hz
 * @returns {number} Magnitude cumulée en dB
 */
export function getCumulativeResponse(filters, freq) {
  let totalDB = 0;
  for (const filter of filters) {
    if (filter.enabled && !filter.hasNoEffect()) {
      try {
        totalDB += filter.getMagnitudeDB(freq);
      } catch {
        // filtre fautif ignoré
      }
    }
  }
  return totalDB;
}

/**
 * Calcule la réponse complexe cumulée de tous les filtres actifs (multiplication complexe).
 *
 * @param {import('./BiquadFilter.js').BiquadFilter[]} filters
 * @param {number} freq - Fréquence en Hz
 * @returns {{ re: number, im: number, magnitude: number, magnitudeDB: number, phase: number }}
 */
export function getCumulativeComplexResponse(filters, freq) {
  let totalRe = 1;
  let totalIm = 0;

  for (const filter of filters) {
    if (filter.enabled && !filter.hasNoEffect()) {
      try {
        const { re, im } = filter.getComplexResponse(freq);
        const newRe = totalRe * re - totalIm * im;
        const newIm = totalRe * im + totalIm * re;
        totalRe = newRe;
        totalIm = newIm;
      } catch {
        // filtre fautif ignoré
      }
    }
  }

  const magnitude = Math.hypot(totalRe, totalIm);
  const phase = Math.atan2(totalIm, totalRe) * (180 / Math.PI);

  return {
    re: totalRe,
    im: totalIm,
    magnitude,
    magnitudeDB: 20 * Math.log10(Math.max(magnitude, Number.EPSILON)),
    phase,
  };
}

/**
 * Calcule le group delay cumulé de tous les filtres actifs.
 *
 * @param {import('./BiquadFilter.js').BiquadFilter[]} filters
 * @param {number} freq - Fréquence en Hz
 * @returns {number} Group delay total en ms
 */
export function getCumulativeGroupDelay(filters, freq) {
  let totalDelay = 0;
  for (const filter of filters) {
    if (filter.enabled && !filter.hasNoEffect()) {
      try {
        totalDelay += filter.getGroupDelay(freq);
      } catch {
        // filtre fautif ignoré
      }
    }
  }
  return totalDelay;
}

/**
 * Calcule les statistiques de group delay sur une plage de fréquences (échelle log).
 *
 * @param {object} p
 * @param {import('./BiquadFilter.js').BiquadFilter[]} p.filters
 * @param {number} p.startFreq
 * @param {number} p.endFreq
 * @param {number} p.points
 * @returns {{ min: number, max: number, maxFreq: number, range: number, avgAbsVariation: number }}
 */
export function getGroupDelayStats({ filters, startFreq, endFreq, points }) {
  const safePoints = Math.max(2, points);
  const logStart = Math.log10(startFreq);
  const logEnd = Math.log10(endFreq);
  const logStep = (logEnd - logStart) / (safePoints - 1);

  let min = Infinity;
  let max = -Infinity;
  let maxFreq = 0;
  let prevDelay = null;
  let totalVariation = 0;

  for (let i = 0; i < safePoints; i++) {
    const freq = Math.pow(10, logStart + i * logStep);
    const delay = getCumulativeGroupDelay(filters, freq);

    if (delay < min) min = delay;
    if (delay > max) {
      max = delay;
      maxFreq = freq;
    }

    if (prevDelay !== null) {
      totalVariation += Math.abs(delay - prevDelay);
    }
    prevDelay = delay;
  }

  return {
    min,
    max,
    maxFreq,
    range: max - min,
    avgAbsVariation: totalVariation / (safePoints - 1),
  };
}
