/**
 * ogg-decoder.js — adaptateur de decodage Ogg Vorbis.
 *
 * Les enregistrements micro d'un `.liveproject` sont des fichiers Ogg Vorbis
 * complets (mono, 48 kHz). On les decode via `@wasm-audio-decoders/ogg-vorbis`
 * (libvorbis compile en WASM) : deterministe, fonctionne sous Node ET navigateur
 * (donc testable en golden-master), sortie float pleine precision.
 *
 * Le decodeur est charge par IMPORT DYNAMIQUE : le blob WASM ne pese jamais sur
 * le bundle critique de l'application (il n'est charge que lors d'un import
 * Dirac). L'instance est mise en cache et reutilisee pour les N enregistrements
 * d'un fichier.
 */

let decoderPromise = null;

async function getDecoder() {
  if (!decoderPromise) {
    decoderPromise = (async () => {
      const { OggVorbisDecoder } = await import('@wasm-audio-decoders/ogg-vorbis');
      const decoder = new OggVorbisDecoder();
      await decoder.ready;
      return decoder;
    })();
  }
  return decoderPromise;
}

/**
 * Decode un fichier Ogg Vorbis complet en un canal mono `Float64Array`.
 * En multicanal (ne devrait pas arriver pour Dirac), on moyenne les canaux.
 *
 * @param {Uint8Array} oggBytes
 * @returns {Promise<{samples: Float64Array, sampleRate: number}>}
 */
export async function decodeOggToMono48k(oggBytes) {
  const decoder = await getDecoder();
  const { channelData, samplesDecoded, sampleRate } = await decoder.decodeFile(oggBytes);
  const nCh = channelData.length;
  const out = new Float64Array(samplesDecoded);
  if (nCh === 1) {
    out.set(channelData[0].subarray(0, samplesDecoded));
  } else {
    for (let i = 0; i < samplesDecoded; i++) {
      let s = 0;
      for (let c = 0; c < nCh; c++) s += channelData[c][i];
      out[i] = s / nCh;
    }
  }
  return { samples: out, sampleRate };
}

/** Libere le decodeur WASM (a appeler apres traitement d'un fichier). */
export async function disposeDecoder() {
  if (!decoderPromise) return;
  const decoder = await decoderPromise;
  decoderPromise = null;
  if (typeof decoder.free === 'function') decoder.free();
}
