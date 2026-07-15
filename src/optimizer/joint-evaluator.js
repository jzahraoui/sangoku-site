/**
 * Évaluateur dédié au chemin chaud du solveur joint (target-match).
 *
 * Le chemin standard (calculateResponseWithParams → dB/degrés par sub →
 * calculateCombinedResponse → re-linéaire/radians → somme → re-dB/degrés)
 * paie un aller-retour de conversions par sub et par bin, et recalcule à
 * chaque évaluation des grandeurs invariantes de la mesure (magnitude
 * linéaire de base, phase en radians, 2π·f). Mesuré au banc : ~22 % du temps
 * d'un run en conversions pures. Ce module fusionne le tout en une passe
 * entièrement linéaire/radians sur des buffers réutilisés — la conversion
 * dB/degrés n'est payée qu'une fois, sur la somme, pour le scorer.
 *
 * Il ne remplace PAS le chemin standard : ses sorties partagées avec le
 * reste du moteur (getFinalSubSum, évaluation legacy, rapports) restent sur
 * calculateResponseWithParams/calculateCombinedResponse. Le flux joint ne
 * l'utilise que pour la fonction de coût du solveur ; le score de baseline
 * et le bestSum final restent calculés par le chemin classique (référence de
 * vérité, et aucun aliasing des buffers réutilisés dans le résultat rendu).
 *
 * Écart numérique vs le chemin standard : le chemin classique stocke les
 * réponses par sub en Float32 dB puis reconvertit (quantification +
 * non-réciprocité pow/log10) — la fusion supprime cet arrondi intermédiaire.
 * Écarts d'ordre ULP sur le coût : trajectoires DE potentiellement
 * différentes à seed égal, qualité équivalente (validation multi-seeds).
 */
import Polar from '../Polar.js';
import { computePeakingCoefficients } from '../dsp/biquadCoefficients.js';
import {
  getComplexResponseFromNormalizedInto,
  normalizeBiquadCoefficients,
} from '../dsp/biquadResponse.js';
import {
  FILTER_SAMPLE_RATE,
  calculateAllPassResponse,
  getFilterTrigTable,
} from './response.js';

/**
 * Décimation de grille locale au solveur : garde un bin sur `stride`
 * (indices 0, stride, 2·stride…) des subs préparés. Un tableau décimé par
 * LES MÊMES indices reste bin-à-bin cohérent avec ces subs (cible, poids).
 * Retourne les subs d'origine si stride ≤ 1.
 */
export function decimatePreparedSubs(preparedSubs, stride) {
  if (!Number.isInteger(stride) || stride <= 1) return preparedSubs;

  return preparedSubs.map(sub => ({
    ...sub,
    freqs: decimateArray(sub.freqs, stride),
    magnitude: decimateArray(sub.magnitude, stride),
    phase: decimateArray(sub.phase, stride),
    // Grille log-espacée : un bin sur `stride` divise la résolution ppo et
    // élève le pas d'un facteur `stride` en exposant.
    ppo: sub.ppo ? sub.ppo / stride : sub.ppo,
    freqStep: sub.freqStep ? Math.pow(sub.freqStep, stride) : sub.freqStep,
  }));
}

export function decimateArray(values, stride) {
  const size = Math.ceil(values.length / stride);
  const out = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = values[i * stride];
  }
  return out;
}

/**
 * Précalcule les invariants de grille/mesure et alloue les buffers scratch.
 * À créer UNE fois par run du solveur (les subs préparés gardent la même
 * grille et les mêmes mesures pour toutes les évaluations de candidats).
 */
export function createJointEvaluationContext(preparedSubs) {
  const freqs = preparedSubs[0].freqs;
  const size = freqs.length;

  const subs = preparedSubs.map(sub => {
    const linMag = new Float64Array(size);
    const phaseRad = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      linMag[i] = Polar.DbToLinearGain(sub.magnitude[i]);
      phaseRad[i] = sub.phase[i] * Polar.DEGREES_TO_RADIANS;
    }
    return { linMag, phaseRad };
  });

  // 2π·f par bin : le terme de délai du chemin classique est
  // (TWO_PI · f) · delay — même associativité ici.
  const omega = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    omega[i] = Polar.TWO_PI * freqs[i];
  }

  return {
    freqs,
    size,
    subs,
    omega,
    trig: getFilterTrigTable(freqs),
    sumRe: new Float64Array(size),
    sumIm: new Float64Array(size),
    h: { re: 1, im: 0 },
    filterScratch: [],
    // Phase realign : contributions de filtres gelées (voir setFrozenFilters).
    frozenFilters: null,
    // Somme combinée en Float32, comme la sortie du chemin classique : le
    // scorer lit la même quantification de sortie.
    response: {
      freqs,
      magnitude: new Float32Array(size),
      phase: new Float32Array(size),
      freqStep: preparedSubs[0].freqStep,
      ppo: preparedSubs[0].ppo,
    },
  };
}

/**
 * Somme vectorielle complexe des subs sous `params`, en une passe lin/rad.
 * Équivalent (à la quantification Float32 intermédiaire près) de
 * calculateCombinedResponse(buildParameterizedSubResponses(preparedSubs)).
 *
 * ⚠️ Retourne l'objet réponse RÉUTILISÉ du contexte : à consommer avant la
 * prochaine évaluation, ne jamais le stocker ni le renvoyer à l'appelant.
 */
