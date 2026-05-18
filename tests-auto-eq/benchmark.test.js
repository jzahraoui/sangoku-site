/**
 * Benchmark AutoEQ — measures real pipeline configurations across all 4 test examples.
 *
 * Run: npm run test:bench
 */

import { AutoEQCalculator } from '../src/index.js';
import {
  parseREWFile,
  toFrequencyResponse,
  projectResponseToReferenceGrid,
} from './test-config.js';

const EXAMPLES = [
  {
    name: 'exemple1',
    measured: './tests-auto-eq/exemple1/FRavg.txt',
    target: './tests-auto-eq/exemple1/Target FRavg.txt',
  },
  {
    name: 'exemple2',
    measured: './tests-auto-eq/exemple2/Cavg.txt',
    target: './tests-auto-eq/exemple2/Target Cavg.txt',
  },
  {
    name: 'exemple3',
    measured: './tests-auto-eq/exemple3/FLavg.txt',
    target: './tests-auto-eq/exemple3/Target FLavg.txt',
  },
  {
    name: 'exemple4',
    measured: './tests-auto-eq/exemple4/SBRavg.txt',
    target: './tests-auto-eq/exemple4/Target SBRavg.txt',
  },
];

const CONFIGS = [
  {
    name: 'default',
    config: {},
  },
  {
    name: '10 filters',
    config: { numFilters: 10 },
  },
  {
    name: '30 filters',
    config: { numFilters: 30 },
  },
  {
    name: 'candidate placement',
    config: {
      enableCandidatePlacement: true,
      placementCandidateCount: 3,
      placementCandidateIterations: 60,
    },
  },
  {
    name: 'beat rew',
    config: {
      enableBeatRewOptimization: true,
      enableCandidatePlacement: true,
      enableReduceRepair: true,
      enableCriticalBandRefinement: true,
    },
  },
];

const BASE_CONFIG = {
  sampleRate: 48000,
  numFilters: 20,
  matchRangeStart: 20,
  matchRangeEnd: 20000,
  individualMaxBoostDb: 6,
  overallMaxBoostDb: 6,
  maxCutDb: 12,
  flatnessTarget: 1,
};

console.log('🔬 Benchmark AutoEQ\n');
console.log(
  'Example'.padEnd(10),
  'Config'.padEnd(22),
  'Time'.padStart(7),
  'Filters'.padStart(8),
  'Final RMS'.padStart(11),
);
console.log('-'.repeat(62));

for (const example of EXAMPLES) {
  const measuredData = parseREWFile(example.measured);
  const targetData = parseREWFile(example.target);
  const measuredResponse = toFrequencyResponse(measuredData);
  const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);

  for (const { name, config } of CONFIGS) {
    const calculator = new AutoEQCalculator({
      ...BASE_CONFIG,
      ...config,
    });

    const start = performance.now();
    const result = await calculator.calculate(measuredResponse, targetResponse);
    const elapsed = (performance.now() - start) / 1000;

    const activeFilters = calculator.filterSet.getActiveFilters().length;
    const finalRms = result.finalMSE.toFixed(2);

    console.log(
      example.name.padEnd(10),
      name.padEnd(22),
      `${elapsed.toFixed(2)}s`.padStart(7),
      String(activeFilters).padStart(8),
      `${finalRms} dB`.padStart(11),
    );
  }

  console.log();
}
