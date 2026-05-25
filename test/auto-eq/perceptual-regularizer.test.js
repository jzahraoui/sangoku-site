import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildPerceptualRegularizedFilters } from '../../src/autoeq/perceptualRegularizer.js';
import { getBoostQUpperBound, getCutQCap } from '../../src/autoeq/math/filterMath.js';

// Identity adapter: adaptFilters is a no-op for behavioural isolation
const noopAdapter = { adaptFilters: () => {} };

// ---------------------------------------------------------------------------
// Helper: verify input is not mutated
// ---------------------------------------------------------------------------

function cloneInput(filters) {
  return filters.map(f => ({ ...f }));
}

// ---------------------------------------------------------------------------
// Near-zero gain (skip path)
// ---------------------------------------------------------------------------

test('near-zero gain filter: not changed, returned as-is', () => {
  const filters = [{ fc: 1000, Q: 2, gain: 0.05 }];
  const snapshot = cloneInput(filters);
  const { changed } = buildPerceptualRegularizedFilters(filters, {
    varyQAbove200Hz: false,
    equalizerAdapter: noopAdapter,
  });
  assert.equal(changed, false);
  assert.deepEqual(filters, snapshot, 'input must not be mutated');
});

// ---------------------------------------------------------------------------
// Boost filter — Q cap
// ---------------------------------------------------------------------------

test('boost filter with Q below cap: unchanged, changed=false', () => {
  const fc = 100;
  const cap = getBoostQUpperBound(fc, false); // 7.5
  const filters = [{ fc, Q: cap - 1, gain: 3 }];
  const { filters: out, changed } = buildPerceptualRegularizedFilters(filters, {
    varyQAbove200Hz: false,
    equalizerAdapter: noopAdapter,
  });
  assert.equal(changed, false);
  assert.equal(out[0].Q, cap - 1);
});

test('boost filter with Q above cap: Q clamped to cap, changed=true', () => {
  const fc = 100;
  const cap = getBoostQUpperBound(fc, false); // 7.5
  const filters = [{ fc, Q: cap + 3, gain: 3 }];
  const { filters: out, changed } = buildPerceptualRegularizedFilters(filters, {
    varyQAbove200Hz: false,
    equalizerAdapter: noopAdapter,
  });
  assert.equal(changed, true);
  assert.equal(out[0].Q, cap);
});

test('boost filter with varyQAbove200Hz=true tightens cap above 200 Hz', () => {
  const fc = 500;
  const capFalse = getBoostQUpperBound(fc, false); // 7.5
  const capTrue = getBoostQUpperBound(fc, true); // < 7.5
  assert.ok(capTrue < capFalse, 'tighter cap when varyQAbove200Hz=true');

  // Q set to the looser cap → should be clamped with varyQ=true
  const filters = [{ fc, Q: capFalse, gain: 2 }];
  const { filters: out, changed } = buildPerceptualRegularizedFilters(filters, {
    varyQAbove200Hz: true,
    equalizerAdapter: noopAdapter,
  });
  assert.equal(changed, true);
  assert.equal(out[0].Q, capTrue);
});

// ---------------------------------------------------------------------------
// Boost filter — high-frequency gain rolloff
// ---------------------------------------------------------------------------

test('boost at fc>3000 with gain>2.5: gain reduced to 0.9×, changed=true', () => {
  const filters = [{ fc: 5000, Q: 1, gain: 4 }];
  const { filters: out, changed } = buildPerceptualRegularizedFilters(filters, {
    varyQAbove200Hz: false,
    equalizerAdapter: noopAdapter,
  });
  assert.equal(changed, true);
  assert.ok(Math.abs(out[0].gain - 4 * 0.9) < 1e-10);
});

test('boost at fc>3000 with gain≤2.5: gain not touched', () => {
  const filters = [{ fc: 5000, Q: 1, gain: 2.5 }];
  const { filters: out } = buildPerceptualRegularizedFilters(filters, {
    varyQAbove200Hz: false,
    equalizerAdapter: noopAdapter,
  });
  // changed may be true or false depending on Q — just check gain is intact
  assert.equal(out[0].gain, 2.5);
});

