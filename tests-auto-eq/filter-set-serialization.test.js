import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  filterSetToJSON,
  loadFilterSetFromJSON,
} from '../src/dsp/filterSetSerialization.js';
import { FilterSet } from '../src/dsp/FilterSet.js';
import { FILTER_TYPES } from '../src/dsp/filterTypes.js';

const SR = 48000;

function makeFilterSet(n = 3) {
  return new FilterSet(n, SR);
}

// ─── filterSetToJSON ─────────────────────────────────────────────────────────

test('toJSON returns sampleRate and filters array', () => {
  const fs = makeFilterSet(2);
  const json = filterSetToJSON(fs);
  assert.equal(json.sampleRate, SR);
  assert.ok(Array.isArray(json.filters));
  assert.equal(json.filters.length, 2);
});

test('FilterSet.toJSON() delegates to filterSetToJSON', () => {
  const fs = makeFilterSet(2);
  const json = fs.toJSON();
  assert.equal(json.sampleRate, SR);
  assert.ok(Array.isArray(json.filters));
});

// ─── loadFilterSetFromJSON ────────────────────────────────────────────────────

test('fromJSON restores a peaking filter', () => {
  const fs = makeFilterSet(3);
  const json = {
    sampleRate: SR,
    filters: [
      {
        type: FILTER_TYPES.PEAKING,
        enabled: true,
        fc: 1000,
        Q: 2,
        gain: -6,
        sampleRate: SR,
      },
    ],
  };
  loadFilterSetFromJSON(fs, json);
  assert.equal(fs.filters[0].filterType, FILTER_TYPES.PEAKING);
  assert.equal(fs.filters[0].fc, 1000);
  assert.equal(fs.filters[0].gain, -6);
});

test('fromJSON resets existing filters before loading', () => {
  const fs = makeFilterSet(3);
  // Set filter 0 to peaking
  fs.filters[0].setPeaking(500, 2, 6);
  // Load JSON with no active filters
  loadFilterSetFromJSON(fs, { sampleRate: SR, filters: [] });
  assert.equal(fs.filters[0].filterType, FILTER_TYPES.NONE);
  assert.equal(fs.filters[0].gain, 0);
});

test('fromJSON appends filters when JSON has more than instance', () => {
  const fs = makeFilterSet(1);
  assert.equal(fs.filters.length, 1);
  const json = {
    sampleRate: SR,
    filters: [
      {
        type: FILTER_TYPES.PEAKING,
        enabled: true,
        fc: 500,
        Q: 2,
        gain: 3,
        sampleRate: SR,
      },
      {
        type: FILTER_TYPES.PEAKING,
        enabled: true,
        fc: 2000,
        Q: 2,
        gain: -3,
        sampleRate: SR,
      },
    ],
  };
  loadFilterSetFromJSON(fs, json);
  assert.equal(fs.filters.length, 2);
  assert.equal(fs.filters[1].fc, 2000);
});

test('fromJSON throws TypeError on null', () => {
  const fs = makeFilterSet(2);
  assert.throws(() => loadFilterSetFromJSON(fs, null), TypeError);
});

test('fromJSON throws TypeError when filters is not an array', () => {
  const fs = makeFilterSet(2);
  assert.throws(
    () => loadFilterSetFromJSON(fs, { sampleRate: SR, filters: 'bad' }),
    TypeError,
  );
});

test('invalid filter in JSON does not break loading and remains reset', () => {
  const fs = makeFilterSet(3);
  const json = {
    sampleRate: SR,
    filters: [
      {
        type: FILTER_TYPES.PEAKING,
        enabled: true,
        fc: 1000,
        Q: 2,
        gain: -3,
        sampleRate: SR,
      },
      {
        type: 'INVALID',
        fc: Number.NaN,
        Q: Number.NaN,
        gain: Number.NaN,
        sampleRate: SR,
      }, // invalid
      {
        type: FILTER_TYPES.PEAKING,
        enabled: true,
        fc: 4000,
        Q: 2,
        gain: 2,
        sampleRate: SR,
      },
    ],
  };
  // Should not throw
  assert.doesNotThrow(() => loadFilterSetFromJSON(fs, json));

  assert.equal(fs.filters[0].filterType, FILTER_TYPES.PEAKING);
  assert.equal(fs.filters[1].filterType, FILTER_TYPES.NONE);
  assert.equal(fs.filters[1].gain, 0);
  assert.equal(fs.filters[2].filterType, FILTER_TYPES.PEAKING);
});
