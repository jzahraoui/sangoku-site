import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildResiduals, getFilteredSPLAt } from '../src/autoeq/residuals.js';

const SR = 48000;

test('buildResiduals returns measured minus target when no filters are active', () => {
  const scanFreqs = Float64Array.from([100, 1000, 10000]);
  const measuredArr = Float64Array.from([3, 0, -2]);
  const targetArr = Float64Array.from([1, 1, 1]);

  const residuals = buildResiduals(scanFreqs, measuredArr, targetArr, [], SR);

  assert.deepEqual(Array.from(residuals), [2, -1, -3]);
});

test('buildResiduals includes filter contribution', () => {
  const scanFreqs = Float64Array.from([1000]);
  const measuredArr = Float64Array.from([0]);
  const targetArr = Float64Array.from([0]);

  const residuals = buildResiduals(
    scanFreqs,
    measuredArr,
    targetArr,
    [{ fc: 1000, Q: 1, gain: 6 }],
    SR,
  );

  assert.ok(residuals[0] > 5.5);
  assert.ok(residuals[0] < 6.5);
});

test('getFilteredSPLAt returns measured value plus filter response', () => {
  const calculationContext = {
    measuredFn: () => 0,
  };

  const spl = getFilteredSPLAt(
    1000,
    calculationContext,
    [{ fc: 1000, Q: 1, gain: 6 }],
    SR,
  );

  assert.ok(spl > 5.5);
  assert.ok(spl < 6.5);
});
