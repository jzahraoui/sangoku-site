/**
 * Affiche les filtres générés et analyse l'erreur autour de 100 Hz
 */

import { AutoEQCalculator } from '../src/index.js';
import {
  createConfig,
  createNearestSampler,
  parseREWFile,
  projectResponseToReferenceGrid,
  toFrequencyResponse,
} from './test-config.js';

// Charger les données
const measurementData = parseREWFile('./tests-auto-eq/exemple1/FRavg.txt');
const targetData = parseREWFile('./tests-auto-eq/exemple1/Target FRavg.txt');

const measuredResponse = toFrequencyResponse(measurementData);
const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
const measuredSPL = createNearestSampler(measuredResponse);
const targetCurve = createNearestSampler(targetResponse);

// Calculer les filtres
const calculator = new AutoEQCalculator(createConfig());

const result = await calculator.calculate(measuredResponse, targetResponse);

console.log('=== NOS FILTRES ===');
result.filters.forEach((f, i) => {
  const sign = f.gain >= 0 ? '+' : '';
  console.log(
    `Filtre ${i + 1}: ${f.fc.toFixed(0)} Hz, ${sign}${f.gain.toFixed(
      1,
    )} dB, Q=${f.Q.toFixed(2)}`,
  );
});

// Comparer avec REW
console.log('\n=== FILTRES REW ===');
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
    `Filtre ${i + 1}: ${f.frequency.toFixed(0)} Hz, ${sign}${f.gain.toFixed(
      1,
    )} dB, Q=${f.Q.toFixed(2)}`,
  );
});

// Analyser l'effet à chaque fréquence autour de 100 Hz
console.log('\n=== EFFET DES FILTRES AUTOUR DE 100 Hz ===');

function computeFilterEffect(filters, freq) {
  let totalEffect = 0;
  for (const filter of filters) {
    // Supporter les deux formats: fc (notre API) et frequency (REW)
    const fc = filter.fc || filter.frequency;
    const { gain, Q } = filter;
    const ratio = freq / fc;
    const response = gain / Math.sqrt(1 + Math.pow(Q * (ratio - 1 / ratio), 2));
    totalEffect += response;
  }
  return totalEffect;
}

const freqsToCheck = [40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 200];
console.log('Freq (Hz) | Notre effet | REW effet | Diff');
console.log('----------|-------------|-----------|------');
for (const f of freqsToCheck) {
  const ourEffect = computeFilterEffect(result.filters, f);
  const rewEffect = computeFilterEffect(rewFilters, f);
  const diff = ourEffect - rewEffect;
  console.log(
    `${f.toString().padStart(9)} | ${ourEffect >= 0 ? '+' : ''}${ourEffect
      .toFixed(2)
      .padStart(10)} | ${rewEffect >= 0 ? '+' : ''}${rewEffect
      .toFixed(2)
      .padStart(8)} | ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`,
  );
}

// Calculer l'erreur résiduelle
console.log('\n=== ERREUR RESIDUELLE 40-150 Hz ===');
console.log('Freq (Hz) | Mesure | Target | Initial | +REW | +Nous | Err REW | Err Nous');
console.log('----------|--------|--------|---------|------|-------|---------|----------');

for (const freq of [40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]) {
  // Échantillonner les réponses brutes au plus proche voisin
  const measure = measuredSPL(freq);
  const target = targetCurve(freq);
  const initial = measure - target;

  const ourEffect = computeFilterEffect(result.filters, freq);
  const rewEffect = computeFilterEffect(rewFilters, freq);

  const afterOur = measure + ourEffect;
  const afterRew = measure + rewEffect;

  const errOur = afterOur - target;
  const errRew = afterRew - target;

  console.log(
    `${freq.toString().padStart(9)} | ${measure.toFixed(1).padStart(6)} | ${target
      .toFixed(1)
      .padStart(6)} | ${initial >= 0 ? '+' : ''}${initial.toFixed(1).padStart(6)} | ${
      rewEffect >= 0 ? '+' : ''
    }${rewEffect.toFixed(1).padStart(4)} | ${ourEffect >= 0 ? '+' : ''}${ourEffect
      .toFixed(1)
      .padStart(5)} | ${errRew >= 0 ? '+' : ''}${errRew.toFixed(2).padStart(6)} | ${
      errOur >= 0 ? '+' : ''
    }${errOur.toFixed(2)}`,
  );
}
