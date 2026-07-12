/**
 * Types de filtres de l'export OCA interne — validation type-par-type contre
 * l'IR générée par REW (test/fixtures/oca/filter-types.json, chemin
 * historique : Generate filters measurement → fenêtres rectangulaires →
 * trim → getImpulseResponse normalisée).
 *
 * Mesuré à la création (2026-07-12, REW 5.40 B128) : écart max 1.4e-7 sur les
 * 14 types, soit le quantum float32 de l'IR exportée par REW — chaque type
 * reproduit la sortie REW au bit près.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildBiquadCascadeFromRewBank } from '../../src/measurement/rew-filter-bank.js';
import { computeCascadeImpulseResponse } from '../../src/dsp/impulseResponse.js';

const golden = JSON.parse(
  readFileSync('./test/fixtures/oca/filter-types.json', 'utf-8'),
);
// L'IR de référence transite par REW en float32 (quantum 2^-23 ≈ 1.2e-7).
const FLOAT32_QUANTUM = 2.5e-7;

for (const [name, { filter, impulseResponse: reference }] of Object.entries(
  golden.types,
)) {
  test(`type "${name}" identique à l'IR REW`, () => {
    const cascade = buildBiquadCascadeFromRewBank(
      [{ index: 1, enabled: true, isAuto: false, ...filter }],
      golden.sampleRate,
    );
    assert.equal(cascade.length, 1);

    const impulseResponse = computeCascadeImpulseResponse(
      cascade,
      golden.sampleCount,
    );
    // Même normalisation que le générateur du golden : pic à 1 (sans la garde
    // « premier échantillon dominant » des banks complets, un passe-bas seul
    // culminant après l'échantillon 0).
    let peak = 0;
    for (const value of impulseResponse) peak = Math.max(peak, Math.abs(value));

    let maxDiff = 0;
    for (let i = 0; i < reference.length; i++) {
      const diff = Math.abs(impulseResponse[i] / peak - reference[i]);
      if (diff > maxDiff) maxDiff = diff;
    }
    assert.ok(
      maxDiff <= FLOAT32_QUANTUM,
      `${name}: écart max ${maxDiff.toExponential(3)} > ${FLOAT32_QUANTUM}`,
    );
  });
}

// ─── Comportements du mapping propres aux nouveaux types ────────────────────

test('les shelves et Modal à gain quasi nul sont ignorés, pas les LP/HP/Notch', () => {
  const cascade = buildBiquadCascadeFromRewBank(
    [
      { index: 1, type: 'LS', enabled: true, frequency: 100, gaindB: 0 },
      { index: 2, type: 'HS 6dB', enabled: true, frequency: 5000, gaindB: 0.001 },
      { index: 3, type: 'Modal', enabled: true, frequency: 60, gaindB: 0, t60Target: 300 },
      { index: 4, type: 'LP', enabled: true, frequency: 120 },
      { index: 5, type: 'HP1', enabled: true, frequency: 30 },
      { index: 6, type: 'Notch', enabled: true, frequency: 1000 },
    ],
    48000,
  );
  assert.equal(cascade.length, 3);
});

test('un Modal sans t60Target reçoit la valeur par défaut de REW (300)', () => {
  const [withDefault] = buildBiquadCascadeFromRewBank(
    [{ index: 1, type: 'Modal', enabled: true, frequency: 60, gaindB: -6 }],
    48000,
  );
  const [explicit] = buildBiquadCascadeFromRewBank(
    [{ index: 1, type: 'Modal', enabled: true, frequency: 60, gaindB: -6, t60Target: 300 }],
    48000,
  );
  assert.deepEqual(
    { b0: withDefault.b0, b1: withDefault.b1, b2: withDefault.b2 },
    { b0: explicit.b0, b1: explicit.b1, b2: explicit.b2 },
  );
});

test('sérialisation aller-retour des nouveaux types (shelfVariant, t60Target)', async () => {
  const { BiquadFilter } = await import('../../src/dsp/BiquadFilter.js');

  const shelf = new BiquadFilter(48000);
  shelf.setHighShelf(5000, -5, '12dB');
  const shelfCopy = new BiquadFilter(48000);
  shelfCopy.fromJSON(JSON.parse(JSON.stringify(shelf.toJSON())));
  assert.equal(shelfCopy.shelfVariant, '12dB');
  assert.deepEqual(
    { b0: shelfCopy.b0, a1: shelfCopy.a1 },
    { b0: shelf.b0, a1: shelf.a1 },
  );

  const modal = new BiquadFilter(48000);
  modal.setModal(60, -6, 300);
  const modalCopy = new BiquadFilter(48000);
  modalCopy.fromJSON(JSON.parse(JSON.stringify(modal.toJSON())));
  assert.equal(modalCopy.t60Target, 300);
  assert.deepEqual(
    { b0: modalCopy.b0, a1: modalCopy.a1 },
    { b0: modal.b0, a1: modal.a1 },
  );
});
