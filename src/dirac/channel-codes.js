/**
 * channel-codes.js — [MOTEUR] module.
 *
 * Mappe un libelle d'enceinte Dirac Live (ex. "Front Left", "Surround Back Right",
 * "Subwoofer 1") vers le code de canal AVR de RCH (FL, SBR, SW1...).
 *
 * Contrairement au decodeur Python de reference (qui parse le SOURCE de
 * audyssey.js par regex), on resout directement contre l'objet `CHANNEL_TYPES` :
 * on construit une table {nom_de_type_normalise -> code} a partir des cles
 * `EnChannelType_*`, puis on normalise le libelle Dirac de la meme facon.
 *
 * La normalisation reproduit la logique Python `speaker_code` :
 *   - "Subwoofer N" -> "SWN" (via CHANNEL_TYPES.getStandardSubwooferName) ;
 *   - "surround back" -> "sback", "surround" -> "surr" ;
 *   - suppression de tout caractere non alphanumerique, minuscules.
 */

import { CHANNEL_TYPES } from '../audyssey.js';

/** Table {nom-de-type-normalise -> {code, channelIndex}}, construite une fois. */
const LABEL_KEY_TO_INFO = buildLabelKeyMap();

function buildLabelKeyMap() {
  const map = new Map();
  for (const [key, value] of Object.entries(CHANNEL_TYPES)) {
    if (!key.startsWith('EnChannelType_')) continue;
    if (!value || typeof value !== 'object' || !value.code) continue;
    const norm = key.slice('EnChannelType_'.length).toLowerCase();
    if (!map.has(norm)) map.set(norm, { code: value.code, channelIndex: value.channelIndex });
  }
  return map;
}

/** Normalise un libelle Dirac en cle comparable aux noms de type CHANNEL_TYPES. */
function normalizeLabel(label) {
  return label
    .trim()
    .toLowerCase()
    .replace(/surround back/g, 'sback')
    .replace(/surround/g, 'surr')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Code AVR + index de canal pour un libelle Dirac, ou null si non resolu.
 * @param {string} label
 * @returns {{code:string, channelIndex:number}|null}
 */
export function channelInfoForLabel(label) {
  if (!label) return null;
  const low = label.trim().toLowerCase();
  // "Subwoofer N" -> "SWN" -> EnChannelType_SWMixN
  if (low.startsWith('subwoofer')) {
    const rest = low.slice('subwoofer'.length).trim();
    if (/^\d+$/.test(rest)) {
      const code = CHANNEL_TYPES.getStandardSubwooferName(`SW${rest}`);
      const type = CHANNEL_TYPES[`EnChannelType_SWMix${rest}`];
      return code ? { code, channelIndex: type?.channelIndex ?? null } : null;
    }
  }
  const key = normalizeLabel(label);
  return LABEL_KEY_TO_INFO.get(key) ?? null;
}

/**
 * Code AVR pour un libelle d'enceinte Dirac, ou null si non resolu.
 * @param {string} label
 * @returns {string|null}
 */
export function codeForLabel(label) {
  return channelInfoForLabel(label)?.code ?? null;
}

/**
 * Code AVR pour le canal `ch` a partir des metadonnees de conteneur, avec repli
 * sur le libelle assaini (imite `code_for` du Python).
 * @param {{channelLabels?: (string|null)[]}} meta
 * @param {number} ch
 * @returns {string}
 */
export function codeFor(meta, ch) {
  const labels = meta?.channelLabels;
  const label = labels && ch != null && ch < labels.length ? labels[ch] : null;
  const code = codeForLabel(label);
  if (code) return code;
  const fallback = label ?? (ch != null ? `ch${ch}` : 'unknown');
  return trimChar(fallback.replace(/[^A-Za-z0-9_-]+/g, '-'), '-');
}

/** Retire les occurrences de `ch` en tete et en queue de `s` (sans regex). */
function trimChar(s, ch) {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === ch) a++;
  while (b > a && s[b - 1] === ch) b--;
  return s.slice(a, b);
}
