/**
 * analyze-key-frequencies.js
 * Analyser l'erreur aux fréquences clés de REW
 */

import { createNearestSampler, parseREWFile } from './test-config.js';

const measured = parseREWFile('./test/auto-eq/exemple1/FRavg.txt');
const target = parseREWFile('./test/auto-eq/exemple1/Target FRavg.txt');
const targetFn = createNearestSampler(target);
const measuredFn = createNearestSampler(measured);

// Fréquences clés où REW place ses filtres
const rewFilters = [
  { fc: 85, gain: -5.2 },
  { fc: 112, gain: +2.1 },
  { fc: 247, gain: -3.5 },
  { fc: 354, gain: +1.4 },
  { fc: 531, gain: +2.9 },
  { fc: 802, gain: -2.2 },
  { fc: 1318, gain: -1.7 },
  { fc: 2091, gain: +2.7 },
  { fc: 3230, gain: +0.9 },
];

console.log('Erreur (measured - target) aux fréquences des filtres REW:');
console.log('Freq (Hz)  |  Measured  |  Target  |  Erreur  | REW Gain');
console.log('='.repeat(60));

for (const filter of rewFilters) {
  const f = filter.fc;
  const m = measuredFn(f);
  const t = targetFn(f);
  const err = m - t;
  const sign = err >= 0 ? '+' : '';
  const rewSign = filter.gain >= 0 ? '+' : '';

  console.log(
    f.toString().padStart(8) +
      '  |  ' +
      m.toFixed(1).padStart(8) +
      '  |  ' +
      t.toFixed(1).padStart(6) +
      '  |  ' +
      sign +
      err.toFixed(1).padStart(4) +
      ' dB  |  ' +
      rewSign +
      filter.gain.toFixed(1) +
      ' dB',
  );
}

console.log('');
console.log('Interprétation:');
console.log("- Erreur positive (+) = au-dessus de la target → besoin d'un CUT (gain -)");
console.log(
  "- Erreur négative (-) = en-dessous de la target → besoin d'un BOOST (gain +)",
);
console.log('');
console.log('Vérifier si nos filtres couvrent toutes ces zones...');
