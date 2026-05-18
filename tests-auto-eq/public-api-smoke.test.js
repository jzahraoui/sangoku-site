import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AutoEQCalculator } from '../src/index.js';

test('AutoEQCalculator public API calculates and exports filters', async () => {
  const freqs = Float64Array.from([20, 40, 80, 160, 320, 640, 1280, 2560]);
  const measuredSPL = {
    freqs,
    magnitude: Float64Array.from([3, 2, 1, 0, -1, -1, 0, 1]),
  };
  const targetCurve = {
    freqs,
    magnitude: Float64Array.from([0, 0, 0, 0, 0, 0, 0, 0]),
  };

  const calculator = new AutoEQCalculator({
    sampleRate: 48000,
    numFilters: 3,
    matchRangeStart: 20,
    matchRangeEnd: 3000,
    enableBeatRewOptimization: false,
    enableCandidatePlacement: false,
    onLog: () => {},
    onProgress: () => {},
  });

  const result = await calculator.calculate(measuredSPL, targetCurve);

  assert.ok(Array.isArray(result.filters));
  assert.ok(Number.isFinite(result.initialMSE));
  assert.ok(Number.isFinite(result.finalMSE));
  assert.ok(Number.isFinite(result.improvement));
  assert.ok(Number.isFinite(result.elapsed));
  assert.ok(result.quality);

  const exported = calculator.exportFilters();
  assert.ok(exported);
});
