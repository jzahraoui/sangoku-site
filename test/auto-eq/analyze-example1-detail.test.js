/**
 * Analyse détaillée de l'Exemple 1 (FR) - Pourquoi REW est meilleur sur 40-3000 Hz
 */

import { AutoEQCalculator } from '../../src/index.js';
import {
  createConfig,
  createNearestSampler,
  parseREWFile,
  projectResponseToReferenceGrid,
  toFrequencyResponse,
} from './test-config.js';

console.log('🔍 Analyse détaillée Exemple 1 (FR) - Plage 40-3000 Hz\n');

// Charger les données
const measuredData = parseREWFile('./test/auto-eq/exemple1/FRavg.txt');
const targetData = parseREWFile('./test/auto-eq/exemple1/Target FRavg.txt');
const rewEQData = parseREWFile('./test/auto-eq/exemple1/EQ FRavg.txt');

const measuredResponse = toFrequencyResponse(measuredData);
const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
const measuredSPL = createNearestSampler(measuredResponse);
const targetCurve = createNearestSampler(targetResponse);

// Calculer notre EQ
const calculator = new AutoEQCalculator(createConfig());

await calculator.calculate(measuredResponse, targetResponse);

// Calculer la réponse équalisée
const ourEQData = measuredData.map(point => {
  const filterResponse = calculator.filterSet.getCumulativeComplexResponse(point.freq);
  return { freq: point.freq, spl: point.spl + filterResponse.magnitudeDB };
});

// Analyser les erreurs dans la plage 40-3000 Hz
console.log('📊 Comparaison des erreurs (40-3000 Hz):');
console.log('─'.repeat(80));

const freqPoints = [
  40, 50, 60, 80, 100, 150, 200, 300, 400, 500, 700, 1000, 1500, 2000, 2500, 3000,
];

console.log(
  'Freq (Hz) | Mesure | Target | Err Init | REW EQ | Err REW | Notre EQ | Err Nous',
);
console.log('─'.repeat(80));

function findNearestPoint(data, freq) {
  return data.reduce(
    (best, point) =>
      Math.abs(point.freq - freq) < Math.abs(best.freq - freq) ? point : best,
    data[0],
  );
}

for (const freq of freqPoints) {
  const measured = measuredSPL(freq);
  const target = targetCurve(freq);
  const errorInit = measured - target;

  // Trouver le point le plus proche dans rewEQData
  const rewPoint = findNearestPoint(rewEQData, freq);
  const rewEQ = rewPoint.spl;
  const errorREW = rewEQ - target;

  // Trouver notre point
  const ourPoint = findNearestPoint(ourEQData, freq);
  const ourEQ = ourPoint.spl;
  const errorOurs = ourEQ - target;

  console.log(
    `${String(freq).padStart(8)} | ` +
      `${measured.toFixed(1).padStart(6)} | ` +
      `${target.toFixed(1).padStart(6)} | ` +
      `${(errorInit >= 0 ? '+' : '') + errorInit.toFixed(1).padStart(6)} | ` +
      `${rewEQ.toFixed(1).padStart(6)} | ` +
      `${(errorREW >= 0 ? '+' : '') + errorREW.toFixed(1).padStart(6)} | ` +
      `${ourEQ.toFixed(1).padStart(8)} | ` +
      `${(errorOurs >= 0 ? '+' : '') + errorOurs.toFixed(1).padStart(6)}`,
  );
}

console.log('─'.repeat(80));

// Calculer les statistiques
const range40_3000 = measuredData.filter(d => d.freq >= 40 && d.freq <= 3000);

let sumSqREW = 0,
  sumSqOurs = 0,
  countREW_over = 0,
  countOurs_over = 0;

for (const point of range40_3000) {
  const target = targetCurve(point.freq);

  const rewPoint = findNearestPoint(rewEQData, point.freq);
  const errorREW = rewPoint.spl - target;
  sumSqREW += errorREW * errorREW;
  if (errorREW > 0.5) countREW_over++;

  const ourPoint = findNearestPoint(ourEQData, point.freq);
  const errorOurs = ourPoint.spl - target;
  sumSqOurs += errorOurs * errorOurs;
  if (errorOurs > 0.5) countOurs_over++;
}

const rmsREW = Math.sqrt(sumSqREW / range40_3000.length);
const rmsOurs = Math.sqrt(sumSqOurs / range40_3000.length);

console.log('\n📈 Statistiques 40-3000 Hz:');
console.log(`   REW:  RMS = ${rmsREW.toFixed(3)} dB, Overshoots = ${countREW_over}`);
console.log(`   Nous: RMS = ${rmsOurs.toFixed(3)} dB, Overshoots = ${countOurs_over}`);
console.log(`   Différence: ${(rmsOurs - rmsREW).toFixed(3)} dB`);

// Analyser où sont nos overshoots
console.log('\n🔴 Nos overshoots les plus importants (40-3000 Hz):');
const overshoots = ourEQData
  .filter(d => d.freq >= 40 && d.freq <= 3000)
  .map(d => ({ freq: d.freq, error: d.spl - targetCurve(d.freq) }))
  .filter(d => d.error > 0.5)
  .sort((a, b) => b.error - a.error)
  .slice(0, 10);

for (const o of overshoots) {
  console.log(
    `   ${o.freq.toFixed(0).padStart(6)} Hz: +${o.error.toFixed(
      2,
    )} dB au-dessus de la target`,
  );
}

// Afficher nos filtres
console.log('\n🔧 NOS FILTRES:');
const filters = calculator.filterSet.filters.filter(f => f.gain !== 0);
filters.forEach((f, i) => {
  const sign = f.gain >= 0 ? '+' : '';
  console.log(
    `   Filtre ${(i + 1).toString().padStart(2)}: ${f.fc
      .toFixed(0)
      .padStart(5)} Hz, ${sign}${f.gain.toFixed(1).padStart(5)} dB, Q=${f.Q.toFixed(2)}`,
  );
});

// Filtres REW pour comparaison
console.log('\n🔧 FILTRES REW (référence):');
const rewFilters = [
  { frequency: 50, gain: -7.6, Q: 3.36 },
  { frequency: 70, gain: 6, Q: 2.695 },
  { frequency: 144, gain: -6.3, Q: 2.765 },
  { frequency: 714, gain: -4.8, Q: 3.24 },
  { frequency: 2011, gain: -1.7, Q: 1.52 },
  { frequency: 4002, gain: -1.9, Q: 3.835 },
  { frequency: 6007, gain: -3, Q: 3.325 },
  { frequency: 8016, gain: 2.9, Q: 2.21 },
  { frequency: 10200, gain: -3.7, Q: 0.63 },
];
rewFilters.forEach((f, i) => {
  const sign = f.gain >= 0 ? '+' : '';
  console.log(
    `   Filtre ${(i + 1).toString().padStart(2)}: ${f.frequency
      .toFixed(0)
      .padStart(5)} Hz, ${sign}${f.gain.toFixed(1).padStart(5)} dB, Q=${f.Q.toFixed(2)}`,
  );
});
