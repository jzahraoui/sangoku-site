/**
 * test-rew-filters.js - Test avec les filtres REW exacts
 * Pour vérifier que notre implémentation produit la même courbe
 */

import { BiquadFilter } from '../../../src/dsp/BiquadFilter.js';
import { parseREWFile } from '../test-config.js';

// Filtres REW extraits du fichier corrigé
const rewFilters = [
  { fc: 46.45, Q: 1.226, gain: -8.3 },
  { fc: 70, Q: 2.695, gain: 6 },
  { fc: 144.5, Q: 1, gain: -7.6 },
  { fc: 190.5, Q: 3.14, gain: 6 },
  { fc: 265, Q: 2.237, gain: -5.7 },
  { fc: 309, Q: 1.505, gain: 6 },
  { fc: 572, Q: 3.254, gain: -2.5 },
  { fc: 713, Q: 4.921, gain: -2.3 },
  { fc: 800, Q: 4.999, gain: -4.9 },
  { fc: 1204, Q: 4.96, gain: -2.8 },
  { fc: 1372, Q: 4.715, gain: -2.7 },
  { fc: 1716, Q: 7.45, gain: 2.1 },
  { fc: 2144, Q: 3.326, gain: -5.1 },
  { fc: 2283, Q: 2.42, gain: 3.4 },
];

console.log('🔍 Test avec les filtres REW exacts\n');
console.log('Filtres REW:');
rewFilters.forEach((f, i) => {
  console.log(
    `  ${i + 1}. fc=${f.fc.toFixed(1).padStart(7)} Hz, Q=${f.Q.toFixed(3)}, gain=${
      f.gain >= 0 ? '+' : ''
    }${f.gain.toFixed(1)} dB`,
  );
});

// Charger les données
const measure = parseREWFile('./test/auto-eq/exemple1/FRavg.txt');
const target = parseREWFile('./test/auto-eq/exemple1/Target FRavg.txt');
const rewCorrected = parseREWFile('./test/auto-eq/exemple1/EQ FRavg.txt');

console.log(`\n📊 Données chargées:`);
console.log(`   Mesure: ${measure.length} points`);
console.log(`   Target: ${target.length} points`);
console.log(`   REW corrigé: ${rewCorrected.length} points`);

// Créer les filtres biquad
const filters = rewFilters.map(f => {
  const filter = new BiquadFilter(48000);
  filter.setPeaking(f.fc, f.Q, f.gain);
  return filter;
});

// Appliquer les filtres à la mesure
const corrected = measure.map(point => {
  let totalGain = 0;
  for (const filter of filters) {
    totalGain += filter.getMagnitudeDB(point.freq);
  }
  return { freq: point.freq, spl: point.spl + totalGain };
});

// Comparer avec le fichier REW
console.log(`\n📈 Comparaison Notre calcul vs REW (quelques fréquences):`);
console.log('   Freq (Hz) | Notre SPL | REW SPL | Diff');
console.log('   ' + '-'.repeat(45));

const testFreqs = [30, 40, 50, 70, 100, 150, 200, 500, 1000, 2000, 5000, 10000];
for (const testFreq of testFreqs) {
  // Trouver le point le plus proche
  const ourPoint = corrected.find(p => p.freq >= testFreq) || corrected.at(-1);
  const rewPoint = rewCorrected.find(p => p.freq >= testFreq) || rewCorrected.at(-1);

  const diff = ourPoint.spl - rewPoint.spl;
  console.log(
    `   ${testFreq.toString().padStart(5)} Hz | ${ourPoint.spl
      .toFixed(1)
      .padStart(8)} | ${rewPoint.spl.toFixed(1).padStart(7)} | ${
      diff >= 0 ? '+' : ''
    }${diff.toFixed(2)} dB`,
  );
}

// Calculer RMS error entre notre calcul et REW
let sumSqDiff = 0;
let count = 0;
for (let i = 0; i < corrected.length && i < rewCorrected.length; i++) {
  const diff = corrected[i].spl - rewCorrected[i].spl;
  sumSqDiff += diff * diff;
  count++;
}
const rmsError = Math.sqrt(sumSqDiff / count);
console.log(`\n📊 RMS Error entre notre calcul et REW: ${rmsError.toFixed(3)} dB`);

if (rmsError < 0.5) {
  console.log('✅ Notre implémentation des filtres est correcte!');
} else {
  console.log("⚠️  Différence significative - vérifier l'implémentation des filtres");
}
