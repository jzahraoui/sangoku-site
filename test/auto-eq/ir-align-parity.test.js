/**
 * Parité de l'implémentation interne de « Align IRs » (src/dsp/ir-align.js)
 * contre l'alignment tool de REW réel — rejoue hors ligne les cas du golden
 * (IR d'entrée incluses) et compare aux résultats enregistrés de REW.
 *
 * Mesuré à la création (2026-07-13, REW 5.40 B128, 21 cas sur 2 systèmes) :
 * Δ délai max 0.062 ms sur les 15 cas acceptés, 0 désaccord d'inversion, et
 * refus des 6 mêmes cas (« Delay too large ») que REW.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { alignImpulseResponses } from '../../src/dsp/ir-align.js';

const golden = JSON.parse(readFileSync('./test/fixtures/ir-align/goldens.json', 'utf-8'));
// REW publie « Delay B ms » à 2 décimales ; l'écart mesuré vient pour
// l'essentiel de là (± quantification) et du raffineur sinc.
const DELAY_TOLERANCE_MS = 0.1;

for (const { a, b, fc, bounds, rew } of golden.cases) {
  const irA = golden.irs[a];
  const irB = golden.irs[b];
  const label = `${a}↔${b} @${fc} Hz [${bounds.join(', ')}]`;

  test(`parité Align IRs — ${label}`, () => {
    const internal = alignImpulseResponses(irA, irB, {
      frequency: fc,
      minDelayMs: bounds[0],
      maxDelayMs: bounds[1],
    });

    if (rew.error) {
      // REW a refusé (« Delay too large ») : l'interne doit refuser aussi.
      assert.equal(
        internal.withinBounds,
        false,
        `${label}: REW refuse mais l'interne accepte ${internal.delayMs.toFixed(3)} ms`,
      );
      return;
    }

    assert.ok(
      Math.abs(internal.delayMs - rew.delayMs) <= DELAY_TOLERANCE_MS,
      `${label}: délai interne ${internal.delayMs.toFixed(3)} ms vs REW ${rew.delayMs} ms`,
    );
    assert.equal(
      internal.invertB,
      rew.invertB,
      `${label}: inversion interne ${internal.invertB} vs REW ${rew.invertB}`,
    );
    assert.equal(internal.withinBounds, true, `${label}: withinBounds attendu`);
  });
}
