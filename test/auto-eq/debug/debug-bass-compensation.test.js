/**
 * debug-bass-compensation.js
 * Déboguer la compensation de basses
 */

import { AutoEQCalculator } from '../../../src/index.js';
import {
  createConfig,
  parseREWFile,
  projectResponseToReferenceGrid,
  toFrequencyResponse,
} from '../test-config.js';

const measuredData = parseREWFile('./test/auto-eq/exemple1/FRavg.txt');
const targetData = parseREWFile('./test/auto-eq/exemple1/Target FRavg.txt');
const measuredResponse = toFrequencyResponse(measuredData);
const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);

console.log('=== DEBUG BASS COMPENSATION ===\n');

const calculator = new AutoEQCalculator(
  createConfig({}, { silent: false, verbose: true }),
);

const result = await calculator.calculate(measuredResponse, targetResponse);

console.log('\n=== FILTRES DANS LA ZONE 40-100 Hz ===');
const bassFilters = result.filters.filter(f => f.fc >= 40 && f.fc <= 100);
for (const f of bassFilters.sort((a, b) => a.fc - b.fc)) {
  const sign = f.gain >= 0 ? '+' : '';
  console.log(
    `  ${f.fc.toFixed(0).padStart(4)} Hz: ${sign}${f.gain.toFixed(1)} dB, Q=${f.Q.toFixed(
      2,
    )}`,
  );
}

console.log('\n=== COMPARAISON AVEC REW ===');
console.log('REW: 46 Hz -8.3 dB Q=1.226, 70 Hz +6.0 dB Q=2.695');
