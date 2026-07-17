/**
 * liveproject-import.js — orchestrateur d'import Dirac Live.
 *
 * Point d'entree bout-en-bout : d'un buffer `.liveproject` a une liste de
 * mesures `{ name, data:Float32Array }` pretes a etre injectees dans REW par le
 * meme chemin que l'ADY. Port de `main` (extract_impulses.py).
 *
 * Sans DOM ni Knockout : tourne a l'identique en Node (tests) et dans un Web
 * Worker (navigateur). Le decodage Ogg + la reconstruction sont les etapes
 * lourdes ; `onProgress` permet de suivre l'avancement cote UI.
 */

import { parseLiveproject } from './liveproject-container.js';
import { extractRecordings } from './protobuf.js';
import { decodeOggToMono48k, disposeDecoder } from './ogg-decoder.js';
import { processRecording, PRE_S } from './process-recording.js';
import { assignPositions } from './position-assignment.js';
import { codeFor, channelInfoForLabel } from './channel-codes.js';

/** Constante de calage dBFS -> SPL des en-tetes de reference REW (identique tous canaux). */
export const SPL_OFFSET_DB = 108;
const SAMPLE_RATE = 48000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Decode un `.liveproject` complet.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {{irLen?:number, sr?:number, onProgress?:(p:object)=>void}} [opts]
 * @returns {Promise<{
 *   sampleRate:number, splOffset:number, startTime:number,
 *   numPositions:number, source:object,
 *   measurements: Array<{name:string, data:Float32Array, position:number, channel:number, code:string, label:string, corr:number|null}>,
 *   positions: Array<object>
 * }>}
 */
/** Courbes de magnitude stockees indexees `${pos}:${ch}`. */
function buildStoredCurves(curves) {
  const stored = new Map();
  for (const c of curves) {
    if (c.pos != null && c.ch != null) stored.set(`${c.pos}:${c.ch}`, c.mag);
  }
  return stored;
}

/** Table des canaux (code + index AVR) pour synthetiser un jsonAvrData minimal. */
function buildChannelTable(meta, nch) {
  const table = [];
  for (let ch = 0; ch < nch; ch++) {
    const label = meta.channelLabels?.[ch] ?? `ch${ch}`;
    const info = channelInfoForLabel(label);
    table.push({ ch, code: info?.code ?? codeFor(meta, ch), channelIndex: info?.channelIndex ?? null, label });
  }
  return table;
}

/** Decode + reconstruit chaque enregistrement (sequentiel, decodeur libere a la fin). */
async function reconstructRecordings(recs, opts, progress) {
  const recsProc = [];
  try {
    for (let k = 0; k < recs.length; k++) {
      progress({ phase: 'decode', index: k, total: recs.length });
      const { samples } = await decodeOggToMono48k(recs[k].ogg);
      progress({ phase: 'reconstruct', index: k, total: recs.length });
      const rp = processRecording(samples, { ...opts, trims: recs[k].trims });
      if (rp) {
        rp.recIndex = k;
        rp.timestampMs = recs[k].timestampMs;
        recsProc.push(rp);
      }
    }
  } finally {
    await disposeDecoder();
  }
  return recsProc;
}

/** Construit les mesures + le resume par position a partir des reconstructions. */
function buildOutputs(recsProc, mapping, corrDetail, channelTable, nch) {
  const measurements = [];
  const positions = [];
  for (let i = 0; i < recsProc.length; i++) {
    const rp = recsProc[i];
    const pos = mapping[i];
    const cs = corrDetail.get(`${i}:${pos}`) || [];
    const channels = [];
    for (let ch = 0; ch < nch; ch++) {
      const { code, channelIndex, label } = channelTable[ch];
      const corr = ch < cs.length ? Number(cs[ch].toFixed(4)) : null;
      measurements.push({
        name: `${code}_P${pad2(pos + 1)}`,
        data: Float32Array.from(rp.irs[ch]),
        position: pos,
        channel: ch,
        code,
        channelIndex,
        label,
        corr,
      });
      channels.push({ ch, code, label, corr, playbackTrimDb: rp.trimsDb?.[ch] ?? 0 });
    }
    positions.push({
      pos,
      recIndex: rp.recIndex,
      timestampMs: rp.timestampMs,
      sweep: rp.sweep,
      clockDriftPpm: rp.clockDriftPpm,
      numBursts: rp.numBursts,
      channels,
    });
  }
  positions.sort((a, b) => a.pos - b.pos);
  return { measurements, positions };
}

export async function decodeLiveproject(buffer, { irLen = 1, sr = SAMPLE_RATE, onProgress = null } = {}) {
  const progress = p => {
    if (onProgress) onProgress(p);
  };

  progress({ phase: 'parse' });
  const { meta, curves } = parseLiveproject(buffer);
  const nch = meta.channels.length ? Math.max(...meta.channels) + 1 : 0;
  if (!nch) throw new Error('Aucun canal detecte dans le fichier Dirac.');

  const cal = meta.micCal;
  if (!cal) throw new Error('Calibration micro absente du fichier — extraction impossible.');
  const stored = buildStoredCurves(curves);
  const fgrid = curves[0]?.freq;

  const recs = extractRecordings(buffer);
  if (!recs.length) throw new Error("Pas d'enregistrement micro dans ce fichier.");

  const recsProc = await reconstructRecordings(recs, { nch, irLen, cal, sr }, progress);
  if (!recsProc.length) throw new Error('Aucun enregistrement exploitable (bursts insuffisants).');

  progress({ phase: 'assign' });
  const { mapping, corrDetail } = assignPositions(recsProc, stored, fgrid, nch);
  const channelTable = buildChannelTable(meta, nch);
  const { measurements, positions } = buildOutputs(recsProc, mapping, corrDetail, channelTable, nch);

  return {
    sampleRate: sr,
    splOffset: SPL_OFFSET_DB,
    startTime: -PRE_S,
    numPositions: recsProc.length,
    source: {
      diracVersion: meta.diracVersion,
      vendor: meta.deviceVendor,
      model: meta.deviceModel,
      arrangement: meta.arrangement,
    },
    channelTable,
    measurements,
    positions,
  };
}
