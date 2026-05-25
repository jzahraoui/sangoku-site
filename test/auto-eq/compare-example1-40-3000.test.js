/**
 * Comparaison Exemple 1 (FR) sur 40-3000 Hz uniquement
 */

import { AutoEQCalculator } from '../../src/index.js';
import {
  loadTestExample,
  createConfig,
  parseREWFile,
  calculateRMSError,
} from './test-config.js';

// Helpers spécifiques au test
function countOvershoots(
  data,
  targetFn,
  startFreq = 20,
  endFreq = 20000,
  threshold = 0.5,
) {
  const inRange = data.filter(d => d.freq >= startFreq && d.freq <= endFreq);
  return inRange.filter(d => d.spl - targetFn(d.freq) > threshold).length;
}

console.log('🎵 Comparaison Exemple 1 (FR) - Plage 40-3000 Hz\n');
console.log('='.repeat(80));

// Charger les données
const { measuredData, targetData, measuredResponse, targetResponse, targetSampler } =
  loadTestExample('exemple1');
const rewEQData = parseREWFile('./test/auto-eq/exemple1/EQ FRavg.txt');

console.log(`📈 Mesure: ${measuredData.length} points`);
console.log(`🎯 Target: ${targetData.length} points`);

// Plages de fréquences à comparer
const ranges = [
  { name: 'Plage complète (20-20000 Hz)', start: 20, end: 20000 },
  { name: 'Plage médiums (40-3000 Hz)', start: 40, end: 3000 },
];

// Calculer l'erreur REW pour chaque plage
console.log('\n📊 Erreur REW:');
for (const range of ranges) {
  const rms = calculateRMSError(rewEQData, targetSampler, range.start, range.end);
  const overshoots = countOvershoots(rewEQData, targetSampler, range.start, range.end);
  console.log(`   ${range.name}: ${rms.toFixed(2)} dB RMS, ${overshoots} overshoots`);
}

// Calculer notre EQ
console.log('\n⚙️ Calcul Auto-EQ...');
const calculator = new AutoEQCalculator(createConfig());

const startTime = Date.now();
await calculator.calculate(measuredResponse, targetResponse);
const elapsed = Date.now() - startTime;

// Calculer la réponse équalisée
const equalizedData = measuredData.map(point => {
  const filterResponse = calculator.filterSet.getCumulativeComplexResponse(point.freq);
  return {
    freq: point.freq,
    spl: point.spl + filterResponse.magnitudeDB,
  };
});

const activeFilters = calculator.filterSet.getActiveFilters();
console.log(`✅ Terminé en ${elapsed}ms - ${activeFilters.length} filtres actifs`);

// Comparer pour chaque plage
console.log('\n📊 Comparaison:');
console.log(
  '┌─────────────────────────────────────┬───────────┬───────────┬───────────┬──────────┐',
);
console.log(
  '│ Plage                               │ REW       │ Nous      │ Δ RMS     │ Verdict  │',
);
console.log(
  '├─────────────────────────────────────┼───────────┼───────────┼───────────┼──────────┤',
);

for (const range of ranges) {
  const ourRMS = calculateRMSError(equalizedData, targetSampler, range.start, range.end);
  const rewRMS = calculateRMSError(rewEQData, targetSampler, range.start, range.end);
  const diff = ourRMS - rewRMS;
  let verdict = '= Égal';
  if (diff < 0) {
    verdict = '✅ Nous';
  } else if (diff > 0) {
    verdict = '⚠️ REW';
  }

  console.log(
    `│ ${range.name.padEnd(35)} │ ${rewRMS.toFixed(2).padStart(7)} dB │ ${ourRMS
      .toFixed(2)
      .padStart(7)} dB │ ${
      (diff >= 0 ? '+' : '') + diff.toFixed(2).padStart(5)
    } dB │ ${verdict.padEnd(8)} │`,
  );
}

console.log(
  '└─────────────────────────────────────┴───────────┴───────────┴───────────┴──────────┘',
);

// Détail des overshoots
console.log('\n📈 Overshoots:');
console.log('┌─────────────────────────────────────┬───────────┬───────────┐');
console.log('│ Plage                               │ REW       │ Nous      │');
console.log('├─────────────────────────────────────┼───────────┼───────────┤');

for (const range of ranges) {
  const rewOvershoots = countOvershoots(rewEQData, targetSampler, range.start, range.end);
  const ourOvershoots = countOvershoots(
    equalizedData,
    targetSampler,
    range.start,
    range.end,
  );

  console.log(
    `│ ${range.name.padEnd(35)} │ ${String(rewOvershoots).padStart(9)} │ ${String(
      ourOvershoots,
    ).padStart(9)} │`,
  );
}

console.log('└─────────────────────────────────────┴───────────┴───────────┘');

// Afficher les filtres
console.log('\n🔧 Filtres générés:');
activeFilters.forEach((f, i) => {
  console.log(
    `   ${(i + 1).toString().padStart(2)}. ${f.fc.toFixed(0).padStart(5)} Hz  ${
      f.gain > 0 ? '+' : ''
    }${f.gain.toFixed(1).padStart(4)} dB  Q=${f.Q.toFixed(2)}`,
  );
});
