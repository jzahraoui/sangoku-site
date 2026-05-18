import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { AutoEQCalculator } from '../../src/index.js';
import { FilterSet } from '../../src/dsp/FilterSet.js';
import { FilterParameterOptimizer } from '../../src/optimization/FilterParameterOptimizer.js';
import { SpanAnalyzer } from '../../src/autoeq/SpanAnalyzer.js';
import {
  createConfig,
  createNearestSampler,
  parseREWFile,
  projectResponseToReferenceGrid,
  toFrequencyResponse,
} from '../test-config.js';

const examples = [
  {
    name: 'exemple1',
    measured: './tests-auto-eq/exemple1/FRavg.txt',
    target: './tests-auto-eq/exemple1/Target FRavg.txt',
    rewEQ: './tests-auto-eq/exemple1/EQ FRavg.txt',
    rewFilters: './tests-auto-eq/exemple1/rew-auto-eq.txt',
    allowNarrowFiltersBelow200Hz: true,
    varyQAbove200Hz: false,
  },
  {
    name: 'exemple2',
    measured: './tests-auto-eq/exemple2/Cavg.txt',
    target: './tests-auto-eq/exemple2/Target Cavg.txt',
    rewEQ: './tests-auto-eq/exemple2/EQ Cavg.txt',
    rewFilters: './tests-auto-eq/exemple2/rew-auto-eq.txt',
    allowNarrowFiltersBelow200Hz: true,
    varyQAbove200Hz: false,
  },
  {
    name: 'exemple3',
    measured: './tests-auto-eq/exemple3/FLavg.txt',
    target: './tests-auto-eq/exemple3/Target FLavg.txt',
    rewEQ: './tests-auto-eq/exemple3/EQ FLavg.txt',
    rewFilters: './tests-auto-eq/exemple3/rew-auto-eq.txt',
    allowNarrowFiltersBelow200Hz: true,
    varyQAbove200Hz: true,
  },
  {
    name: 'exemple4',
    measured: './tests-auto-eq/exemple4/SBRavg.txt',
    target: './tests-auto-eq/exemple4/Target SBRavg.txt',
    rewEQ: './tests-auto-eq/exemple4/EQ SBRavg.txt',
    rewFilters: './tests-auto-eq/exemple4/rew-auto-eq.txt',
    allowNarrowFiltersBelow200Hz: true,
    varyQAbove200Hz: true,
  },
];

function parseActiveRewFilters(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const filters = [];
  let inFilters = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === 'Compound_filters') break;
    if (trimmed.startsWith('Number')) {
      inFilters = true;
      continue;
    }
    if (!inFilters) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;
    if (parts[1] !== 'True' || parts[3] !== 'PK') continue;

    filters.push({
      fc: Number.parseFloat(parts[4]),
      gain: Number.parseFloat(parts[5]),
      Q: Number.parseFloat(parts[6]),
    });
  }

  return filters.filter(
    filter =>
      Number.isFinite(filter.fc) &&
      Number.isFinite(filter.gain) &&
      Number.isFinite(filter.Q),
  );
}

function deriveMatchRangeEnd(rewFilters) {
  const maxFc = rewFilters.reduce(
    (currentMax, filter) => Math.max(currentMax, filter.fc),
    0,
  );
  if (maxFc <= 0) {
    return 20000;
  }
  if (maxFc >= 10000) {
    return 20000;
  }
  return Math.max(3000, maxFc);
}

function maxDecimals(values) {
  return values.reduce((currentMax, value) => {
    const normalized = value.toString();
    const dotIndex = normalized.indexOf('.');
    if (dotIndex < 0) {
      return currentMax;
    }
    return Math.max(currentMax, normalized.length - dotIndex - 1);
  }, 0);
}

function deriveEqualizerFreqStep(rewFilters) {
  const decimals = maxDecimals(rewFilters.map(filter => filter.fc));
  if (decimals >= 2) {
    return 0.01;
  }
  if (decimals === 1) {
    return 0.1;
  }
  return 1;
}

function deriveEqualizerGainStep(rewFilters) {
  const decimals = maxDecimals(rewFilters.map(filter => filter.gain));
  if (decimals >= 2) {
    return 0.01;
  }
  return 0.1;
}

function countStepDecimals(step) {
  const normalized = step.toString().toLowerCase();
  if (normalized.includes('e-')) {
    return Number.parseInt(normalized.split('e-')[1], 10);
  }
  const dotIndex = normalized.indexOf('.');
  return dotIndex < 0 ? 0 : normalized.length - dotIndex - 1;
}

