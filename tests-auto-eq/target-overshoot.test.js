import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reduceTargetOvershoot } from '../src/autoeq/targetOvershoot.js';

// Minimal calculationContext mock — enough for _findWorstTargetOvershoot
function makeContext({ freqs, measured, target, ppo = 24 }) {
  return {
    pointsPerOctave: ppo,
    scanFreqs: Float64Array.from(freqs),
    measuredArr: new Float64Array(measured),
    targetArr: new Float64Array(target),
  };
}

const SR = 48000;

test('reduceTargetOvershoot: no filters → does nothing', () => {
  const ctx = makeContext({ freqs: [1000], measured: [0], target: [-20] });
  const filters = [];
  reduceTargetOvershoot(filters, ctx, { sampleRate: SR, silent: true });
  assert.deepEqual(filters, []);
});

test('reduceTargetOvershoot: cut filters only → no gain change', () => {
  // Even with large negative residuals, cut filters cannot cause overshoot
  const ctx = makeContext({ freqs: [1000], measured: [0], target: [-20] });
  const filters = [{ fc: 1000, Q: 2, gain: -6 }];
  const gainBefore = filters[0].gain;
  reduceTargetOvershoot(filters, ctx, { sampleRate: SR, silent: true });
  assert.equal(filters[0].gain, gainBefore);
});

test('reduceTargetOvershoot: boost filter with no overshoot → gain unchanged', () => {
  // measured -20, target 0 → corrected ≈ -20 + boost_response → well below target
  const ctx = makeContext({ freqs: [1000], measured: [-20], target: [0] });
  const filters = [{ fc: 1000, Q: 1, gain: 3 }];
  const gainBefore = filters[0].gain;
  reduceTargetOvershoot(filters, ctx, { sampleRate: SR, silent: true });
  assert.equal(filters[0].gain, gainBefore);
});

test('reduceTargetOvershoot: boost filter with overshoot → gain reduced', () => {
  // measured +5 dB above target, boost adds more → forces overshoot
  // target at each freq is -10, measured is +5 → residual = +15
  // The boost at fc=1000 adds ~gain dB at 1000 Hz → overshoot = 5 + gain - (-10)
  const ctx = makeContext({ freqs: [1000], measured: [5], target: [-10] });
  const filters = [{ fc: 1000, Q: 1, gain: 6 }];
  const gainBefore = filters[0].gain;
  reduceTargetOvershoot(filters, ctx, { sampleRate: SR, silent: true });
  assert.ok(
    filters[0].gain < gainBefore,
    'gain should be reduced when overshoot detected',
  );
  assert.ok(filters[0].gain > 0, 'gain should remain positive after partial reduction');
});

test('reduceTargetOvershoot: threshold option is honoured', () => {
  // overshoot of ~1.0 dB (below default 1.5 threshold) should not trigger reduction
  // measured = 0, target = 0, boost at fc=500 adds ~0.5 dB at 1000 Hz → small overshoot
  const ctx = makeContext({ freqs: [1000], measured: [0], target: [0] });
  const filters = [{ fc: 1000, Q: 1, gain: 0.8 }];
  const gainBefore = filters[0].gain;
  // With a very high threshold, no reduction should happen
  reduceTargetOvershoot(filters, ctx, { sampleRate: SR, silent: true, threshold: 50 });
  assert.equal(filters[0].gain, gainBefore);
});

test('reduceTargetOvershoot: silent=true suppresses all log calls', () => {
  const ctx = makeContext({ freqs: [1000], measured: [5], target: [-10] });
  const filters = [{ fc: 1000, Q: 1, gain: 6 }];
  const logs = [];
  reduceTargetOvershoot(filters, ctx, {
    sampleRate: SR,
    silent: true,
    onLog: msg => logs.push(msg),
  });
  assert.equal(logs.length, 0);
});

test('reduceTargetOvershoot: onLog called when reduction happens (silent=false)', () => {
  const ctx = makeContext({ freqs: [1000], measured: [5], target: [-10] });
  const filters = [{ fc: 1000, Q: 1, gain: 6 }];
  const logs = [];
  reduceTargetOvershoot(filters, ctx, {
    sampleRate: SR,
    silent: false,
    onLog: msg => logs.push(msg),
  });
  assert.ok(logs.length > 0, 'should log when reduction happens');
});

test('reduceTargetOvershoot: multiple boost filters, only responsible one reduced', () => {
  // One boost right at the overshoot frequency, one far away
  const ctx = makeContext({ freqs: [1000], measured: [5], target: [-10] });
  const filters = [
    { fc: 1000, Q: 1, gain: 6 }, // near 1000 Hz → responsible
    { fc: 100, Q: 1, gain: 6 }, // far away → not responsible
  ];
  const farGainBefore = filters[1].gain;
  reduceTargetOvershoot(filters, ctx, { sampleRate: SR, silent: true });
  // The near filter should be reduced; the far one should be unaffected
  assert.ok(filters[0].gain < 6, 'near-frequency boost should be reduced');
  assert.equal(filters[1].gain, farGainBefore, 'far-frequency boost should be unchanged');
});
