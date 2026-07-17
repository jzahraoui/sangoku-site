/**
 * binary-reader.js — [MOTEUR] module.
 *
 * Primitives de lecture bas niveau pour le conteneur binaire maison des fichiers
 * Dirac Live `.liveproject` (format entierement big-endian, cf.
 * work/docs/PLAN-dirac-liveproject-import.md et la retro-ingenierie associee).
 *
 * Le conteneur melange :
 *   - des entiers non signes 32 bits big-endian (`u32be`) ;
 *   - des flottants IEEE-754 64 bits big-endian (les grilles/magnitudes) ;
 *   - des flottants 32 bits little-endian (zone protobuf : cal micro, trims) ;
 *   - des chaines UTF-16BE prefixees de leur longueur en octets.
 *
 * Toutes les fonctions operent sur un `Uint8Array` (`bytes`) accompagne d'un
 * `DataView` partageant le meme buffer pour eviter les copies.
 */

/**
 * Cree une vue conjointe {bytes, view} sur un ArrayBuffer/Uint8Array/Buffer.
 * @param {ArrayBuffer|Uint8Array|ArrayBufferView} input
 * @returns {{ bytes: Uint8Array, view: DataView }}
 */
export function createByteView(input) {
  let bytes;
  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    throw new TypeError('createByteView: attendu ArrayBuffer, Uint8Array ou ArrayBufferView');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { bytes, view };
}

/** Entier non signe 32 bits big-endian a l'offset `off`. */
export function u32be(view, off) {
  return view.getUint32(off, false);
}

/**
 * Lit `count` float64 big-endian a partir de `off`.
 * @returns {Float64Array}
 */
export function readFloat64BEArray(view, off, count) {
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = view.getFloat64(off + i * 8, false);
  }
  return out;
}

/**
 * Lit `count` float32 little-endian a partir de `off` (zone protobuf).
 * @returns {Float32Array}
 */
export function readFloat32LEArray(view, off, count) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = view.getFloat32(off + i * 4, true);
  }
  return out;
}

const UTF16BE_DECODER = new TextDecoder('utf-16be', { fatal: true });

/**
 * Chaine UTF-16BE prefixee : u32 BE longueur-en-octets (toujours paire) puis
 * le texte. Retourne {text, next} ou null si le prefixe/encodage est invalide
 * (imite `read_prefixed_string` du Python : longueur paire, bornee, imprimable).
 *
 * @param {DataView} view
 * @param {Uint8Array} bytes
 * @param {number} off
 * @param {number} [maxLen=4096] borne de securite sur la longueur en octets
 * @returns {{ text: string, next: number } | null}
 */
export function readUtf16beString(view, bytes, off, maxLen = 4096) {
  if (off < 0 || off + 4 > bytes.length) return null;
  const len = u32be(view, off);
  if (len === 0 || len > maxLen || len % 2 !== 0 || off + 4 + len > bytes.length) {
    return null;
  }
  let text;
  try {
    text = UTF16BE_DECODER.decode(bytes.subarray(off + 4, off + 4 + len));
  } catch {
    return null;
  }
  // Rejette les chaines non imprimables (parite avec le garde-fou Python).
  if (!isPrintable(text)) return null;
  return { text, next: off + 4 + len };
}

/** Vrai si toutes les runes de `text` sont imprimables (pas de controle). */
function isPrintable(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    // Controles C0 (sauf rien d'autorise ici) et C1.
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
  }
  return true;
}

/**
 * Encode une chaine ASCII en aiguille UTF-16BE (pour rechercher des cles connues
 * comme "measurement::" dans le flux binaire). Chaque caractere -> `00 XX`.
 * @param {string} ascii
 * @returns {Uint8Array}
 */
export function utf16beNeedle(ascii) {
  const out = new Uint8Array(ascii.length * 2);
  for (let i = 0; i < ascii.length; i++) {
    out[i * 2] = (ascii.charCodeAt(i) >> 8) & 0xff;
    out[i * 2 + 1] = ascii.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Cherche la sous-sequence d'octets `needle` dans `haystack` a partir de `from`,
 * bornee optionnellement a `end`. Retourne l'index ou -1. Recherche naive :
 * les aiguilles utilisees sont courtes (cles, magic, sentinelles).
 *
 * @param {Uint8Array} haystack
 * @param {Uint8Array} needle
 * @param {number} [from=0]
 * @param {number} [end=haystack.length]
 * @returns {number}
 */
export function indexOfBytes(haystack, needle, from = 0, end = haystack.length) {
  const n = needle.length;
  if (n === 0) return from;
  const last = Math.min(end, haystack.length) - n;
  const first = needle[0];
  for (let i = Math.max(0, from); i <= last; i++) {
    if (haystack[i] !== first) continue;
    let ok = true;
    for (let j = 1; j < n; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}