export function evaluateCombinedResponse(context, params) {
  const { size, subs, sumRe, sumIm } = context;
  sumRe.fill(0);
  sumIm.fill(0);

  for (let subIndex = 0; subIndex < subs.length; subIndex++) {
    const frozen = context.frozenFilters?.[subIndex] ?? null;
    if (frozen) {
      accumulateFrozenSub(context, subs[subIndex], params[subIndex], frozen);
    } else {
      accumulateLiveSub(context, subs[subIndex], params[subIndex]);
    }
  }

  const response = context.response;
  for (let i = 0; i < size; i++) {
    response.magnitude[i] = 20 * Math.log10(Math.max(Math.hypot(sumRe[i], sumIm[i]), Number.EPSILON));
    response.phase[i] = Math.atan2(sumIm[i], sumRe[i]) * Polar.RADIANS_TO_DEGREES;
  }
  return response;
}

function accumulateLiveSub(context, sub, param) {
  const { size, omega, sumRe, sumIm, h, trig, freqs } = context;
  const { linMag, phaseRad } = sub;
  const gainLinear = Polar.DbToLinearGain(param.gain);
  const delay = param.delay;
  const polarityPhase = param.polarity === -1 ? Math.PI : 0;
  const allPassPhaseShift = param.allPass?.enabled
    ? calculateAllPassResponse(param.allPass.frequency, param.allPass.q)
    : null;
  const filterCoefficients = buildNormalizedFilters(context, param.filters);

  for (let i = 0; i < size; i++) {
    let magnitudeLinear = linMag[i] * gainLinear;
    let phaseRadians = phaseRad[i] + omega[i] * delay + polarityPhase;

    if (allPassPhaseShift) {
      phaseRadians += allPassPhaseShift(freqs[i]) * Polar.DEGREES_TO_RADIANS;
    }

    for (let f = 0; f < filterCoefficients.length; f++) {
      getComplexResponseFromNormalizedInto(
        filterCoefficients[f],
        trig.cosW[i],
        trig.sinW[i],
        trig.cos2W[i],
        trig.sin2W[i],
        h,
      );
      magnitudeLinear *= Math.hypot(h.re, h.im);
      phaseRadians += Math.atan2(h.im, h.re);
    }

    sumRe[i] += magnitudeLinear * Math.cos(phaseRadians);
    sumIm[i] += magnitudeLinear * Math.sin(phaseRadians);
  }
}

// Filtres gelés (phase realign) : mêmes |H| et arguments que la cascade
// vivante, appliqués filtre par filtre dans le même ordre — bit-identique,
// sans réévaluer les biquads.
function accumulateFrozenSub(context, sub, param, frozen) {
  const { size, omega, sumRe, sumIm, freqs } = context;
  const { linMag, phaseRad } = sub;
  const gainLinear = Polar.DbToLinearGain(param.gain);
  const delay = param.delay;
  const polarityPhase = param.polarity === -1 ? Math.PI : 0;
  const allPassPhaseShift = param.allPass?.enabled
    ? calculateAllPassResponse(param.allPass.frequency, param.allPass.q)
    : null;

  for (let i = 0; i < size; i++) {
    let magnitudeLinear = linMag[i] * gainLinear;
    let phaseRadians = phaseRad[i] + omega[i] * delay + polarityPhase;

    if (allPassPhaseShift) {
      phaseRadians += allPassPhaseShift(freqs[i]) * Polar.DEGREES_TO_RADIANS;
    }

    for (let f = 0; f < frozen.length; f++) {
      magnitudeLinear *= frozen[f].mag[i];
      phaseRadians += frozen[f].phase[i];
    }

    sumRe[i] += magnitudeLinear * Math.cos(phaseRadians);
    sumIm[i] += magnitudeLinear * Math.sin(phaseRadians);
  }
}

/**
 * Gèle les contributions de filtres par sub pour la phase realign : les
 * dimensions filtres du génome y sont bornées à un point (le vainqueur),
 * donc |H| et argument de chaque filtre sont constants pour tous les
 * candidats de la phase. Précalculés une fois par bin avec les MÊMES
 * coefficients normalisés et la même table trig que la cascade vivante, et
 * appliqués filtre par filtre dans le même ordre → coûts bit-identiques.
 * ~2 Float64Array par filtre actif (≈ 39 Ko/sub sur 805 bins, 3 filtres).
 */
export function setFrozenFilters(context, params) {
  const { size, trig, h } = context;
  context.frozenFilters = params.map(param => {
    const filterCoefficients = buildNormalizedFilters(context, param.filters);
    const contributions = [];
    for (let f = 0; f < filterCoefficients.length; f++) {
      const mag = new Float64Array(size);
      const phase = new Float64Array(size);
      for (let i = 0; i < size; i++) {
        getComplexResponseFromNormalizedInto(
          filterCoefficients[f],
          trig.cosW[i],
          trig.sinW[i],
          trig.cos2W[i],
          trig.sin2W[i],
          h,
        );
        mag[i] = Math.hypot(h.re, h.im);
        phase[i] = Math.atan2(h.im, h.re);
      }
      contributions.push({ mag, phase });
    }
    return contributions;
  });
}

export function clearFrozenFilters(context) {
  context.frozenFilters = null;
}

// Mêmes règles que calculateResponseWithParams : un gain quasi nul est
// acoustiquement neutre et sauté ; coefficients calculés puis a0-normalisés
// une fois par filtre. Le tableau scratch du contexte est réutilisé.
function buildNormalizedFilters(context, filters) {
  const out = context.filterScratch;
  out.length = 0;
  if (!filters) return out;

  for (const filter of filters) {
    if (Math.abs(filter.gain) < 0.01) continue;
    out.push(
      normalizeBiquadCoefficients(
        computePeakingCoefficients({
          fc: filter.frequency,
          Q: filter.q,
          gain: filter.gain,
          sampleRate: FILTER_SAMPLE_RATE,
        }),
      ),
    );
  }
  return out;
}
