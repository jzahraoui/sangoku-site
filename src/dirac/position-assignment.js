/**
 * position-assignment.js — [MOTEUR] module.
 *
 * Apparie chaque enregistrement (ordre chronologique) a une position stockee en
 * maximisant la correlation moyenne des magnitudes sur les canaux. Port de
 * `assign_positions` / `sub_band` / `np.corrcoef` (extract_impulses.py).
 *
 * Les IR reconstruites sont deja corrigees micro, comme les courbes Dirac
 * stockees ⇒ la correlation est directe. L'assignation optimale est resolue par
 * l'algorithme hongrois (`linearSumAssignment`).
 */

import { linearSumAssignment } from '../dsp/hungarian.js';
import { smoothMagDb } from './mic-cal.js';

/** Coefficient de Pearson sur les indices ou les deux vecteurs sont finis. */
export function pearson(a, b) {
  let n = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      sa += a[i];
      sb += b[i];
      n++;
    }
  }
  if (n < 2) return 0;
  const ma = sa / n;
  const mb = sb / n;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      const da = a[i] - ma;
      const db = b[i] - mb;
      saa += da * da;
      sbb += db * db;
      sab += da * db;
    }
  }
  const denom = Math.sqrt(saa * sbb);
  return denom === 0 ? 0 : sab / denom;
}

/** Vrai si la courbe stockee est un subwoofer (effondrement > 2 kHz). */
export function subBand(mag, fgrid) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < fgrid.length; i++) {
    if (fgrid[i] > 2000) {
      sum += mag[i];
      count++;
    }
  }
  return count > 0 && sum / count < -60;
}

/**
 * @param {Array<{irs:Float64Array[]}>} recsProc - enregistrements traites
 * @param {Map<string, Float64Array>} stored - cle `${pos}:${ch}` -> magnitude stockee
 * @param {Float64Array} fgrid - grille de frequence des courbes stockees
 * @param {number} nch
 * @returns {{mapping:number[], score:number[][], corrDetail:Map<string, number[]>}}
 *   `mapping[i]` = position assignee a l'enregistrement i.
 */
export function assignPositions(recsProc, stored, fgrid, nch) {
  const positions = [...new Set([...stored.keys()].map(k => Number(k.split(':')[0])))].sort((a, b) => a - b);
  const nrec = recsProc.length;

  // Magnitudes derivees des IR reconstruites.
  const derived = recsProc.map(rp => {
    const perCh = [];
    for (let ch = 0; ch < nch; ch++) perCh.push(smoothMagDb(rp.irs[ch], fgrid));
    return perCh;
  });

  const bandFull = fgrid.map(f => f > 100 && f < 15000);
  const bandLow = fgrid.map(f => f > 15 && f < 150);

  // Correlation d'un canal entre magnitude derivee et stockee, sur la bande utile.
  const channelCorr = (mine, mg, band) => {
    const selMine = new Float64Array(fgrid.length);
    const selStored = new Float64Array(fgrid.length);
    for (let k = 0; k < fgrid.length; k++) {
      const keep = band[k] && Number.isFinite(mine[k]);
      selMine[k] = keep ? mine[k] : NaN;
      selStored[k] = keep ? mg[k] : NaN;
    }
    return pearson(selMine, selStored);
  };

  // Correlations par canal d'un enregistrement `i` contre la position stockee `p`.
  const positionCorrs = (i, p) => {
    const cs = [];
    for (let ch = 0; ch < nch; ch++) {
      const mg = stored.get(`${p}:${ch}`);
      if (!mg) continue;
      const band = subBand(mg, fgrid) ? bandLow : bandFull;
      cs.push(channelCorr(derived[i][ch], mg, band));
    }
    return cs;
  };

  const score = Array.from({ length: nrec }, () => new Array(positions.length).fill(0));
  const corrDetail = new Map();
  for (let i = 0; i < nrec; i++) {
    for (let j = 0; j < positions.length; j++) {
      const p = positions[j];
      const cs = positionCorrs(i, p);
      score[i][j] = cs.length ? cs.reduce((s, v) => s + v, 0) / cs.length : 0;
      corrDetail.set(`${i}:${p}`, cs);
    }
  }

  const cost = score.map(row => row.map(v => -v));
  const { assignment } = linearSumAssignment(cost);
  const mapping = assignment.map(j => (j >= 0 ? positions[j] : -1));
  return { mapping, score, corrDetail };
}
