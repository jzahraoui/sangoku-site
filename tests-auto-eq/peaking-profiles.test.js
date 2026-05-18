import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createPeakingProfile,
  createPeakingProfiles,
  sumProfilesDbAtFrequency,
} from '../src/dsp/peakingProfiles.js';

const SR = 48000;

test('createPeakingProfile returns null when gain ≈ 0', () => {
  assert.equal(createPeakingProfile(1000, 2, 0, SR), null);
  assert.equal(createPeakingProfile(1000, 2, 0.0005, SR), null);
});

test('createPeakingProfile returns null when Q <= 0', () => {
  assert.equal(createPeakingProfile(1000, 0, 6, SR), null);
  assert.equal(createPeakingProfile(1000, -1, 6, SR), null);
});

test('createPeakingProfile returns finite profile for active filter', () => {
  const p = createPeakingProfile(1000, 2, -6, SR);
  assert.ok(p !== null);
  for (const [key, val] of Object.entries(p)) {
    assert.ok(Number.isFinite(val), `profile.${key} is not finite: ${val}`);
  }
});

test('sumProfilesDbAtFrequency([]) returns 0', () => {
  assert.equal(sumProfilesDbAtFrequency([], 1000, SR), 0);
});

test('boost at fc gives positive dB', () => {
  const fc = 1000;
  const profiles = createPeakingProfiles([{ fc, Q: 2, gain: 6 }], SR);
  const result = sumProfilesDbAtFrequency(profiles, fc, SR);
  assert.ok(result > 0, `expected positive dB, got ${result}`);
});

test('cut at fc gives negative dB', () => {
  const fc = 1000;
  const profiles = createPeakingProfiles([{ fc, Q: 2, gain: -6 }], SR);
  const result = sumProfilesDbAtFrequency(profiles, fc, SR);
  assert.ok(result < 0, `expected negative dB, got ${result}`);
});
