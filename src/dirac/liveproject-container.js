/**
 * liveproject-container.js — [MOTEUR] module.
 *
 * Parseur du conteneur binaire big-endian d'un fichier Dirac Live `.liveproject`.
 * Port de extract_liveproject.py. Extrait :
 *   - les courbes de MAGNITUDE stockees (cles `measurement::measuredRes_pos<P>_ch<N>`,
 *     grille de frequence 2048 pts + magnitude dB) — sans phase : elles ne servent
 *     qu'a la validation et a l'appariement chrono->position ;
 *   - les libelles d'enceintes, la version/appareil (best-effort) ;
 *   - les niveaux mesures par canal ;
 *   - la calibration micro embarquee (zone protobuf, champs #14/#15).
 *
 * Structure d'un enregistrement de courbe (apres la cle) :
 *   1) grille de frequence : magic 0x12345678 + flag(u32) + count(u32) + count x f64 BE ;
 *   2) magnitude (dB)      : count(u32) + count x f64 BE (sans magic).
 */

import {
  createByteView,
  u32be,
  readFloat64BEArray,
  readUtf16beString,
  utf16beNeedle,
  indexOfBytes,
} from './binary-reader.js';
import { findProtoZone, walkMessage } from './protobuf.js';
import { codeForLabel } from './channel-codes.js';

const MAGIC = Uint8Array.of(0x12, 0x34, 0x56, 0x78);
const KEY_NEEDLE = utf16beNeedle('measurement::');
const MAX_CURVE_POINTS = 1_000_000;
const KEY_RE = /^measurement::(?<name>[A-Za-z]+)_pos(?<pos>\d+)_ch(?<ch>\d+)$/;

function validCount(count) {
  return count > 0 && count <= MAX_CURVE_POINTS;
}

function allFinite(arr, count) {
  for (let i = 0; i < count; i++) if (!Number.isFinite(arr[i])) return false;
  return true;
}

function isStrictlyIncreasing(arr) {
  for (let i = 1; i < arr.length; i++) if (arr[i - 1] >= arr[i]) return false;
  return true;
}

/**
 * Cherche le MAGIC dans les `searchLimit` octets suivant `start`, puis lit la
 * paire (grille de frequence marquee, magnitude non marquee).
 * @returns {{offset,flag,count,freq:Float64Array,magCount,mag:Float64Array,freqMonotonic,end}|null}
 */
export function parseCurvePair(bytes, view, start, searchLimit = 256) {
  const m = indexOfBytes(bytes, MAGIC, start, start + searchLimit);
  if (m < 0) return null;
  const flag = u32be(view, m + 4);
  const count = u32be(view, m + 8);
  if (!validCount(count)) return null;
  const gridEnd = m + 12 + count * 8;
  if (gridEnd + 4 > bytes.length) return null;
  const freq = readFloat64BEArray(view, m + 12, count);
  const magCount = u32be(view, gridEnd);
  if (!validCount(magCount)) return null;
  const magEnd = gridEnd + 4 + magCount * 8;
  if (magEnd > bytes.length) return null;
  const mag = readFloat64BEArray(view, gridEnd + 4, magCount);
  // Validations : premiers points de grille finis, magnitude finie.
  if (!allFinite(freq, Math.min(8, count)) || !allFinite(mag, magCount)) return null;
  return {
    offset: m,
    flag,
    count,
    freq,
    magCount,
    mag,
    freqMonotonic: isStrictlyIncreasing(freq),
    end: magEnd,
  };
}

/**
 * Trouve toutes les cles 'measurement::...' (chaines prefixees valides).
 * @returns {Array<{key:string, keyOffset:number, dataOffset:number}>}
 */
export function findMeasurementKeys(bytes, view) {
  const results = [];
  let i = 0;
  for (;;) {
    i = indexOfBytes(bytes, KEY_NEEDLE, i);
    if (i < 0) break;
    // La cle complete commence 4 octets avant si le prefixe de longueur colle.
    const s = readUtf16beString(view, bytes, i - 4, 2048);
    if (s && s.text.startsWith('measurement::')) {
      results.push({ key: s.text, keyOffset: i - 4, dataOffset: s.next });
      i = s.next;
    } else {
      i += 2;
    }
  }
  return results;
}

/**
 * Cherche, avant la 1re cle de mesure, un u32 == nch suivi de nch chaines
 * prefixees consecutives (les libelles d'enceintes). Garde la derniere occurrence.
 * @returns {string[]|null}
 */
