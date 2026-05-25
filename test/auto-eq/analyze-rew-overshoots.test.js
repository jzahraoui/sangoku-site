/**
 * analyze-rew-overshoots.js - Analyser les overshoots dans la courbe REW
 */

import { createNearestSampler, parseREWFile } from './test-config.js';

const rewCorrected = parseREWFile('./test/auto-eq/exemple1/FRavg.txt');
const target = parseREWFile('./test/auto-eq/exemple1/Target FRavg.txt');
const targetSampler = createNearestSampler(target);

// Analyser les overshoots dans la courbe REW
let overshoots = 0;
let maxOvershoot = 0;
for (const point of rewCorrected) {
  if (point.freq < 20 || point.freq > 10000) continue;
  const targetSPL = targetSampler(point.freq);
  const residual = point.spl - targetSPL;
  if (residual > 0.5) {
    overshoots++;
    maxOvershoot = Math.max(maxOvershoot, residual);
  }
}
console.log('Analyse de la courbe REW équalisée:');
console.log(`  Overshoots (>0.5 dB): ${overshoots}`);
console.log(`  Max overshoot: +${maxOvershoot.toFixed(2)} dB`);

// Regarder les fréquences avec overshoot
console.log('');
console.log('Détails des overshoots REW (30-80 Hz):');
for (const point of rewCorrected) {
  if (point.freq < 30 || point.freq > 80) continue;
  const targetSPL = targetSampler(point.freq);
  const residual = point.spl - targetSPL;
  if (Math.abs(residual) > 0.3) {
    const sign = residual >= 0 ? '+' : '';
    console.log(
      `  ${point.freq.toFixed(1).padStart(5)} Hz: corrigé=${point.spl.toFixed(
        1,
      )}, target=${targetSPL.toFixed(1)}, Δ=${sign}${residual.toFixed(2)} dB`,
    );
  }
}