test('boost at fc≤3000: gain not reduced regardless of level', () => {
  const filters = [{ fc: 3000, Q: 1, gain: 10 }];
  const { filters: out } = buildPerceptualRegularizedFilters(filters, {
    varyQAbove200Hz: false,
    equalizerAdapter: noopAdapter,
  });
  assert.equal(out[0].gain, 10);
});

// ---------------------------------------------------------------------------
// Cut filter — Q cap
// ---------------------------------------------------------------------------

test('cut filter with Q below cap: unchanged, changed=false', () => {
  const fc = 500;
  const cap = getCutQCap(fc, 12, 10, 6); // 10
  const filters = [{ fc, Q: cap - 1, gain: -3 }];
  const { filters: out, changed } = buildPerceptualRegularizedFilters(filters, {
    varyQAbove200Hz: false,
    equalizerAdapter: noopAdapter,
  });
  assert.equal(changed, false);
  assert.equal(out[0].Q, cap - 1);
});

test('cut filter with Q above cap: Q clamped, changed=true', () => {
  const fc = 500;
  const cap = getCutQCap(fc, 12, 10, 6); // 10
  const filters = [{ fc, Q: cap + 5, gain: -3 }];
  const { filters: out, changed } = buildPerceptualRegularizedFilters(filters, {
    varyQAbove200Hz: false,
    equalizerAdapter: noopAdapter,
  });
  assert.equal(changed, true);
  assert.equal(out[0].Q, cap);
});

test('cut Q cap varies by frequency region', () => {
  for (const [fc, expectedCap] of [
    [100, 12],
    [500, 10],
    [5000, 6],
  ]) {
    const filters = [{ fc, Q: 20, gain: -3 }];
    const { filters: out } = buildPerceptualRegularizedFilters(filters, {
      varyQAbove200Hz: false,
      equalizerAdapter: noopAdapter,
    });
    assert.equal(out[0].Q, expectedCap, `fc=${fc} → Q cap should be ${expectedCap}`);
  }
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

test('input array is not mutated', () => {
  const filters = [{ fc: 5000, Q: 20, gain: 4 }]; // triggers both Q cap and gain rolloff
  const snapshot = cloneInput(filters);
  buildPerceptualRegularizedFilters(filters, {
    varyQAbove200Hz: false,
    equalizerAdapter: noopAdapter,
  });
  assert.deepEqual(filters, snapshot, 'original filters must be untouched');
});

// ---------------------------------------------------------------------------
// equalizerAdapter is called
// ---------------------------------------------------------------------------

test('equalizerAdapter.adaptFilters is called once with the regularized array', () => {
  const filters = [{ fc: 1000, Q: 1, gain: -2 }];
  let callCount = 0;
  let receivedArg;
  const spyAdapter = {
    adaptFilters(arr) {
      callCount++;
      receivedArg = arr;
    },
  };
  const { filters: out } = buildPerceptualRegularizedFilters(filters, {
    varyQAbove200Hz: false,
    equalizerAdapter: spyAdapter,
  });
  assert.equal(callCount, 1);
  assert.equal(receivedArg, out); // same reference as returned array
});

// ---------------------------------------------------------------------------
// Mixed-sign filters
// ---------------------------------------------------------------------------

test('mixed boost and cut filters: each regularized independently', () => {
  const boost = { fc: 5000, Q: 20, gain: 4 }; // Q and gain both clamped
  const cut = { fc: 500, Q: 20, gain: -3 }; // Q clamped
  const { filters: out, changed } = buildPerceptualRegularizedFilters([boost, cut], {
    varyQAbove200Hz: false,
    equalizerAdapter: noopAdapter,
  });
  assert.equal(changed, true);
  assert.ok(out[0].Q < 20, 'boost Q should be capped');
  assert.ok(out[0].gain < 4, 'boost gain should be rolled off');
  assert.equal(out[1].Q, getCutQCap(500, 12, 10, 6));
});
