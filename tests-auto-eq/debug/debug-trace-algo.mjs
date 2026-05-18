/**
 * Diagnostic: trace the algorithm step by step for exemple1
 * Compare with REW's filter placement.
 */
import { AutoEQCalculator } from '../../src/index.js';
import {
  createConfig,
  parseREWFile,
  projectResponseToReferenceGrid,
  toFrequencyResponse,
} from '../test-config.js';

// Load data
const measuredData = parseREWFile('./tests-auto-eq/exemple1/FRavg.txt');
const targetData = parseREWFile('./tests-auto-eq/exemple1/Target FRavg.txt');
const measuredResponse = toFrequencyResponse(measuredData);
const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);

// Config matching the strict test
const config = createConfig(
  {
    matchRangeEnd: 20000,
    numFilters: 20,
    equalizerFreqStep: 0.01,
    equalizerGainStep: 0.1,
    allowNarrowFiltersBelow200Hz: true,
    varyQAbove200Hz: false,
    equalizerManufacturer: 'Generic',
    equalizerModel: 'Generic',
  },
  { silent: true },
);

// Create calculator but we need to trace it
const calc = new AutoEQCalculator(config);
const calculationContext = calc._prepareGridCalculationContext(
  measuredResponse,
  targetResponse,
);
const { scanFreqs, measuredArr, targetArr } = calculationContext;

console.log(
  `Scan grid: ${scanFreqs.length} points, ${scanFreqs[0].toFixed(2)} - ${scanFreqs[scanFreqs.length - 1].toFixed(2)} Hz`,
);

// Show initial residuals (measured - target)
const residuals = calc._buildResiduals(scanFreqs, measuredArr, targetArr, []);
console.log('\nInitial residuals at key frequencies:');
for (let i = 0; i < scanFreqs.length; i += 20) {
  console.log(`  ${scanFreqs[i].toFixed(1)} Hz: residual = ${residuals[i].toFixed(3)}`);
}

// Find candidate spans with the current placement logic
const spans = calc._findCandidateSpans(scanFreqs, residuals, [], scanFreqs.length);
const bestSpan = spans[0];

if (!bestSpan) {
  console.log('\nNo valid candidate span found.');
  process.exit(0);
}

console.log('\n=== First best span ===');
console.log(`  spanStart: ${bestSpan.spanStart.toFixed(2)}`);
console.log(`  spanEnd: ${bestSpan.spanEnd.toFixed(2)}`);
console.log(`  peakFreq: ${bestSpan.peakFreq.toFixed(2)}`);
console.log(`  peakVal: ${bestSpan.peakVal.toFixed(3)}`);
console.log(`  sumDelta: ${bestSpan.sumDelta.toFixed(3)}`);
console.log(`  priority: ${bestSpan.priority.toFixed(3)}`);

// Build candidate
const candidate = calc._buildCandidateFilter(bestSpan, calculationContext, []);
console.log('\n=== First candidate filter ===');
console.log(`  fc: ${candidate.fc.toFixed(2)}`);
console.log(`  Q: ${candidate.Q.toFixed(3)}`);

// REW's first filter: fc=46.45, gain=-8.3, Q=1.226
console.log('\n=== REW first filter ===');
console.log(`  fc: 46.45`);
console.log(`  Q: 1.226`);
console.log(`  gain: -8.3`);

// Trace all valid candidates retained by the current span-selection logic
console.log('\n=== All valid candidate spans ===');
for (const s of spans) {
  console.log(
    `  [${s.spanStart.toFixed(1)} - ${s.spanEnd.toFixed(1)}] peak=${s.peakFreq.toFixed(1)} ` +
      `peakVal=${s.peakVal.toFixed(3)} |sumDelta|=${Math.abs(s.sumDelta).toFixed(3)} ` +
      `priority=${s.priority.toFixed(3)}`,
  );
}

// Check allowBoosts effect: if residuals[0] < 0, the first span is skipped
console.log(
  `\nresiduals[0] = ${residuals[0].toFixed(3)} ` +
    `(allowBoosts=${calc.allowBoosts}, so ${residuals[0] > 0 || calc.allowBoosts ? 'span STARTED' : 'span NOT started'})`,
);
