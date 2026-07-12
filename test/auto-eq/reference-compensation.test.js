/**
 * Compensation de référentiel (phase 1 du plan qualité audio).
 *
 * 1. Tests unitaires des helpers purs (src/measurement/reference-compensation.js).
 * 2. Bout en bout sur le corpus test/fixtures/ady/ : des filtres calculés sur
 *    la courbe fenêtrée MTW puis appliqués à la courbe brute dépassent la
 *    cible (biais mesuré) ; avec la cible recalée de l'offset mesuré, le
 *    predicted retombe sur la cible.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyTargetOffset,
  applyTargetProfile,
  computeReferenceOffset,
  computeReferenceProfile,
  meanProfileOffset,
} from '../../src/measurement/reference-compensation.js';
import { AutoEQCalculator } from '../../src/index.js';
import { parseREWFile, toFrequencyResponse, createConfig } from './test-config.js';
import { variableSmoothMagnitude } from './perceptual-metrics.js';

// ─── Helpers purs ────────────────────────────────────────────────────────────

test('computeReferenceOffset: moyenne exacte sur grilles identiques', () => {
  const freqs = [100, 200, 400, 800];
  const reference = { freqs, magnitude: [80, 82, 84, 86] };
  const working = { freqs, magnitude: [78, 80, 82, 84] };
  assert.equal(computeReferenceOffset(reference, working, 50, 1000), 2);
  // bande partielle
  assert.equal(computeReferenceOffset(reference, working, 150, 500), 2);
});

test('computeReferenceOffset: grilles décalées → lookup par fréquence la plus proche', () => {
  const reference = { freqs: [100, 200, 400], magnitude: [80, 80, 80] };
  const working = { freqs: [90, 210, 390, 800], magnitude: [79, 79, 79, 0] };
  const offset = computeReferenceOffset(reference, working, 50, 500);
  assert.ok(Math.abs(offset - 1) < 1e-12, `offset=${offset}`);
});

test('computeReferenceOffset: entrées vides ou bande sans point → 0', () => {
  const response = { freqs: [100], magnitude: [80] };
  assert.equal(computeReferenceOffset(null, response, 20, 20000), 0);
  assert.equal(computeReferenceOffset(response, { freqs: [], magnitude: [] }, 20, 20000), 0);
  assert.equal(computeReferenceOffset(response, response, 500, 1000), 0);
});

test('applyTargetOffset: décale sans muter', () => {
  const target = { freqs: [100, 200], magnitude: [75, 75], ppo: 96 };
  const shifted = applyTargetOffset(target, -1.5);
  assert.deepEqual(Array.from(shifted.magnitude), [73.5, 73.5]);
  assert.deepEqual(target.magnitude, [75, 75]);
  assert.equal(shifted.ppo, 96);
});

// ─── Profil D(f) ─────────────────────────────────────────────────────────────

function ppoGrid(startFreq, endFreq, ppo = 96) {
  const freqs = [];
  const mult = Math.pow(2, 1 / ppo);
  for (let f = startFreq; f <= endFreq; f *= mult) freqs.push(f);
  return freqs;
}

test('computeReferenceProfile: écart constant → profil constant', () => {
  const freqs = ppoGrid(20, 20000);
  const reference = { freqs, magnitude: freqs.map(() => 75) };
  const working = { freqs, magnitude: freqs.map(() => 73) };
  const profile = computeReferenceProfile(reference, working);
  for (const value of profile.offset) {
    assert.ok(Math.abs(value - 2) < 1e-9);
  }
  assert.ok(Math.abs(meanProfileOffset(profile, 20, 20000) - 2) < 1e-9);
});

test('computeReferenceProfile: D(f) dépendant de la fréquence est suivi, détails lissés', () => {
  const freqs = ppoGrid(20, 20000);
  // D = 0 sous 300 Hz, 2 dB au-dessus de 1 kHz, transition log entre les deux,
  // plus une ondulation fine (1/12 oct) que le lissage 1 octave doit gommer.
  const dOf = f =>
    f <= 300 ? 0 : f >= 1000 ? 2 : (2 * Math.log(f / 300)) / Math.log(1000 / 300);
  const reference = { freqs, magnitude: freqs.map(() => 80) };
  const working = {
    freqs,
    magnitude: freqs.map((f, i) => 80 - dOf(f) + 0.8 * Math.sin(i / 1.3)),
  };
  const profile = computeReferenceProfile(reference, working);

  const at = f => {
    let best = 0;
    for (let i = 0; i < profile.freqs.length; i++) {
      if (Math.abs(profile.freqs[i] - f) < Math.abs(profile.freqs[best] - f)) best = i;
    }
    return profile.offset[best];
  };
  assert.ok(Math.abs(at(50)) < 0.25, `D(50)=${at(50).toFixed(2)} attendu ≈ 0`);
  assert.ok(Math.abs(at(5000) - 2) < 0.25, `D(5k)=${at(5000).toFixed(2)} attendu ≈ 2`);
  // l'ondulation fine ne doit pas survivre au lissage
  let maxRipple = 0;
  for (let i = 1; i < profile.offset.length; i++) {
    maxRipple = Math.max(maxRipple, Math.abs(profile.offset[i] - profile.offset[i - 1]));
  }
  assert.ok(maxRipple < 0.1, `ripple point à point ${maxRipple.toFixed(3)} attendu < 0.1`);
});

test('applyTargetProfile: soustrait le profil par fréquence sans muter', () => {
  const profile = { freqs: [100, 1000, 10000], offset: [0, 1, 2] };
  const target = { freqs: [90, 1100, 9000], magnitude: [75, 75, 75], ppo: 96 };
  const adjusted = applyTargetProfile(target, profile);
  assert.deepEqual(Array.from(adjusted.magnitude), [75, 74, 73]);
  assert.deepEqual(target.magnitude, [75, 75, 75]);
  assert.equal(adjusted.ppo, 96);
});

test('computeReferenceProfile: entrées invalides → null', () => {
  const response = { freqs: [100], magnitude: [80] };
  assert.equal(computeReferenceProfile(null, response), null);
  assert.equal(computeReferenceProfile(response, { freqs: [], magnitude: [] }), null);
});

// ─── Bout en bout sur le corpus ──────────────────────────────────────────────

const CASES = [
  { system: 'kef-3pos', channel: 'FL' },
  { system: 'barmatic-6pos', channel: 'C' },
];

function loadResponse(system, channel, suffix) {
  return toFrequencyResponse(
    parseREWFile(`./test/fixtures/ady/${system}/${channel}_rms-avg_${suffix}.txt`),
  );
}

function predictedStats(calculator, raw, target, startFreq, endFreq) {
  let count = 0;
  let sum = 0;
  let squaredSum = 0;
  let positiveSquaredSum = 0;
  for (let i = 0; i < raw.freqs.length; i++) {
    const freq = raw.freqs[i];
    if (freq < startFreq || freq > endFreq) continue;
    const eq = calculator.filterSet.getCumulativeComplexResponse(freq).magnitudeDB;
    const error = raw.magnitude[i] + eq - target.magnitude[i];
    sum += error;
    squaredSum += error * error;
    if (error > 0) positiveSquaredSum += error * error;
    count++;
  }
  return {
    mean: sum / count,
    rms: Math.sqrt(squaredSum / count),
    positiveRms: Math.sqrt(positiveSquaredSum / count),
  };
}

for (const { system, channel } of CASES) {
  test(`corpus ${system}/${channel}: la compensation ramène le predicted sur la cible`, async () => {
    const working = loadResponse(system, channel, 'mtw');
    const raw = loadResponse(system, channel, 'raw');

    // Cible réaliste : la brute fortement lissée (1 octave) — suit la forme
    // large de la pièce, niveau calé sur la brute (comme Align SPL sur la
    // moyenne brute). C'est la configuration qui produit le dépassement.
    const target = {
      freqs: raw.freqs,
      magnitude: variableSmoothMagnitude(raw.freqs, raw.magnitude, {
        lowFraction: 1,
        highFraction: 1,
        lowFreq: 100,
        highFreq: 10000,
      }),
    };

    const profile = computeReferenceProfile(raw, working);
    const meanOffset = meanProfileOffset(profile, 300, 3000);
    assert.ok(
      meanOffset > 0.3,
      `${system}/${channel}: D(300-3000)=${meanOffset.toFixed(2)} attendu > 0.3`,
    );

    // Sans compensation : filtres dosés sur la MTW, jugés sur la brute.
    // Le biais se manifeste selon la pièce : soit en overshoots (les boosts se
    // reportent sur la brute plus haute — kef), soit en cuts refusés (les pics
    // réels ne dépassent plus la cible dans la courbe fenêtrée — barmatic).
    const uncompensated = new AutoEQCalculator(createConfig({}, { silent: true }));
    await uncompensated.calculate(working, target);
    const biased = predictedStats(uncompensated, raw, target, 300, 3000);
    const biasedBass = predictedStats(uncompensated, raw, target, 40, 300);

    // Avec compensation D(f) : cible recalée du profil mesuré
    const compensated = new AutoEQCalculator(createConfig({}, { silent: true }));
    await compensated.calculate(working, applyTargetProfile(target, profile));
    const centered = predictedStats(compensated, raw, target, 300, 3000);
    const centeredBass = predictedStats(compensated, raw, target, 40, 300);

    // Valeurs mesurées (2026-07-12, profil par bandes) :
    //   kef      : posRMS mid 1.58→0.83, RMS mid 2.51→2.24, posRMS BF 0.73→0.44
    //   barmatic : posRMS mid 0.98→0.70, RMS mid 1.82→2.18, posRMS BF 0.51→0.42
    // Le dépassement de cible (l'objet du défaut) chute nettement ; le RMS
    // complet peut fluctuer (réallocation du budget de filtres).
    assert.ok(
      centered.positiveRms < biased.positiveRms - 0.15,
      `${system}/${channel}: posRMS mid compensé=${centered.positiveRms.toFixed(2)} dB doit battre le biaisé=${biased.positiveRms.toFixed(2)} dB`,
    );
    assert.ok(
      centered.rms < biased.rms + 0.5,
      `${system}/${channel}: RMS mid compensé=${centered.rms.toFixed(2)} dB ne doit pas s'éloigner du biaisé=${biased.rms.toFixed(2)} dB`,
    );
    assert.ok(
      centeredBass.positiveRms < biasedBass.positiveRms + 0.1,
      `${system}/${channel}: posRMS BF compensé=${centeredBass.positiveRms.toFixed(2)} dB ne doit pas dépasser le biaisé=${biasedBass.positiveRms.toFixed(2)} dB`,
    );
  });
}

test('corpus kef-3pos/FL: la pente descendante de la cible est transmise au predicted', async () => {
  const working = loadResponse('kef-3pos', 'FL', 'mtw');
  const raw = loadResponse('kef-3pos', 'FL', 'raw');
  const smooth = variableSmoothMagnitude(raw.freqs, raw.magnitude, {
    lowFraction: 1,
    highFraction: 1,
  });

  // Cible descendante douce : −1 dB/décade au-dessus de 500 Hz — plus faible
  // que D(f) HF, donc totalement masquée par le biais sans compensation.
  const tilt = f => (f > 500 ? -Math.log10(f / 500) : 0);
  const target = {
    freqs: raw.freqs,
    magnitude: smooth.map((v, i) => v + tilt(raw.freqs[i])),
  };

  const profile = computeReferenceProfile(raw, working);

  const uncompensated = new AutoEQCalculator(createConfig({}, { silent: true }));
  await uncompensated.calculate(working, target);
  const biased = predictedStats(uncompensated, raw, target, 3000, 12000);

  const compensated = new AutoEQCalculator(createConfig({}, { silent: true }));
  await compensated.calculate(working, applyTargetProfile(target, profile));
  const centered = predictedStats(compensated, raw, target, 3000, 12000);

  // Valeurs mesurées (2026-07-12, profil par bandes) : sans = +1.24 dB
  // (pente ignorée, predicted au-dessus de la cible inclinée),
  // compensé = −0.74 dB (pente transmise, légère sur-correction résiduelle).
  assert.ok(
    Math.abs(centered.mean) < Math.abs(biased.mean) - 0.3,
    `pente: compensé=${centered.mean.toFixed(2)} dB doit suivre la cible nettement mieux que non compensé=${biased.mean.toFixed(2)} dB`,
  );
  assert.ok(
    Math.abs(centered.mean) < 1.0,
    `pente: compensé=${centered.mean.toFixed(2)} dB attendu < 1 dB de la cible`,
  );
});
