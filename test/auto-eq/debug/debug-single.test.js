/**
 * Debug script pour analyser un seul exemple en détail
 */

import { AutoEQCalculator } from '../../../src/index.js';
import {
  createConfig,
  createNearestSampler,
  parseREWFile,
  projectResponseToReferenceGrid,
  toFrequencyResponse,
} from '../test-config.js';

// Analyser exemple 1
const basePath = './test/auto-eq/exemple1';
const measuredData = parseREWFile(`${basePath}/FRavg.txt`);
const targetData = parseREWFile(`${basePath}/Target FRavg.txt`);
const measuredResponse = toFrequencyResponse(measuredData);
const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
const measuredSPL = createNearestSampler(measuredResponse);
const targetCurve = createNearestSampler(targetResponse);

console.log("📊 Analyse de l'exemple 1 (FR)\n");

// Afficher le résiduel initial à quelques fréquences clés
console.log('Résiduel initial (Mesure - Target):');
for (const freq of [40, 50, 70, 100, 150, 200, 300, 500, 700, 1000, 2000, 5000, 10000]) {
  const measured = measuredSPL(freq);
  const target = targetCurve(freq);
  const residual = measured - target;
  console.log(
    `  ${freq}Hz: ${residual.toFixed(2)} dB (mesure=${measured.toFixed(
      1,
    )}, target=${target.toFixed(1)})`,
  );
}

// Lancer Auto-EQ avec logs
const calculator = new AutoEQCalculator(
  createConfig({}, { silent: false, verbose: true }),
);

console.log('\n⚙️ Calcul Auto-EQ...\n');
await calculator.calculate(measuredResponse, targetResponse);

console.log('\n�� Filtres générés:');
for (const f of calculator.filterSet.getActiveFilters()) {
  console.log(
    `  ${f.fc.toFixed(0)}Hz  ${f.gain > 0 ? '+' : ''}${f.gain.toFixed(
      1,
    )}dB  Q=${f.Q.toFixed(2)}`,
  );
}
