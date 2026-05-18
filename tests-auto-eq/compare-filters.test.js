/**
 * compare-filters.js
 * Compare nos filtres à ceux de REW pour l'exemple 1
 */

import { AutoEQCalculator } from '../src/index.js';
import {
  parseREWFile,
  toFrequencyResponse,
  projectResponseToReferenceGrid,
  createConfig,
} from './test-config.js';

console.log('🔍 Comparaison des filtres - Exemple 1 (FR)\n');

// Charger les données
const measuredData = parseREWFile('./tests-auto-eq/exemple1/FRavg.txt');
const targetData = parseREWFile('./tests-auto-eq/exemple1/Target FRavg.txt');

const measuredResponse = toFrequencyResponse(measuredData);
const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);

// Calculer nos filtres
const config = createConfig();
const calculator = new AutoEQCalculator(config);

const result = await calculator.calculate(measuredResponse, targetResponse);

// Filtres REW
const rewFilters = [
  { freq: 85, gain: -5.2, q: 1.7 },
  { freq: 112, gain: 2.1, q: 3.5 },
  { freq: 247, gain: -3.5, q: 5.9 },
  { freq: 354, gain: 1.4, q: 5.6 },
  { freq: 531, gain: 2.9, q: 3.5 },
  { freq: 802, gain: -2.2, q: 5.9 },
  { freq: 1318, gain: -1.7, q: 1.15 },
  { freq: 2091, gain: 2.7, q: 2 },
  { freq: 3230, gain: 0.9, q: 3.5 },
];

console.log('='.repeat(60));
console.log('NOS FILTRES (' + result.filters.length + ' total)');
console.log('='.repeat(60));

// Debug: afficher le premier filtre pour voir la structure
console.log('Structure du premier filtre:', result.filters[0]);

result.filters.forEach(f => {
  const freq = f.frequency || f.freq || f.fc;
  const gain = f.gain;
  const q = f.q || f.Q;
  console.log(
    `${freq.toFixed(0).padStart(6)} Hz  ${gain >= 0 ? '+' : ''}${gain
      .toFixed(1)
      .padStart(5)} dB  Q=${q.toFixed(2)}`,
  );
});

console.log('');
console.log('='.repeat(60));
console.log('FILTRES REW (' + rewFilters.length + ' total)');
console.log('='.repeat(60));
rewFilters.forEach(f => {
  console.log(
    `${f.freq.toString().padStart(6)} Hz  ${f.gain >= 0 ? '+' : ''}${f.gain
      .toFixed(1)
      .padStart(5)} dB  Q=${f.q.toFixed(2)}`,
  );
});

console.log('');
console.log('='.repeat(60));
console.log('COMPARAISON PAR ZONE');
console.log('='.repeat(60));

const zones = [
  { name: '40-100 Hz (basses)', min: 40, max: 100 },
  { name: '100-250 Hz (bas médiums)', min: 100, max: 250 },
  { name: '250-500 Hz (médiums)', min: 250, max: 500 },
  { name: '500-1000 Hz (hauts médiums)', min: 500, max: 1000 },
  { name: '1000-2000 Hz (présence)', min: 1000, max: 2000 },
  { name: '2000-4000 Hz (brillance)', min: 2000, max: 4000 },
];

for (const zone of zones) {
  console.log(`\n📍 ${zone.name}:`);

  const ourZone = result.filters.filter(
    f => f.frequency >= zone.min && f.frequency < zone.max,
  );
  const rewZone = rewFilters.filter(f => f.freq >= zone.min && f.freq < zone.max);

  console.log('   Nous (' + ourZone.length + '):');
  if (ourZone.length === 0) {
    console.log('      (aucun filtre)');
  } else {
    ourZone.forEach(f => {
      console.log(
        `      ${f.frequency.toFixed(0)} Hz, ${f.gain >= 0 ? '+' : ''}${f.gain.toFixed(
          1,
        )} dB, Q=${f.q.toFixed(2)}`,
      );
    });
  }

  console.log('   REW (' + rewZone.length + '):');
  if (rewZone.length === 0) {
    console.log('      (aucun filtre)');
  } else {
    rewZone.forEach(f => {
      console.log(
        `      ${f.freq} Hz, ${f.gain >= 0 ? '+' : ''}${f.gain.toFixed(
          1,
        )} dB, Q=${f.q.toFixed(2)}`,
      );
    });
  }
}

console.log('\n');
console.log('='.repeat(60));
console.log('OBSERVATION CLÉ');
console.log('='.repeat(60));
console.log(
  'REW utilise ' +
    rewFilters.length +
    ' filtres, nous en utilisons ' +
    result.filters.length,
);
console.log('');
console.log('Points de différence majeurs:');
console.log("- REW a un filtre à 2091 Hz (+2.7 dB) que nous n'avons peut-être pas");
console.log('- REW utilise des Q plus variés (1.15 à 5.90)');
console.log('- Nos filtres peuvent créer des oscillations par interférence');
