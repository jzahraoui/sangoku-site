/**
 * liveproject.worker.js — Web Worker d'import Dirac Live.
 *
 * Execute le pipeline lourd (`decodeLiveproject` : decodage Ogg + reconstruction
 * des IR) hors du thread principal. Le gros fichier (163 Mo / 13 positions)
 * mobilise des FFT ~2²³ et des tampons transitoires de plusieurs centaines de Mo
 * pendant ~1 min : le faire ici garde l'UI reactive et remonte l'avancement.
 *
 * Protocole :
 *   -> { buffer:ArrayBuffer, options?:object }
 *   <- { type:'progress', ...p }
 *   <- { type:'done', result }         (les Float32Array sont transferes)
 *   <- { type:'error', message }
 */

import { decodeLiveproject } from './liveproject-import.js';

self.onmessage = async event => {
  const { buffer, options = {} } = event.data;
  try {
    const result = await decodeLiveproject(buffer, {
      ...options,
      onProgress: p => self.postMessage({ type: 'progress', ...p }),
    });
    // Transfere les buffers des IR pour eviter une copie.
    const transfer = result.measurements.map(m => m.data.buffer);
    self.postMessage({ type: 'done', result }, transfer);
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  }
};
