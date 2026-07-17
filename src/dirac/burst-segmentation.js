/**
 * burst-segmentation.js — [MOTEUR] module.
 *
 * Detecte les bursts de sweep dans un enregistrement micro par enveloppe RMS
 * seuillee. Port de `segment_bursts` (extract_impulses.py).
 *
 * L'enveloppe est une moyenne glissante centree de `x²` (fenetre sr/100), puis
 * `20·log10`. Les regions au-dessus du seuil (−55 dB) separees de moins de
 * `mergeGap` sont fusionnees ; on ne garde que celles d'au moins `minDur`.
 */

/**
 * @param {Float64Array} x - enregistrement
 * @param {{sr?:number, threshDb?:number, minDur?:number, mergeGap?:number}} [opts]
 * @returns {Array<[number, number]>} liste de [debut, fin] en echantillons
 */
export function segmentBursts(x, { sr = 48000, threshDb = -55, minDur = 1.0, mergeGap = 0.3 } = {}) {
  const n = x.length;
  const win = Math.max(1, Math.floor(sr / 100));
  // Moyenne glissante centree de x² via somme prefixe.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i] * x[i];
  const half = win >> 1;
  const gapSamples = Math.floor(mergeGap * sr);

  const runs = [];
  let runStart = -1;
  let runLast = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, a + win);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    const db = 20 * Math.log10(Math.sqrt(mean) + 1e-12);
    if (db > threshDb) {
      if (runStart < 0) {
        runStart = i;
      } else if (i - runLast > gapSamples) {
        runs.push([runStart, runLast]);
        runStart = i;
      }
      runLast = i;
    }
  }
  if (runStart >= 0) runs.push([runStart, runLast]);
  return runs.filter(([a, b]) => (b - a) / sr >= minDur);
}
