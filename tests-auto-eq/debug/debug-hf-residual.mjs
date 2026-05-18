/**
 * Diagnostic: dump residuals at HF for exemple4 after placing 19 filters (one less than the HF one)
 */
import { readFileSync } from 'node:fs';
import { AutoEQCalculator } from '../../src/index.js';
import {
  createConfig,
  createNearestSampler,
  parseREWFile,
  projectResponseToReferenceGrid,
  toFrequencyResponse,
} from '../test-config.js';
import { peakMagExact } from '../../src/dsp/peakingMagnitude.js';

function parseActiveRewFilters(filePath) {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const filters = [];
  let in_ = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t === 'Compound_filters') break;
    if (t.startsWith('Number')) {
      in_ = true;
      continue;
    }
    if (!in_) continue;
    const p = t.split('\t');
    if (p.length < 7 || p[1] !== 'True' || p[3] !== 'PK') continue;
    filters.push({ fc: +p[4], gain: +p[5], Q: +p[6] });
  }
  return filters.filter(
    f => Number.isFinite(f.fc) && Number.isFinite(f.gain) && Number.isFinite(f.Q),
  );
}

const measuredData = parseREWFile('./tests-auto-eq/exemple4/SBRavg.txt');
const targetData = parseREWFile('./tests-auto-eq/exemple4/Target SBRavg.txt');
const rewFilters = parseActiveRewFilters('./tests-auto-eq/exemple4/rew-auto-eq.txt');
const measuredResponse = toFrequencyResponse(measuredData);
const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
const measuredSPL = createNearestSampler(measuredResponse);
const targetCurve = createNearestSampler(targetResponse);

// Check the measured-vs-target delta in HF
console.log('=== Measured - Target at HF (raw, no EQ) ===');
for (let f = 10000; f <= 20000; f += 1000) {
  const delta = measuredSPL(f) - targetCurve(f);
  console.log(`  ${f} Hz: delta=${delta.toFixed(2)} dB`);
}

// Check residual after REW's 20 filters
console.log('\n=== Residual after REW filters at HF ===');
for (let f = 10000; f <= 20000; f += 1000) {
  let fdb = 0;
  for (const filt of rewFilters)
    fdb += peakMagExact(filt.fc, filt.Q, filt.gain, f, 48000);
  const residual = measuredSPL(f) + fdb - targetCurve(f);
  console.log(
    `  ${f} Hz: residual=${residual.toFixed(2)} dB (filtersdB=${fdb.toFixed(2)})`,
  );
}

// Run our calculator
const config = createConfig(
  {
    matchRangeEnd: 20000,
    equalizerFreqStep: 1,
    equalizerGainStep: 0.1,
    allowNarrowFiltersBelow200Hz: true,
    varyQAbove200Hz: true,
  },
  { silent: true },
);

const calculator = new AutoEQCalculator(config);
await calculator.calculate(measuredResponse, targetResponse);
const active = calculator.filterSet.getActiveFilters().sort((a, b) => a.fc - b.fc);

console.log(`\n=== Our ${active.length} filters ===`);
for (const f of active) {
  console.log(`  fc=${f.fc.toFixed(1)} gain=${f.gain.toFixed(2)} Q=${f.Q.toFixed(3)}`);
}

// Residual after our filters
console.log('\n=== Residual after our filters at HF ===');
for (let f = 10000; f <= 20000; f += 1000) {
  let fdb = 0;
  for (const filt of active) fdb += peakMagExact(filt.fc, filt.Q, filt.gain, f, 48000);
  const residual = measuredSPL(f) + fdb - targetCurve(f);
  console.log(
    `  ${f} Hz: residual=${residual.toFixed(2)} dB (filtersdB=${fdb.toFixed(2)})`,
  );
}

// Check: what would the residual look like without the 18220 Hz filter?
const withoutHF = active.filter(f => f.fc < 18000);
console.log(
  `\n=== Residual without the 18220 Hz filter (${withoutHF.length} filters) ===`,
);
for (let f = 10000; f <= 20000; f += 1000) {
  let fdb = 0;
  for (const filt of withoutHF) fdb += peakMagExact(filt.fc, filt.Q, filt.gain, f, 48000);
  const residual = measuredSPL(f) + fdb - targetCurve(f);
  console.log(
    `  ${f} Hz: residual=${residual.toFixed(2)} dB (filtersdB=${fdb.toFixed(2)})`,
  );
}
