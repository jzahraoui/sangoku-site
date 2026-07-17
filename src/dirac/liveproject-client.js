/**
 * liveproject-client.js — cote thread principal.
 *
 * Lance la reconstruction Dirac dans un Web Worker (module) et retourne une
 * promesse resolue avec le resultat de `decodeLiveproject`. Si les Workers ne
 * sont pas disponibles (environnement degrade), replie sur une execution
 * inline (import dynamique) — l'UI se fige alors le temps du calcul.
 */

/**
 * @param {ArrayBuffer} buffer - contenu binaire du fichier `.liveproject`
 * @param {{irLen?:number, onProgress?:(p:object)=>void}} [opts]
 * @returns {Promise<object>} resultat de decodeLiveproject
 */
export function decodeLiveprojectViaWorker(buffer, { irLen = 1, onProgress = null } = {}) {
  if (typeof Worker === 'undefined') {
    return decodeInline(buffer, { irLen, onProgress });
  }
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./liveproject.worker.js', import.meta.url), { type: 'module' });
    } catch {
      // Repli inline si la creation du worker echoue.
      decodeInline(buffer, { irLen, onProgress }).then(resolve, reject);
      return;
    }
    worker.onmessage = event => {
      const msg = event.data;
      if (msg.type === 'progress') {
        onProgress?.(msg);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(msg.result);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = event => {
      worker.terminate();
      reject(new Error(event.message || 'Dirac worker error'));
    };
    // Transfere le buffer (detache cote main thread — on ne le reutilise pas).
    worker.postMessage({ buffer, options: { irLen } }, [buffer]);
  });
}

async function decodeInline(buffer, { irLen, onProgress }) {
  const { decodeLiveproject } = await import('./liveproject-import.js');
  return decodeLiveproject(buffer, { irLen, onProgress });
}
