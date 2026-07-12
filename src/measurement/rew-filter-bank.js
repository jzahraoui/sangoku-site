/**
 * rew-filter-bank.js — [MOTEUR] module.
 *
 * Convertit un bank de filtres REW (tableau de FilterSetting :
 * { index, type, enabled, frequency, q, gaindB, … }) en cascade de
 * BiquadFilter internes, pour la génération d'IR de l'export OCA.
 *
 * Types réalisés : PK (peaking) et All pass (le all-pass slot 20/21 des
 * subs). Tout autre type ACTIF lève une erreur explicite : sur le chemin
 * audio-critique (le fichier chargé dans l'AVR), un type approximé en
 * silence serait pire qu'un échec net.
 */

import { BiquadFilter } from '../dsp/BiquadFilter.js';

const INERT_TYPES = new Set(['None', 'Text']);

/**
 * @param {Array<object>} bank - FilterSetting[] tels que renvoyés par REW
 * @param {number} sampleRate - Taux d'échantillonnage cible (Hz)
 * @returns {Array<BiquadFilter>} cascade des filtres actifs
 * @throws {Error} Si un filtre actif porte un type non réalisable en interne.
 */
export function buildBiquadCascadeFromRewBank(bank, sampleRate) {
  const cascade = [];

  for (const setting of bank ?? []) {
    if (!setting || setting.enabled === false) continue;
    const type = setting.type;
    if (type === undefined || INERT_TYPES.has(type)) continue;

    if (type === 'PK') {
      const gain = setting.gaindB ?? 0;
      if (Math.abs(gain) < 0.005) continue;
      const filter = new BiquadFilter(sampleRate);
      filter.setPeaking(setting.frequency, setting.q, gain);
      cascade.push(filter);
      continue;
    }

    if (type === 'All pass') {
      const filter = new BiquadFilter(sampleRate);
      filter.setAllPass(setting.frequency, setting.q);
      cascade.push(filter);
      continue;
    }

    throw new Error(
      `Unsupported filter type "${type}" at slot ${setting.index}: the internal ` +
        `OCA filter generation realises PK and All pass filters. Replace or ` +
        `disable this filter, or extend the DSP mapping.`,
    );
  }

  return cascade;
}
