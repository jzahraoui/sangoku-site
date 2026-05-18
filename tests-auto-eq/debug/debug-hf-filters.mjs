/**
 * Diagnostic: dump our filters for each example to see the HF anomaly
 */
import { existsSync, readFileSync } from 'node:fs';
import { AutoEQCalculator } from '../../src/index.js';
import {
  createConfig,
  parseREWFile,
  projectResponseToReferenceGrid,
  toFrequencyResponse,
} from '../test-config.js';

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

function deriveMatchRangeEnd(rewFilters) {
  const maxFc = rewFilters.reduce((m, f) => Math.max(m, f.fc), 0);
  if (maxFc <= 0) return 20000;
  if (maxFc >= 10000) return 20000;
  return Math.max(3000, maxFc);
}
function maxDecimals(vals) {
  return vals.reduce((m, v) => {
    const s = v.toString();
    const d = s.indexOf('.');
    return d < 0 ? m : Math.max(m, s.length - d - 1);
  }, 0);
}
function deriveEqualizerFreqStep(rf) {
  const d = maxDecimals(rf.map(f => f.fc));
  if (d >= 2) {
    return 0.01;
  }
  if (d === 1) {
    return 0.1;
  }
  return 1;
}
function deriveEqualizerGainStep(rf) {
  const d = maxDecimals(rf.map(f => f.gain));
  return d >= 2 ? 0.01 : 0.1;
}

const examples = [
  {
    name: 'exemple1',
    measured: './tests-auto-eq/exemple1/FRavg.txt',
    target: './tests-auto-eq/exemple1/Target FRavg.txt',
    rewFilters: './tests-auto-eq/exemple1/rew-auto-eq.txt',
    allowNarrow: true,
    varyQ: false,
  },
  {
    name: 'exemple2',
    measured: './tests-auto-eq/exemple2/Cavg.txt',
    target: './tests-auto-eq/exemple2/Target Cavg.txt',
    rewFilters: './tests-auto-eq/exemple2/rew-auto-eq.txt',
    allowNarrow: true,
    varyQ: false,
  },
  {
    name: 'exemple3',
    measured: './tests-auto-eq/exemple3/FLavg.txt',
    target: './tests-auto-eq/exemple3/Target FLavg.txt',
    rewFilters: './tests-auto-eq/exemple3/rew-auto-eq.txt',
    allowNarrow: true,
    varyQ: true,
  },
  {
    name: 'exemple4',
    measured: './tests-auto-eq/exemple4/SBRavg.txt',
    target: './tests-auto-eq/exemple4/Target SBRavg.txt',
    rewFilters: './tests-auto-eq/exemple4/rew-auto-eq.txt',
    allowNarrow: true,
    varyQ: true,
  },
];

for (const ex of examples) {
  if (!existsSync(ex.measured)) continue;
  const measuredData = parseREWFile(ex.measured);
  const targetData = parseREWFile(ex.target);
  const rewFilters = parseActiveRewFilters(ex.rewFilters);
  const measuredResponse = toFrequencyResponse(measuredData);
  const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
  const matchRangeEnd = deriveMatchRangeEnd(rewFilters);

  const config = createConfig(
    {
      matchRangeEnd,
      equalizerFreqStep: deriveEqualizerFreqStep(rewFilters),
      equalizerGainStep: deriveEqualizerGainStep(rewFilters),
      allowNarrowFiltersBelow200Hz: ex.allowNarrow,
      varyQAbove200Hz: ex.varyQ,
    },
    { silent: true },
  );

  const calculator = new AutoEQCalculator(config);
  await calculator.calculate(measuredResponse, targetResponse);
  const active = calculator.filterSet.getActiveFilters().sort((a, b) => a.fc - b.fc);

  console.log(
    `\n=== ${ex.name} (matchRangeEnd=${matchRangeEnd}, REW has ${rewFilters.length} filters, we have ${active.length}) ===`,
  );
  console.log('Our filters (HF only, fc > 3000 Hz):');
  for (const f of active.filter(f => f.fc > 3000)) {
    console.log(`  fc=${f.fc.toFixed(1)} gain=${f.gain.toFixed(2)} Q=${f.Q.toFixed(3)}`);
  }
  console.log('REW filters (HF only, fc > 3000 Hz):');
  for (const f of rewFilters.filter(f => f.fc > 3000)) {
    console.log(`  fc=${f.fc.toFixed(1)} gain=${f.gain.toFixed(2)} Q=${f.Q.toFixed(3)}`);
  }
}
