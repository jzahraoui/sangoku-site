import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyFiltersToFilterSet } from '../src/autoeq/filterSetAdapter.js';

// ---------------------------------------------------------------------------
// Minimal test doubles
// ---------------------------------------------------------------------------

function makeFilterSlot() {
  return {
    fc: 0,
    Q: 0,
    gain: 0,
    filterType: 'NONE',
    enabled: false,
    calcBiquadCalled: 0,
    calcBiquad() {
      this.calcBiquadCalled++;
    },
  };
}

function makeFilterSet(size) {
  return {
    resetAllCalled: 0,
    filters: Array.from({ length: size }, makeFilterSlot),
    resetAll() {
      this.resetAllCalled++;
      for (const filter of this.filters) {
        filter.enabled = false;
        filter.filterType = 'NONE';
      }
    },
  };
}

/** Identity adapter: passes values through unchanged */
const identityAdapter = { adaptFilter: () => {} };

// ---------------------------------------------------------------------------
// 1. resetAll() is called
// ---------------------------------------------------------------------------

test('resetAll() is called exactly once', () => {
  const filterSet = makeFilterSet(1);
  applyFiltersToFilterSet(filterSet, [{ fc: 1000, Q: 1, gain: -3 }], {
    equalizerAdapter: identityAdapter,
    matchRangeStart: 20,
    sampleRate: 48000,
  });
  assert.equal(filterSet.resetAllCalled, 1);
});

test('resetAll() is called even when filters array is empty', () => {
  const filterSet = makeFilterSet(2);
  applyFiltersToFilterSet(filterSet, [], {
    equalizerAdapter: identityAdapter,
    matchRangeStart: 20,
    sampleRate: 48000,
  });
  assert.equal(filterSet.resetAllCalled, 1);
});

// ---------------------------------------------------------------------------
// 2. equalizerAdapter.adaptFilter() is called for each filter
// ---------------------------------------------------------------------------

test('adaptFilter() is called once per input filter', () => {
  const filterSet = makeFilterSet(3);
  const calls = [];
  const adapter = { adaptFilter: f => calls.push(f.fc) };

  applyFiltersToFilterSet(
    filterSet,
    [
      { fc: 100, Q: 1, gain: -2 },
      { fc: 500, Q: 2, gain: 3 },
    ],
    { equalizerAdapter: adapter, matchRangeStart: 20, sampleRate: 48000 },
  );

  assert.deepEqual(calls, [100, 500]);
});

test('adaptFilter receives a shallow copy, not the original filter object', () => {
  const filterSet = makeFilterSet(1);
  const original = { fc: 100, Q: 1, gain: -3 };
  let receivedArg;
  const adapter = {
    adaptFilter: f => {
      receivedArg = f;
    },
  };

  applyFiltersToFilterSet(filterSet, [original], {
    equalizerAdapter: adapter,
    matchRangeStart: 20,
    sampleRate: 48000,
  });

  assert.notEqual(receivedArg, original, 'adapter receives a copy, not the original');
});

test('adaptFilter mutations are visible in the written slot (rounding example)', () => {
  const filterSet = makeFilterSet(2);
  const calls = [];
  const adapter = {
    adaptFilter(f) {
      calls.push(f);
      f.fc = Math.round(f.fc);
      f.gain = Math.round(f.gain * 10) / 10;
    },
  };

  applyFiltersToFilterSet(filterSet, [{ fc: 100.4, Q: 2, gain: -3.24 }], {
    equalizerAdapter: adapter,
    matchRangeStart: 20,
    sampleRate: 48000,
  });

  assert.equal(filterSet.resetAllCalled, 1);
  assert.equal(calls.length, 1);

  assert.equal(filterSet.filters[0].enabled, true);
  assert.equal(filterSet.filters[0].filterType, 'PEAKING');
  assert.equal(filterSet.filters[0].fc, 100);
  assert.equal(filterSet.filters[0].Q, 2);
  assert.equal(filterSet.filters[0].gain, -3.2);
  assert.equal(filterSet.filters[0].calcBiquadCalled, 1);

  // Slot beyond input length stays reset
  assert.equal(filterSet.filters[1].enabled, false);
});

// ---------------------------------------------------------------------------
// 3. Excess filterSet slots remain disabled after reset
// ---------------------------------------------------------------------------

test('filterSet slots beyond input count stay disabled', () => {
  const filterSet = makeFilterSet(3);
  applyFiltersToFilterSet(filterSet, [{ fc: 1000, Q: 1, gain: -3 }], {
    equalizerAdapter: identityAdapter,
    matchRangeStart: 20,
    sampleRate: 48000,
  });
  assert.equal(filterSet.filters[1].enabled, false);
  assert.equal(filterSet.filters[2].enabled, false);
});

test('all slots disabled when input is empty', () => {
  const filterSet = makeFilterSet(2);
  applyFiltersToFilterSet(filterSet, [], {
    equalizerAdapter: identityAdapter,
    matchRangeStart: 20,
    sampleRate: 48000,
  });
  assert.equal(filterSet.filters[0].enabled, false);
  assert.equal(filterSet.filters[1].enabled, false);
});

// ---------------------------------------------------------------------------
// 4. fc is clamped to [matchRangeStart, sampleRate * 0.45]
// ---------------------------------------------------------------------------

test('fc below matchRangeStart is clamped up', () => {
  const filterSet = makeFilterSet(1);
  applyFiltersToFilterSet(filterSet, [{ fc: 10, Q: 1, gain: -3 }], {
    equalizerAdapter: identityAdapter,
    matchRangeStart: 20,
    sampleRate: 48000,
  });
  assert.equal(filterSet.filters[0].fc, 20);
});

test('fc above sampleRate * 0.45 is clamped down', () => {
  const filterSet = makeFilterSet(1);
  const maxFc = 48000 * 0.45; // 21600
  applyFiltersToFilterSet(filterSet, [{ fc: 25000, Q: 1, gain: -3 }], {
    equalizerAdapter: identityAdapter,
    matchRangeStart: 20,
    sampleRate: 48000,
  });
  assert.equal(filterSet.filters[0].fc, maxFc);
});

test('fc within range is written as-is', () => {
  const filterSet = makeFilterSet(1);
  applyFiltersToFilterSet(filterSet, [{ fc: 1000, Q: 1, gain: -3 }], {
    equalizerAdapter: identityAdapter,
    matchRangeStart: 20,
    sampleRate: 48000,
  });
  assert.equal(filterSet.filters[0].fc, 1000);
});

// ---------------------------------------------------------------------------
// 5. calcBiquad() is called on activated slots
// ---------------------------------------------------------------------------

test('calcBiquad() called once per written slot', () => {
  const filterSet = makeFilterSet(3);
  applyFiltersToFilterSet(
    filterSet,
    [
      { fc: 100, Q: 1, gain: -2 },
      { fc: 500, Q: 2, gain: 3 },
    ],
    { equalizerAdapter: identityAdapter, matchRangeStart: 20, sampleRate: 48000 },
  );
  assert.equal(filterSet.filters[0].calcBiquadCalled, 1);
  assert.equal(filterSet.filters[1].calcBiquadCalled, 1);
  assert.equal(filterSet.filters[2].calcBiquadCalled, 0);
});

test('filterType is set to PEAKING on written slots', () => {
  const filterSet = makeFilterSet(1);
  applyFiltersToFilterSet(filterSet, [{ fc: 1000, Q: 1, gain: -3 }], {
    equalizerAdapter: identityAdapter,
    matchRangeStart: 20,
    sampleRate: 48000,
  });
  assert.equal(filterSet.filters[0].filterType, 'PEAKING');
});
