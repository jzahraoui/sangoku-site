import { normalizeParam } from './config.js';

export function generateTestParams(config, stepFactor = 1) {
  const delays = generateRange(
    config.delay.min,
    config.delay.max,
    config.delay.step,
    stepFactor,
  );
  const gains = generateRange(
    config.gain.min,
    config.gain.max,
    config.gain.step,
    stepFactor,
  );
  const allPassParamsList = [{ frequency: 0, q: 0, enabled: false }];

  if (config.allPass.enabled) {
    const frequencies = generateRange(
      config.allPass.frequency.min,
      config.allPass.frequency.max,
      config.allPass.frequency.step,
      stepFactor,
    );
    const qValues = generateRange(
      config.allPass.q.min,
      config.allPass.q.max,
      config.allPass.q.step,
      stepFactor,
    );

    allPassParamsList.push(
      ...frequencies.flatMap(frequency =>
        qValues.map(q => ({
          frequency,
          q,
          enabled: true,
        })),
      ),
    );
  }

  return generateParameterCombinations(delays, gains, allPassParamsList);
}

export function generateParameterCombinations(delays, gains, allPassParamsList) {
  const combinations = new Array(2 * delays.length * gains.length * allPassParamsList.length);
  let index = 0;

  for (const polarity of [-1, 1]) {
    for (const delay of delays) {
      for (const gain of gains) {
        for (const allPass of allPassParamsList) {
          combinations[index++] = { delay, gain, polarity, allPass };
        }
      }
    }
  }
  return combinations;
}

export function countAllPossibleCombinations(config) {
  const { allPass } = config;
  const delayCount = countRangeValues(config.delay);
  const gainCount = countRangeValues(config.gain);
  const polarityCount = 2;

  let allPassCount = 1;
  if (allPass.enabled) {
    const frequencyCount = countRangeValues(allPass.frequency);
    const qCount = countRangeValues(allPass.q);
    allPassCount = frequencyCount * qCount + 1;
  }

  return delayCount * gainCount * polarityCount * allPassCount;
}

export function buildOptimizationOptions(config, method) {
  const options = { method };

  if (method === 'classic') {
    options.testParamsList = Object.freeze(generateTestParams(config));
    return options;
  }

  const stepFactor = config.allPass.enabled ? 10 : 2;
  options.testParamsList = Object.freeze(generateTestParams(config, stepFactor));
  options.coarseSeedCount = config.optimization.multiStart.coarseSeedCount;

  if (config.optimization.multiStart.enabled) {
    options.runs = config.optimization.multiStart.runs;
    options.minRunImprovement = config.optimization.multiStart.minRunImprovement;
  }

  if (config.allPass.enabled) {
    options.runs = options.runs ?? 1;
    options.populationSize = 45;
    options.generations = 32;
    options.maxNoImprovementGenerations = 8;
    options.withAllPassProbability = 0.8;
  }

  return options;
}

export function coarseDiversityKey(config, param) {
  const normalized = normalizeParam(param);
  const delayRange = Math.max(0, config.delay.max - config.delay.min);
  const delayBucketSize = Math.max(config.delay.step * 8, delayRange / 8 || 1);
  const delayBucket = Math.round((normalized.delay - config.delay.min) / delayBucketSize);
  const gainRange = Math.max(0, config.gain.max - config.gain.min);
  const gainBucketSize = Math.max(config.gain.step * 2, gainRange / 4 || 1);
  const gainBucket = Math.round((normalized.gain - config.gain.min) / gainBucketSize);

  if (!normalized.allPass.enabled) {
    return `${normalized.polarity}|${delayBucket}|${gainBucket}|no-ap`;
  }

  const allPassFrequencyRange = Math.max(
    0,
    config.allPass.frequency.max - config.allPass.frequency.min,
  );
  const allPassFrequencyBucketSize = Math.max(
    config.allPass.frequency.step * 4,
    allPassFrequencyRange / 6 || 1,
  );
  const allPassFrequencyBucket = Math.round(
    (normalized.allPass.frequency - config.allPass.frequency.min) /
      allPassFrequencyBucketSize,
  );
  const allPassQRange = Math.max(0, config.allPass.q.max - config.allPass.q.min);
  const allPassQBucketSize = Math.max(config.allPass.q.step, allPassQRange / 3 || 1);
  const allPassQBucket = Math.round(
    (normalized.allPass.q - config.allPass.q.min) / allPassQBucketSize,
  );

  return [
    normalized.polarity,
    delayBucket,
    gainBucket,
    'ap',
    allPassFrequencyBucket,
    allPassQBucket,
  ].join('|');
}

function generateRange(min, max, step, stepFactor) {
  const stepAdjusted = step * stepFactor;
  const count = Math.floor((max - min) / stepAdjusted + 0.5) + 1;
  const values = new Array(count);

  for (let index = 0; index < count; index++) {
    const value = roundToResolution(min + index * stepAdjusted, step);
    values[index] = Math.min(value, max);
  }

  return values;
}

function countRangeValues(range) {
  return Math.floor((range.max - range.min) / range.step + 0.5) + 1;
}

function roundToResolution(value, resolution = 0.0001) {
  const decimalPlaces = -Math.floor(Math.log10(resolution));
  const multiplier = 10 ** decimalPlaces;
  return Math.round(value * multiplier) / multiplier;
}