function getEqualizerFreqStep(freq, baseStep) {
  switch (countStepDecimals(baseStep)) {
    case 0:
      return 1;
    case 1:
      return freq >= 100 ? 1 : 0.1;
    case 2:
    default:
      if (freq < 50) {
        return 0.05;
      }
      if (freq < 100) {
        return 0.1;
      }
      if (freq < 200) {
        return 0.5;
      }
      return 1;
  }
}

function roundToStep(value, step, min, max) {
  const rounded = Math.round(value / step) * step;
  return Math.max(min, Math.min(max, rounded));
}

function adaptFiltersToEqualizer(filters, config) {
  for (const filter of filters) {
    const freqStep = getEqualizerFreqStep(filter.fc, config.equalizerFreqStep ?? 1);
    filter.fc = roundToStep(
      filter.fc,
      freqStep,
      config.matchRangeStart,
      config.matchRangeEnd,
    );
    filter.gain = roundToStep(
      filter.gain,
      config.equalizerGainStep ?? 0.1,
      -config.maxCutDb,
      config.individualMaxBoostDb,
    );
  }
}

function modalAwarePositiveRms(data, targetFn, startFreq = 40, endFreq = 3000) {
  const inRange = data.filter(point => point.freq >= startFreq && point.freq <= endFreq);
  const sum = inRange.reduce((acc, point) => {
    const overshoot = Math.max(point.spl - targetFn(point.freq), 0);
    return acc + overshoot * overshoot;
  }, 0);
  return Math.sqrt(sum / Math.max(inRange.length, 1));
}

function buildEqualizedData(filters, measuredData, sampleRate = 48000) {
  const filterSet = new FilterSet(Math.max(filters.length, 1), sampleRate);
  filterSet.resetAll();

  filters.forEach((filter, index) => {
    const target = filterSet.filters[index];
    target.fc = filter.fc;
    target.Q = filter.Q;
    target.gain = filter.gain;
    target.filterType = 'PEAKING';
    target.enabled = true;
    target.calcBiquad();
  });

  return measuredData.map(point => {
    const response = filterSet.getCumulativeComplexResponse(point.freq);
    return {
      freq: point.freq,
      spl: point.spl + response.magnitudeDB,
    };
  });
}

function removeWeakFilters(filters, threshold) {
  let removedCount = 0;
  let maxRemovedGain = 0;
  for (let index = filters.length - 1; index >= 0; index--) {
    if (Math.abs(filters[index].gain) <= threshold) {
      maxRemovedGain = Math.max(maxRemovedGain, Math.abs(filters[index].gain));
      filters.splice(index, 1);
      removedCount++;
    }
  }
  return { removedCount, maxRemovedGain };
}

async function rerunLikeRewFinal(
  filters,
  spanAnalyzer,
  optimizer,
  measuredResponse,
  targetResponse,
) {
  if (filters.length === 0) {
    return;
  }

  const runAll = async () => {
    filters.sort((left, right) => left.fc - right.fc);
    const spans = spanAnalyzer.calcSpansExclNotches(filters);
    optimizer.initializeFromGrid(
      measuredResponse.freqs,
      measuredResponse.magnitude,
      targetResponse.magnitude,
      spans,
    );
    await optimizer.optimizeAllParameters(filters);
  };

  await runAll();

  const removeThreshold = 0.5;
  for (let pass = 0; pass < 2; pass++) {
    const removal = removeWeakFilters(filters, removeThreshold);
    if (removal.removedCount === 0 || removal.maxRemovedGain <= 0.1) {
      break;
    }
    if (filters.length === 0) {
      return;
    }
    await runAll();
  }

  await runAll();
}

function isWithinStrictTargets(filterCount, positiveRms, maxFilters, targetPositiveRms) {
  return filterCount <= maxFilters && positiveRms <= targetPositiveRms + 1e-6;
}

function createStrictReductionOptimizer(config) {
  return new FilterParameterOptimizer({
    sampleRate: config.sampleRate,
    startFreq: config.matchRangeStart,
    endFreq: config.matchRangeEnd,
    boostPenaltyThresholdDb: config.overallMaxBoostDb,
    maxBoostDb: config.individualMaxBoostDb,
    maxCutDb: config.maxCutDb,
    maxQ:
      config.equalizerManufacturer === 'Generic' && config.equalizerModel === 'Generic'
        ? 50
        : 10,
    allowNarrowFiltersBelow200Hz: config.allowNarrowFiltersBelow200Hz,
    varyQAbove200Hz: config.varyQAbove200Hz,
  });
}

