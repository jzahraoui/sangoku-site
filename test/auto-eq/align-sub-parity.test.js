/**
 * Parité du chemin interne « mesures filtrées » de Find Sub Alignment
 * (applyBankAndCrossoverToIr + arithmétique de produceAligned) contre le
 * chemin REW de production (eqGenerate + filtres de raccord + offsetTZero) —
 * rejoue hors ligne les cas du golden (IR d'entrée incluses) et compare aux
 * résultats enregistrés du chemin REW.
 *
 * Mesuré à la création (2026-07-13, REW 5.40 B128, 10 cas sur 2 systèmes,
 * variantes inversion / offset t=0 fractionnaire / banks vides / TML) :
 * Δ pic max 0.0087 ms, Δ distance finale max 0.012 ms, 0 désaccord
 * d'inversion.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { alignImpulseResponses } from '../../src/dsp/ir-align.js';
import { applyBankAndCrossoverToIr } from '../../src/measurement/rew-filter-bank.js';
import { combineImpulseResponses } from '../../src/dsp/impulseResponse.js';

const golden = JSON.parse(
  readFileSync('./test/fixtures/align-sub/goldens.json', 'utf-8'),
);

// Pics : parabole interne vs valeur REW après eqGenerate (demi-échantillon à
// 48 kHz = 0.0104 ms). Distance finale : même tolérance que la parité de
// l'aligneur (« Delay B ms » à 2 décimales + raffineur sinc).
const PEAK_TOLERANCE_MS = 0.02;
const FINAL_TOLERANCE_MS = 0.1;

for (const { speaker, sub, fc, speakerBank, subBank, rew } of golden.cases) {
  const label = `${speaker}↔${sub} @${fc} Hz`;

  test(`parité align-sub — ${label}`, () => {
    const speakerFiltered = applyBankAndCrossoverToIr(
      golden.irs[speaker],
      speakerBank,
      { type: 'High pass', frequency: fc, shape: 'BU', slopedBPerOctave: 12 },
    );
    const subFiltered = applyBankAndCrossoverToIr(golden.irs[sub], subBank, {
      type: 'Low pass',
      frequency: fc,
      shape: 'L-R',
      slopedBPerOctave: 24,
    });

    assert.ok(
      Math.abs(speakerFiltered.timeOfIRPeakSeconds - rew.speakerPeak) * 1000 <=
        PEAK_TOLERANCE_MS,
      `${label}: pic enceinte interne ${speakerFiltered.timeOfIRPeakSeconds} vs REW ${rew.speakerPeak}`,
    );
    assert.ok(
      Math.abs(subFiltered.timeOfIRPeakSeconds - rew.subPeak) * 1000 <=
        PEAK_TOLERANCE_MS,
      `${label}: pic sub interne ${subFiltered.timeOfIRPeakSeconds} vs REW ${rew.subPeak}`,
    );

    // arithmétique de produceAligned
    const cutoffPeriod = 1 / fc;
    const delay = cutoffPeriod / 16;
    const maxForwardSearchMs = Math.round((cutoffPeriod / 2) * 1000 * 100) / 100;
    const finalDistance0 =
      subFiltered.timeOfIRPeakSeconds - speakerFiltered.timeOfIRPeakSeconds - delay;
    const shiftedSub = {
      ...subFiltered,
      startTime: subFiltered.startTime - finalDistance0,
    };

    const align = alignImpulseResponses(speakerFiltered, shiftedSub, {
      frequency: fc,
      minDelayMs: 0,
      maxDelayMs: maxForwardSearchMs,
    });

    if (rew.align.error) {
      assert.equal(
        align.withinBounds,
        false,
        `${label}: le chemin REW refuse mais l'interne accepte`,
      );
      return;
    }

    assert.equal(
      align.invertB,
      rew.align.invertB,
      `${label}: inversion interne ${align.invertB} vs chemin REW ${rew.align.invertB}`,
    );
    const finalDistanceSeconds = finalDistance0 - align.delayMs / 1000;
    assert.ok(
      Math.abs(finalDistanceSeconds - rew.finalDistanceSeconds) * 1000 <=
        FINAL_TOLERANCE_MS,
      `${label}: distance finale interne ${(finalDistanceSeconds * 1000).toFixed(3)} ms ` +
        `vs chemin REW ${(rew.finalDistanceSeconds * 1000).toFixed(3)} ms`,
    );
  });
}

// « Somme vraie » multi-sub : Σ pondérée (splOffsetdB) des IR predicted des
// subs + raccord interne, contre le chemin prod complet (projection
// synthétisée + eqGenerate + raccord REW). Mesuré à la génération :
// Δ distance finale ≤ 0.002 ms sur 3 cas (2 subs à niveaux/offsets
// différents, 4 subs, 1 sub).
for (const { label, fc, subCount, weightsDb, rew } of golden.sumCases ?? []) {
  test(`parité align-sub — somme vraie ${label} (${subCount} subs) @${fc} Hz`, () => {
    const speakerFiltered = applyBankAndCrossoverToIr(
      golden.irs[`sum.${label}.speaker`],
      [],
      { type: 'High pass', frequency: fc, shape: 'BU', slopedBPerOctave: 12 },
    );
    const eqIrs = Array.from(
      { length: subCount },
      (_, i) => golden.irs[`sum.${label}.sub${i}`],
    );
    const subFiltered = applyBankAndCrossoverToIr(
      combineImpulseResponses(eqIrs, weightsDb),
      [],
      { type: 'Low pass', frequency: fc, shape: 'L-R', slopedBPerOctave: 24 },
    );

    const cutoffPeriod = 1 / fc;
    const delay = cutoffPeriod / 16;
    const maxForwardSearchMs = Math.round((cutoffPeriod / 2) * 1000 * 100) / 100;
    const finalDistance0 =
      subFiltered.timeOfIRPeakSeconds - speakerFiltered.timeOfIRPeakSeconds - delay;
    const shiftedSub = {
      ...subFiltered,
      startTime: subFiltered.startTime - finalDistance0,
    };

    const align = alignImpulseResponses(speakerFiltered, shiftedSub, {
      frequency: fc,
      minDelayMs: 0,
      maxDelayMs: maxForwardSearchMs,
    });

    if (rew.align.error) {
      assert.equal(align.withinBounds, false, `${label}: refus attendu`);
      return;
    }
    assert.equal(align.invertB, rew.align.invertB, `${label}: inversion`);
    const finalDistanceSeconds = finalDistance0 - align.delayMs / 1000;
    assert.ok(
      Math.abs(finalDistanceSeconds - rew.finalDistanceSeconds) * 1000 <=
        FINAL_TOLERANCE_MS,
      `${label}: distance finale somme vraie ${(finalDistanceSeconds * 1000).toFixed(3)} ms ` +
        `vs chemin prod ${(rew.finalDistanceSeconds * 1000).toFixed(3)} ms`,
    );
  });
}
