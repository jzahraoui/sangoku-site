/**
 * protobuf.js — [MOTEUR] module.
 *
 * Lecteur minimal du blob Protocol Buffers imbrique dans un `.liveproject`
 * (little-endian / varint). On ne reconstruit pas le schema : on parcourt les
 * champs par numero/wire-type et on extrait ce qui nous interesse.
 *
 * Port de `_varint`, `_walk`, `find_proto_zone`, `extract_recordings`
 * (extract_impulses.py) et de la localisation de zone de `extract_mic_cal`
 * (extract_liveproject.py).
 *
 * La zone protobuf suit l'en-tete du fichier : un octet `0x01`, un `u32 BE`
 * (longueur), puis le message dont le champ #1 est un UUID ASCII (`0a 24` + uuid).
 */

import { createByteView, u32be } from './binary-reader.js';

/**
 * Lit un varint a partir de `i`.
 * @returns {{ value: number, next: number }}
 */
export function readVarint(bytes, i) {
  let value = 0;
  let shift = 0;
  let j = i;
  for (;;) {
    const x = bytes[j++];
    value += (x & 0x7f) * 2 ** shift;
    if (!(x & 0x80)) return { value, next: j };
    shift += 7;
  }
}

/**
 * Lit un champ (tag + valeur/longueur) a partir de `i`.
 * @returns {{field, wireType, value, payloadStart, payloadEnd, next}}
 */
function readField(bytes, i) {
  const tag = readVarint(bytes, i);
  const field = Math.floor(tag.value / 8);
  const wireType = tag.value & 7;
  const j = tag.next;
  if (wireType === 0) {
    const v = readVarint(bytes, j);
    return { field, wireType, value: v.value, payloadStart: null, payloadEnd: null, next: v.next };
  }
  if (wireType === 1) {
    return { field, wireType, value: null, payloadStart: j, payloadEnd: j + 8, next: j + 8 };
  }
  if (wireType === 5) {
    return { field, wireType, value: null, payloadStart: j, payloadEnd: j + 4, next: j + 4 };
  }
  if (wireType === 2) {
    const len = readVarint(bytes, j);
    const ps = len.next;
    return { field, wireType, value: len.value, payloadStart: ps, payloadEnd: ps + len.value, next: ps + len.value };
  }
  throw new Error(`wire type ${wireType} inattendu a l'offset ${i}`);
}

/**
 * Generateur des champs d'un message entre [start, end).
 * Yield {field, wireType, value, payloadStart, payloadEnd} ou :
 *   - wireType 0 (varint) : `value` = entier, payload* = null ;
 *   - wireType 1 (64 bits) : payload* delimite 8 octets, value = null ;
 *   - wireType 5 (32 bits) : payload* delimite 4 octets, value = null ;
 *   - wireType 2 (len-delimited) : value = longueur, payload* delimite les octets.
 */
export function* walkMessage(bytes, start, end) {
  let i = start;
  while (i < end) {
    const f = readField(bytes, i);
    yield f;
    i = f.next;
  }
}

/** Vrai si `bytes[i..]` commence par `0a 24` + [0-9a-f]{8}-[0-9a-f]{4}- (repere UUID). */
function isProtoZoneAnchor(bytes, i) {
  if (bytes[i] !== 0x0a || bytes[i + 1] !== 0x24) return false;
  const isHex = c => (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66);
  let p = i + 2;
  for (let k = 0; k < 8; k++) if (!isHex(bytes[p++])) return false;
  if (bytes[p++] !== 0x2d) return false;
  for (let k = 0; k < 4; k++) if (!isHex(bytes[p++])) return false;
  return bytes[p] === 0x2d;
}

/**
 * Localise la zone protobuf : repere `0a 24 <uuid>` dans les 64 premiers Ko,
 * la longueur etant le `u32 BE` juste avant l'ancre.
 * @returns {{ start: number, end: number } | null}
 */
export function findProtoZone(bytes, view) {
  const limit = Math.min(bytes.length, 65536);
  for (let i = 0; i + 20 < limit; i++) {
    if (isProtoZoneAnchor(bytes, i)) {
      const length = u32be(view, i - 4);
      return { start: i, end: i + length };
    }
  }
  return null;
}

/** Vrai si `ogg` commence par le magic OggS (0x4f 0x67 0x67 0x53). */
function isOgg(ogg) {
  return !!ogg && ogg[0] === 0x4f && ogg[1] === 0x67 && ogg[2] === 0x67 && ogg[3] === 0x53;
}

/** Parse un message #50 (un enregistrement) en {timestampMs, trims, ogg}. */
function parseRecordingMessage(bytes, view, start, end) {
  const rec = { timestampMs: null, trims: null, ogg: null };
  for (const g of walkMessage(bytes, start, end)) {
    if (g.field === 3 && g.wireType === 0) {
      rec.timestampMs = g.value;
    } else if (g.field === 9 && g.wireType === 2 && (g.payloadEnd - g.payloadStart) % 4 === 0) {
      const n = (g.payloadEnd - g.payloadStart) / 4;
      rec.trims = new Float32Array(n);
      for (let k = 0; k < n; k++) rec.trims[k] = view.getFloat32(g.payloadStart + k * 4, true);
    } else if (g.field === 13 && g.wireType === 2) {
      rec.ogg = bytes.subarray(g.payloadStart, g.payloadEnd);
    }
  }
  return rec;
}

/**
 * Extrait les enregistrements micro (messages #50) en ordre chronologique.
 * Chaque enregistrement : { timestampMs, trims:Float32Array|null, ogg:Uint8Array|null }.
 *   - #3  varint : timestamp epoch en millisecondes ;
 *   - #9  bytes  : 15 float32 LE = trim de lecture par canal (dB) ;
 *   - #13 bytes  : fichier Ogg Vorbis complet (magic OggS).
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Array<{timestampMs:number|null, trims:Float32Array|null, ogg:Uint8Array|null}>}
 */
export function extractRecordings(input) {
  const { bytes, view } = createByteView(input);
  const zone = findProtoZone(bytes, view);
  if (!zone) {
    throw new Error("Zone protobuf introuvable (pas d'enregistrements dans ce fichier ?)");
  }
  const recs = [];
  for (const f of walkMessage(bytes, zone.start, zone.end)) {
    if (f.field !== 50 || f.wireType !== 2) continue;
    const rec = parseRecordingMessage(bytes, view, f.payloadStart, f.payloadEnd);
    if (isOgg(rec.ogg)) recs.push(rec);
  }
  recs.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
  return recs;
}
