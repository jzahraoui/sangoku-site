import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import FrequencyResponseProcessor from '../src/frequency-response-processor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseREWFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const freqs = [];
  const magnitude = [];
  const phase = [];

  for (const line of content.split('\n')) {
    if (line.startsWith('*') || line.trim() === '') continue;

    const parts = line.trim().split(/\s+/).map(Number.parseFloat);
    if (parts.length >= 3) {
      freqs.push(parts[0]);
      magnitude.push(parts[1]);
      phase.push(parts[2]);
    }
  }

  return {
    freqs: Float32Array.from(freqs),
    magnitude: Float32Array.from(magnitude),
    phase: Float32Array.from(phase),
  };
}

function phaseErrorDegrees(actual, expected) {
  const diff = ((((actual - expected + 180) % 360) + 360) % 360) - 180;
  return Math.abs(diff);
}

function phaseErrorStats(actual, expected) {
  assert.equal(actual.length, expected.length);

  let maxError = 0;
  let totalError = 0;
  let over10Degrees = 0;

  for (let i = 0; i < actual.length; i++) {
    const error = phaseErrorDegrees(actual[i], expected[i]);
    maxError = Math.max(maxError, error);
    totalError += error;
    if (error > 10) over10Degrees++;
  }

  return {
    maxError,
    averageError: totalError / actual.length,
    over10Degrees,
  };
}

test('calculateMinimumPhase uses PPO metadata and tracks the REW minimum-phase export', () => {
  const input = parseREWFile(join(__dirname, './sw1.txt'));
  const expected = parseREWFile(join(__dirname, './sw1mp.txt'));

  const calculated = FrequencyResponseProcessor.calculateMinimumPhase({
    freqs: input.freqs,
    magnitude: input.magnitude,
    ppo: 96,
  });

  assert.ok(calculated instanceof Float32Array);
  assert.equal(calculated.length, expected.phase.length);

  const stats = phaseErrorStats(calculated, expected.phase);

  assert.ok(
    stats.maxError < 145,
    `max wrapped phase error ${stats.maxError.toFixed(2)} deg exceeded tolerance`,
  );
  assert.ok(
    stats.averageError < 35,
    `average wrapped phase error ${stats.averageError.toFixed(2)} deg exceeded tolerance`,
  );
});

test('calculateMinimumPhase accepts linearly spaced freqStep metadata', () => {
  const freqs = Float32Array.from({ length: 8 }, (_, i) => 20 + i * 10);
  const magnitude = Float32Array.from([72, 74, 76, 78, 80, 79, 77, 75]);

  const calculated = FrequencyResponseProcessor.calculateMinimumPhase({
    startFreq: freqs[0],
    freqStep: 10,
    magnitude,
  });

  assert.ok(calculated instanceof Float32Array);
  assert.equal(calculated.length, magnitude.length);
  assert.ok(Array.from(calculated).every(Number.isFinite));
});

test('smooth returns a copy for None and validates invalid inputs', () => {
  const freqs = Float32Array.from([20, 30, 40, 50]);
  const magnitude = Float32Array.from([70, 73, 71, 72]);

  const unsmoothed = FrequencyResponseProcessor.smooth(freqs, magnitude, 'None');
  assert.deepEqual(Array.from(unsmoothed), Array.from(magnitude));
  assert.notEqual(unsmoothed, magnitude);

  assert.throws(
    () => FrequencyResponseProcessor.smooth(freqs, magnitude, 'bad'),
    /Invalid smoothing value/,
  );
  assert.throws(
    () =>
      FrequencyResponseProcessor.smooth(
        Float32Array.from([0, 30, 40, 50]),
        magnitude,
        '1/12',
      ),
    /positive/,
  );
});

test('calculateMinimumPhase rejects missing spacing metadata when frequencies are absent', () => {
  assert.throws(
    () =>
      FrequencyResponseProcessor.calculateMinimumPhase({
        startFreq: 20,
        magnitude: Float32Array.from([70, 71, 72]),
      }),
    /freqStep|ppo/,
  );
});
