import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCandidateFilter } from '../../src/autoeq/candidateFilter.js';
import { getBoostQUpperBound } from '../../src/autoeq/math/filterMath.js';

const baseOptions = {
  sampleRate: 48000,
  matchRangeStart: 20,
  matchRangeEnd: 20000,
  varyQAbove200Hz: false,
  equalizerAdapter: {
    quantizeFrequency: f => f,
  },
};

test('buildCandidateFilter uses peakFreq below 200 Hz', () => {
  const candidate = buildCandidateFilter(
    {
      spanStart: 40,
      spanEnd: 120,
      peakFreq: 80,
      peakVal: 5,
      sumDelta: 10,
    },
    { measuredFn: () => 0 },
    [],
    baseOptions,
  );

  assert.equal(candidate.fc, 80);
  assert.ok(candidate.Q >= 1);
});

test('buildCandidateFilter clamps and quantizes frequency', () => {
  const calls = [];
  const candidate = buildCandidateFilter(
    {
      spanStart: 5,
      spanEnd: 10,
      peakFreq: 8,
      peakVal: 3,
      sumDelta: 1,
    },
    { measuredFn: () => 0 },
    [],
    {
      ...baseOptions,
      matchRangeStart: 20,
      equalizerAdapter: {
        quantizeFrequency(freq) {
          calls.push(freq);
          return Math.round(freq);
        },
      },
    },
  );

  assert.deepEqual(calls, [20]);
  assert.equal(candidate.fc, 20);
});

test('buildCandidateFilter caps boost Q when sumDelta <= 0', () => {
  const fc = 1000;
  const candidate = buildCandidateFilter(
    {
      spanStart: 999,
      spanEnd: 1001,
      peakFreq: fc,
      peakVal: -5,
      sumDelta: -10,
    },
    { measuredFn: () => 0 },
    [],
    baseOptions,
  );

  assert.ok(candidate.Q <= getBoostQUpperBound(candidate.fc, false));
});
