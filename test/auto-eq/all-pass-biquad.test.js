/**
 * Biquad all-pass (RBJ) — réalisation DSP du all-pass de l'optimiseur de subs.
 *
 * Vérifie les propriétés définitoires (|H| = 1 partout, −180° à fc, rotation
 * totale de −360°) et la cohérence avec la formule analogique de scoring de
 * l'optimiseur (optimizer/response.js calculateAllPassResponse) sur la bande
 * subwoofer, où la distorsion bilinéaire est négligeable à 48 kHz.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BiquadFilter } from '../../src/dsp/BiquadFilter.js';
import { computeAllPassCoefficients } from '../../src/dsp/biquadCoefficients.js';
import { FILTER_TYPES } from '../../src/dsp/filterTypes.js';
import { calculateAllPassResponse } from '../../src/optimizer/response.js';

const SAMPLE_RATE = 48000;

function makeAllPass(fc, Q) {
  const filter = new BiquadFilter(SAMPLE_RATE);
  filter.setAllPass(fc, Q);
  return filter;
}

test('|H| = 1 à toutes les fréquences (définition du all-pass)', () => {
  const filter = makeAllPass(80, 0.7);
  for (const freq of [5, 20, 40, 80, 160, 500, 2000, 10000, 20000]) {
    const magDb = filter.getMagnitudeDB(freq);
    assert.ok(
      Math.abs(magDb) < 1e-9,
      `|H(${freq})| = ${magDb.toFixed(12)} dB attendu 0`,
    );
  }
});

test('phase = −180° à fc, →0° en BF, →−360° (mod 360) en HF', () => {
  const fc = 60;
  const filter = makeAllPass(fc, 1);

  const phaseAtFc = filter.getPhase(fc);
  assert.ok(
    Math.abs(Math.abs(phaseAtFc) - 180) < 0.5,
    `phase(fc) = ${phaseAtFc.toFixed(2)}° attendu ±180°`,
  );

  const phaseLow = filter.getPhase(1);
  assert.ok(Math.abs(phaseLow) < 3, `phase(1 Hz) = ${phaseLow.toFixed(2)}° attendu ≈ 0`);

  // En HF la rotation totale atteint −360°, soit ≈ 0 en phase repliée
  const phaseHigh = filter.getPhase(5000);
  assert.ok(
    Math.abs(phaseHigh) < 5 || Math.abs(Math.abs(phaseHigh) - 360) < 5,
    `phase(5 kHz) = ${phaseHigh.toFixed(2)}° attendu ≈ 0 (rotation complète)`,
  );
});

test('cohérence avec la formule analogique de l’optimiseur sur la bande sub', () => {
  // Paramètres représentatifs du all-pass de slot 20 (10-120 Hz, Q 0.3-2)
  for (const { fc, Q } of [
    { fc: 40, Q: 0.5 },
    { fc: 60, Q: 1 },
    { fc: 120, Q: 2 },
  ]) {
    const digital = makeAllPass(fc, Q);
    const analog = calculateAllPassResponse(fc, Q);

    for (const freq of [10, 20, 40, 60, 80, 120, 160, 200]) {
      let digitalPhase = digital.getPhase(freq);
      let analogPhase = analog(freq);
      // même repliement pour comparer
      while (digitalPhase - analogPhase > 180) digitalPhase -= 360;
      while (analogPhase - digitalPhase > 180) analogPhase -= 360;
      assert.ok(
        Math.abs(digitalPhase - analogPhase) < 1,
        `fc=${fc} Q=${Q} f=${freq}: numérique ${digitalPhase.toFixed(2)}° vs analogique ${analogPhase.toFixed(2)}°`,
      );
    }
  }
});

test('l’IR d’un all-pass conserve l’énergie unitaire (Parseval)', () => {
  // Impulsion à travers la forme directe I — l'énergie de sortie doit être 1.
  const { a0, a1, a2, b0, b1, b2 } = computeAllPassCoefficients({
    fc: 60,
    Q: 0.7,
    sampleRate: SAMPLE_RATE,
  });
  const n = 65536;
  const output = new Float64Array(n);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < n; i++) {
    const x = i === 0 ? 1 : 0;
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    output[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  let energy = 0;
  for (const value of output) energy += value * value;
  assert.ok(Math.abs(energy - 1) < 1e-6, `énergie IR = ${energy} attendu 1`);
});

test('garde-fous : Nyquist, Q minimal, hasNoEffect', () => {
  assert.throws(
    () => computeAllPassCoefficients({ fc: 30000, Q: 1, sampleRate: SAMPLE_RATE }),
    /Nyquist/,
  );
  assert.throws(
    () => computeAllPassCoefficients({ fc: 60, Q: 0.001, sampleRate: SAMPLE_RATE }),
    /too low/,
  );
  const filter = makeAllPass(60, 0.7);
  assert.equal(filter.filterType, FILTER_TYPES.ALL_PASS);
  assert.equal(filter.hasNoEffect(), false, 'un all-pass agit sur la phase même à gain 0');
  assert.equal(filter.gain, 0);
});

test('round-trip JSON', () => {
  const filter = makeAllPass(90, 1.4);
  const clone = new BiquadFilter(SAMPLE_RATE);
  clone.fromJSON(filter.toJSON());
  assert.equal(clone.filterType, FILTER_TYPES.ALL_PASS);
  for (const freq of [30, 90, 300]) {
    assert.ok(Math.abs(clone.getPhase(freq) - filter.getPhase(freq)) < 1e-9);
  }
});