export function extractChannelLabels(bytes, view, firstKeyOffset, nch) {
  if (!nch) return null;
  const windowStart = Math.max(0, firstKeyOffset - 65536);
  const needle = Uint8Array.of((nch >>> 24) & 0xff, (nch >>> 16) & 0xff, (nch >>> 8) & 0xff, nch & 0xff);
  let i = windowStart;
  let best = null;
  for (;;) {
    i = indexOfBytes(bytes, needle, i, firstKeyOffset);
    if (i < 0) break;
    const labels = [];
    let p = i + 4;
    let ok = true;
    for (let k = 0; k < nch; k++) {
      const s = readUtf16beString(view, bytes, p, 256);
      if (!s) {
        ok = false;
        break;
      }
      labels.push(s.text);
      p = s.next;
    }
    if (ok) best = labels;
    i += 4;
  }
  return best;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;

function isDigit(c) {
  return c >= 0x30 && c <= 0x39;
}

/** Fin d'une suite UTF-16BE de chiffres/points a partir de `off`. */
function scanVersionEnd(bytes, off, limit) {
  let end = off;
  while (end < limit && bytes[end] === 0x00 && (isDigit(bytes[end + 1]) || bytes[end + 1] === 0x2e)) {
    end += 2;
  }
  return end;
}

/** Offset de la chaine version "X.Y.Z" (UTF-16BE) dans la fenetre, ou -1. */
function findVersionOffset(bytes, windowStart, firstKeyOffset) {
  for (let off = windowStart; off < firstKeyOffset - 8; off += 2) {
    if (bytes[off] !== 0x00 || !isDigit(bytes[off + 1])) continue;
    const end = scanVersionEnd(bytes, off, firstKeyOffset - 1);
    if (VERSION_RE.test(decodeAsciiUtf16be(bytes, off, end))) return off;
  }
  return -1;
}

/** Lit jusqu'a `maxCount` chaines prefixees consecutives (saute un champ non-chaine). */
function readStringSequence(view, bytes, startOff, maxCount) {
  const seq = [];
  let p = startOff;
  for (let k = 0; k < maxCount; k++) {
    let s = readUtf16beString(view, bytes, p, 256);
    if (!s) {
      p += 4; // champ non-chaine (ex. u32 count) : avance et retente
      s = readUtf16beString(view, bytes, p, 256);
      if (!s) break;
    }
    seq.push(s.text);
    p = s.next;
  }
  return seq;
}

/**
 * Best-effort : version Dirac / arrangement / vendeur / modele, sequence de
 * chaines juste avant la zone des mesures.
 * @returns {{diracVersion?:string, arrangement?:string, deviceVendor?:string, deviceModel?:string}}
 */
export function extractDeviceMetadata(bytes, view, firstKeyOffset) {
  const meta = {};
  const windowStart = Math.max(0, firstKeyOffset - 65536);
  const versionOff = findVersionOffset(bytes, windowStart, firstKeyOffset);
  if (versionOff < 0) return meta;
  // La chaine version est prefixee : sa longueur est a off-4.
  const seq = readStringSequence(view, bytes, versionOff - 4, 8);
  if (seq.length >= 2) {
    meta.diracVersion = seq[0];
    meta.arrangement = seq[1];
  }
  if (seq.length >= 4) {
    meta.deviceVendor = seq[2];
    meta.deviceModel = seq[3];
  }
  return meta;
}

function decodeAsciiUtf16be(bytes, start, end) {
  let out = '';
  for (let i = start; i + 1 < end; i += 2) {
    if (bytes[i] !== 0x00) return '';
    out += String.fromCharCode(bytes[i + 1]);
  }
  return out;
}

/** Ligne de 15 niveaux valides (u32=15 + 15 f64 BE) a `p`, ou null. */
function readLevelRow(view, p) {
  if (u32be(view, p) !== 15) return null;
  const vals = readFloat64BEArray(view, p + 4, 15);
  for (const v of vals) {
    if (!Number.isFinite(v) || v < 0 || v > 200) return null;
  }
  return Array.from(vals);
}

/** Tente de lire une table de niveaux Nlignes a partir du magic `m`, ou null. */
function readLevelsTable(bytes, view, m) {
  const nrows = u32be(view, m + 8);
  if (nrows < 1 || nrows > 64 || m + 12 + nrows * 124 > bytes.length) return null;
  const rows = [];
  let p = m + 12;
  for (let r = 0; r < nrows; r++) {
    const row = readLevelRow(view, p);
    if (!row) return null;
    rows.push(row);
    p += 124;
  }
  return rows;
}

/**
 * Niveaux mesures par canal, une ligne par position micro. Table marquee
 * (magic + flag + Nlignes) suivie de Nlignes x (u32=15 + 15 f64 BE), avant les
 * courbes. Retourne number[][] ([pos][ch]) ou null.
 */
export function extractChannelLevels(bytes, view) {
  const firstKey = indexOfBytes(bytes, KEY_NEEDLE, 0);
  const limit = firstKey < 0 ? bytes.length : firstKey;
  let i = 0;
  for (;;) {
    const m = indexOfBytes(bytes, MAGIC, i, limit);
    if (m < 0) return null;
    const rows = readLevelsTable(bytes, view, m);
    if (rows) return rows;
    i = m + 1;
  }
}

/**
 * Calibration micro embarquee (zone protobuf, champs #14 frequences / #15 gains,
 * float32 LE). Retourne {freqs:number[], gainsDb:number[]} ou null.
 */
export function extractMicCal(bytes, view) {
  const zone = findProtoZone(bytes, view);
  if (!zone) return null;
  let f14 = null;
  let f15 = null;
  for (const f of walkMessage(bytes, zone.start, zone.end)) {
    if (f.wireType !== 2) continue;
    if (f.field === 14) f14 = bytes.subarray(f.payloadStart, f.payloadEnd);
    else if (f.field === 15) f15 = bytes.subarray(f.payloadStart, f.payloadEnd);
    if (f14 && f15) break;
  }
  if (!f14 || !f15 || f14.length !== f15.length || f14.length % 4) return null;
  const n = f14.length / 4;
  const freqs = [];
  const gainsDb = [];
  const v14 = new DataView(f14.buffer, f14.byteOffset, f14.byteLength);
  const v15 = new DataView(f15.buffer, f15.byteOffset, f15.byteLength);
  for (let k = 0; k < n; k++) {
    freqs.push(v14.getFloat32(k * 4, true));
    gainsDb.push(v15.getFloat32(k * 4, true));
  }
  // Premier point parfois nul (0 Hz) : on l'ecarte.
  if (freqs.length && freqs[0] === 0) {
    freqs.shift();
    gainsDb.shift();
  }
  return { freqs, gainsDb };
}

function buildCurve(k, pair) {
  const match = KEY_RE.exec(k.key);
  return {
    key: k.key,
    name: match ? match.groups.name : k.key.split('::')[1],
    pos: match ? Number(match.groups.pos) : null,
    ch: match ? Number(match.groups.ch) : null,
    offset: k.keyOffset,
    freq: pair.freq,
    mag: pair.mag,
    points: pair.count,
    freqMonotonic: pair.freqMonotonic,
  };
}

/** Construit les courbes a partir des cles ; retourne {curves, skipped}. */
function buildCurves(bytes, view, keys) {
  const curves = [];
  const skipped = [];
  for (const k of keys) {
    const pair = parseCurvePair(bytes, view, k.dataOffset);
    if (pair) curves.push(buildCurve(k, pair));
    else skipped.push(k.key);
  }
  return { curves, skipped };
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Point d'entree : parse tout le conteneur.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{ meta: object, curves: Array }}
 */
export function parseLiveproject(input) {
  const { bytes, view } = createByteView(input);
  const keys = findMeasurementKeys(bytes, view);
  if (!keys.length) {
    throw new Error("Aucune cle 'measurement::' trouvee — format inattendu.");
  }

  const { curves, skipped } = buildCurves(bytes, view, keys);

  const channels = sortedUnique(curves.filter(c => c.ch != null).map(c => c.ch));
  const positions = sortedUnique(curves.filter(c => c.pos != null).map(c => c.pos));
  const nch = channels.length ? Math.max(...channels) + 1 : 0;

  const firstOff = keys[0].keyOffset;
  const labels = extractChannelLabels(bytes, view, firstOff, nch);
  const deviceMeta = extractDeviceMetadata(bytes, view, firstOff);
  const micCal = extractMicCal(bytes, view);

  const meta = {
    fileSize: bytes.length,
    ...deviceMeta,
    channelLabels: labels,
    channelCodes: labels ? labels.map(codeForLabel) : null,
    micCal,
    channelLevels: extractChannelLevels(bytes, view),
    positions,
    channels,
    nch,
    numCurves: curves.length,
    skippedKeys: skipped.length ? skipped : undefined,
  };
  return { meta, curves };
}
