import Scorer from './scoring.js';
import { EMPTY_CONFIG } from './config.js';
import { validateMatchingFrequencyGrid } from './response.js';

export function prepareMeasurements(optimizer) {
  const freqRangeStart = optimizer.config.frequency.min;
  const freqRangeEnd = optimizer.config.frequency.max;

  const preparedSubs = optimizer.subMeasurements.map(frequencyResponse => {
    const freqs = frequencyResponse.freqs;
    const len = freqs.length;
    const startIdx = findFirstFrequencyIndex(freqs, freqRangeStart);
    const endIdx = findFirstFrequencyAboveIndex(freqs, freqRangeEnd, startIdx, len);
    const validCount = endIdx - startIdx;
    const filteredFreqs = freqs.slice(startIdx, endIdx);

    return {
      ...frequencyResponse,
      freqs: filteredFreqs,
      magnitude: frequencyResponse.magnitude.slice(startIdx, endIdx),
      phase: frequencyResponse.phase.slice(startIdx, endIdx),
      startFreq: filteredFreqs[0],
      endFreq: filteredFreqs[validCount - 1],
      param: EMPTY_CONFIG,
    };
  });

  validatePreparedFrequencyGrid(preparedSubs);
  calculateFrequencyWeights(optimizer, preparedSubs[0].freqs);

  return preparedSubs;
}

function findFirstFrequencyIndex(freqs, freqRangeStart) {
  let lo = 0;
  let hi = freqs.length;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (freqs[mid] < freqRangeStart) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

function findFirstFrequencyAboveIndex(freqs, freqRangeEnd, startIdx, len) {
  let lo = startIdx;
  let hi = len;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (freqs[mid] <= freqRangeEnd) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

function validatePreparedFrequencyGrid(preparedSubs) {
  if (preparedSubs[0].freqs.length === 0) {
    throw new Error('Frequency response arrays cannot be empty');
  }

  validateMatchingFrequencyGrid(preparedSubs);
}

export function calculateFrequencyWeights(optimizer, frequencies) {
  const weights = Scorer.buildWeights(frequencies);
  optimizer.frequencyWeights = weights;
  optimizer._scorer = new Scorer(weights);
  return weights;
}