async function reduceFiltersForModalParity(
  filters,
  measuredData,
  measuredResponse,
  targetResponse,
  targetCurve,
  config,
  options = {},
) {
  const {
    maxFilters = 0,
    targetPositiveRms = Number.POSITIVE_INFINITY,
    startFreq = 40,
    endFreq = 3000,
  } = options;

  const spanAnalyzer = new SpanAnalyzer(
    config.matchRangeStart,
    config.matchRangeEnd,
    config.flatnessTarget,
    config.sampleRate,
  );
  spanAnalyzer.initFromGrid(
    measuredResponse.freqs,
    measuredResponse.magnitude,
    targetResponse.magnitude,
  );

  const optimizer = createStrictReductionOptimizer(config);

  const current = filters.map(filter => ({ ...filter }));
  let currentRms = modalAwarePositiveRms(
    buildEqualizedData(current, measuredData, config.sampleRate),
    targetCurve,
    startFreq,
    endFreq,
  );

  if (isWithinStrictTargets(current.length, currentRms, maxFilters, targetPositiveRms)) {
    return { filters: current, positiveRms: currentRms };
  }

  let changed = true;
  while (changed && current.length > 1) {
    changed = false;
    // When above target filter count, allow pRMS increase up to the REW target
    const needCountReduction = current.length > maxFilters;
    const acceptThreshold = needCountReduction
      ? Math.max(targetPositiveRms + 1e-6, currentRms + 1e-6)
      : currentRms + 1e-6;
    const candidatesByGain = current
      .map((filter, index) => ({ index, absGain: Math.abs(filter.gain) }))
      .sort((left, right) => left.absGain - right.absGain);

    for (const candidate of candidatesByGain) {
      const pruned = current
        .filter((_, index) => index !== candidate.index)
        .map(filter => ({ ...filter }));
      await rerunLikeRewFinal(
        pruned,
        spanAnalyzer,
        optimizer,
        measuredResponse,
        targetResponse,
      );
      adaptFiltersToEqualizer(pruned, config);

      const prunedRms = modalAwarePositiveRms(
        buildEqualizedData(pruned, measuredData, config.sampleRate),
        targetCurve,
        startFreq,
        endFreq,
      );

      if (prunedRms <= acceptThreshold) {
        current.splice(0, current.length, ...pruned);
        currentRms = prunedRms;
        changed = true;

        if (
          isWithinStrictTargets(current.length, currentRms, maxFilters, targetPositiveRms)
        ) {
          return { filters: current, positiveRms: currentRms };
        }

        break;
      }
    }
  }

  return { filters: current, positiveRms: currentRms };
}

test('REW parity stays within strict bounds', async () => {
  const failures = [];

  for (const example of examples) {
    if (
      !existsSync(example.measured) ||
      !existsSync(example.target) ||
      !existsSync(example.rewEQ) ||
      !existsSync(example.rewFilters)
    ) {
      continue;
    }

    const measuredData = parseREWFile(example.measured);
    const targetData = parseREWFile(example.target);
    const rewFilters = parseActiveRewFilters(example.rewFilters);
    const measuredResponse = toFrequencyResponse(measuredData);
    const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
    const targetCurve = createNearestSampler(targetResponse);
    const matchRangeEnd = deriveMatchRangeEnd(rewFilters);
    const config = createConfig(
      {
        matchRangeEnd,
        equalizerFreqStep: deriveEqualizerFreqStep(rewFilters),
        equalizerGainStep: deriveEqualizerGainStep(rewFilters),
        allowNarrowFiltersBelow200Hz: example.allowNarrowFiltersBelow200Hz,
        varyQAbove200Hz: example.varyQAbove200Hz,
      },
      { silent: true },
    );

    const calculator = new AutoEQCalculator(config);
    await calculator.calculate(measuredResponse, targetResponse);

    const activeFilters = calculator.filterSet.getActiveFilters();
    // Evaluate REW filters with our own biquad for a fair comparison
    // (REW's EQ curve file uses float-precision biquads; ours use double)
    const rewPositiveRms = modalAwarePositiveRms(
      buildEqualizedData(rewFilters, measuredData, config.sampleRate),
      targetCurve,
    );
    const reduced = await reduceFiltersForModalParity(
      activeFilters,
      measuredData,
      measuredResponse,
      targetResponse,
      targetCurve,
      config,
      {
        maxFilters: rewFilters.length,
        targetPositiveRms: rewPositiveRms,
      },
    );
    const ourPositiveRms = reduced.positiveRms;

    if (reduced.filters.length > rewFilters.length) {
      failures.push(
        `${example.name}: ${reduced.filters.length} filtres générés, REW en a ${rewFilters.length}`,
      );
    }

    if (ourPositiveRms > rewPositiveRms + 1e-6) {
      failures.push(
        `${example.name}: positive-RMS modal-aware ${ourPositiveRms.toFixed(4)} > REW ${rewPositiveRms.toFixed(4)}`,
      );
    }
  }

  const failureLines = failures.map(failure => `- ${failure}`).join('\n');
  assert.equal(failures.length, 0, `Parité REW non atteinte:\n${failureLines}`);
});
