/**
 * filterSetSerialization.js
 *
 * Fonctions pures de sérialisation / désérialisation pour FilterSet.
 * Les filtres invalides sont ignorés silencieusement (sans console.error).
 */

import { validateNumber } from '../core/validators.js';
import { BiquadFilter } from './BiquadFilter.js';
import { FILTER_TYPES } from './filterTypes.js';

/**
 * Sérialise un FilterSet en objet JSON.
 *
 * @param {{ sampleRate: number, filters: import('./BiquadFilter.js').BiquadFilter[] }} filterSet
 * @returns {{ sampleRate: number, filters: object[] }}
 */
export function filterSetToJSON(filterSet) {
  return {
    sampleRate: filterSet.sampleRate,
    filters: filterSet.filters.map(f => f.toJSON()),
  };
}

/**
 * Charge un objet JSON dans un FilterSet existant.
 * Réinitialise les filtres existants avant chargement.
 * Ajoute des filtres si le JSON en contient plus que l'instance.
 * Les filtres invalides sont ignorés (restent vides/reset).
 *
 * @param {{ sampleRate: number, filters: import('./BiquadFilter.js').BiquadFilter[] }} filterSet
 * @param {object} json
 * @throws {TypeError} Si json n'est pas un objet valide ou si filters n'est pas un tableau
 */
export function loadFilterSetFromJSON(filterSet, json) {
  if (!json || typeof json !== 'object') {
    throw new TypeError('JSON must be a valid object');
  }

  filterSet.sampleRate = validateNumber(
    json.sampleRate ?? 48000,
    'sampleRate',
    8000,
    384000,
  );

  const filtersArray = json.filters ?? [];
  if (!Array.isArray(filtersArray)) {
    throw new TypeError('filters must be an array');
  }

  const originalCount = filterSet.filters.length;

  // Reset all existing filters
  for (const filter of filterSet.filters) {
    filter.filterType = FILTER_TYPES.NONE;
    filter.gain = 0;
    filter.resetToUnity();
    filter.calcDone = true;
  }

  // Load up to min(json count, original count)
  const loadCount = Math.min(filtersArray.length, originalCount);
  for (let i = 0; i < loadCount; i++) {
    try {
      filterSet.filters[i].fromJSON({
        ...filtersArray[i],
        sampleRate: filterSet.sampleRate,
      });
    } catch {
      // filtre invalide → reste reset/vide
    }
  }

  // If JSON has more filters than the instance, append new ones
  for (let i = originalCount; i < filtersArray.length; i++) {
    try {
      const filter = new BiquadFilter(filterSet.sampleRate);
      filter.fromJSON({
        ...filtersArray[i],
        sampleRate: filterSet.sampleRate,
      });
      filterSet.filters.push(filter);
    } catch {
      filterSet.filters.push(new BiquadFilter(filterSet.sampleRate));
    }
  }
}
