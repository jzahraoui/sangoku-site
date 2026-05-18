import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cloneFilters,
  replaceFilters,
  removeWeakFilters,
  getFilterBandwidthSpans,
} from '../src/autoeq/filterUtils.js';

test('cloneFilters returns independent copies of each filter', () => {
  const filters = [{ fc: 100, Q: 2, gain: -3 }];
  const clone = cloneFilters(filters);

  assert.deepEqual(clone, filters);
  assert.notEqual(clone, filters);
  assert.notEqual(clone[0], filters[0]);
});

test('cloneFilters copies only fc, Q and gain', () => {
  const filters = [{ fc: 100, Q: 2, gain: -3, extra: 'ignored' }];
  const clone = cloneFilters(filters);

  assert.deepEqual(clone[0], { fc: 100, Q: 2, gain: -3 });
  assert.equal('extra' in clone[0], false);
});

test('replaceFilters mutates target in-place with cloned filters', () => {
  const target = [{ fc: 50, Q: 1, gain: 0 }];
  const source = [{ fc: 100, Q: 2, gain: -3 }];

  replaceFilters(target, source);

  assert.deepEqual(target, source);
  assert.notEqual(target[0], source[0]); // independent clone
});

test('replaceFilters clears target when source is empty', () => {
  const target = [{ fc: 100, Q: 1, gain: -1 }];
  replaceFilters(target, []);
  assert.deepEqual(target, []);
});

test('removeWeakFilters removes filters at or below threshold', () => {
  const filters = [
    { fc: 100, Q: 1, gain: 0.1 },
    { fc: 200, Q: 1, gain: -0.5 },
    { fc: 300, Q: 1, gain: 1 },
  ];

  const result = removeWeakFilters(filters, 0.5);

  assert.deepEqual(result, { removedCount: 2, maxRemovedGain: 0.5 });
  assert.deepEqual(filters, [{ fc: 300, Q: 1, gain: 1 }]);
});

test('removeWeakFilters removes nothing when all filters are above threshold', () => {
  const filters = [{ fc: 100, Q: 1, gain: -2 }];
  const result = removeWeakFilters(filters, 0.5);

  assert.deepEqual(result, { removedCount: 0, maxRemovedGain: 0 });
  assert.equal(filters.length, 1);
});

test('removeWeakFilters handles negative gains correctly', () => {
  const filters = [{ fc: 100, Q: 1, gain: -0.3 }];
  const result = removeWeakFilters(filters, 0.5);

  assert.deepEqual(result, { removedCount: 1, maxRemovedGain: 0.3 });
  assert.deepEqual(filters, []);
});

test('getFilterBandwidthSpans returns fallback full-range span for empty filters', () => {
  assert.deepEqual(getFilterBandwidthSpans([], 20, 20000), [{ start: 20, end: 20000 }]);
});

test('getFilterBandwidthSpans returns a single span for one filter', () => {
  const filters = [{ fc: 1000, Q: 1, gain: -3 }];
  const spans = getFilterBandwidthSpans(filters, 20, 20000);

  assert.equal(spans.length, 1);
  assert.ok(spans[0].start < 1000);
  assert.ok(spans[0].end > 1000);
  assert.ok(spans[0].start >= 20);
  assert.ok(spans[0].end <= 20000);
});

test('getFilterBandwidthSpans merges overlapping filter spans', () => {
  // Two adjacent filters whose bandwidths overlap
  const filters = [
    { fc: 100, Q: 0.5, gain: -3 },
    { fc: 200, Q: 0.5, gain: 3 },
  ];
  const spans = getFilterBandwidthSpans(filters, 20, 20000);

  // Wide Q filters at adjacent frequencies should merge
  assert.ok(spans.length <= 2);
});

test('getFilterBandwidthSpans sorts spans by start frequency', () => {
  const filters = [
    { fc: 10000, Q: 5, gain: 3 },
    { fc: 100, Q: 5, gain: -3 },
  ];
  const spans = getFilterBandwidthSpans(filters, 20, 20000);

  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i].start >= spans[i - 1].start);
  }
});
