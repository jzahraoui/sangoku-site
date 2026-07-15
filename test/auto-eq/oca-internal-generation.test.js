/**
 * Génération interne de l'IR des filtres OCA — validation contre le golden
 * du chemin historique (test/fixtures/oca/, généré via REW réel).
 *
 * Mesuré à la création (2026-07-12) : écart max 5e-8 sur les deux canaux,
 * soit exactement le quantum d'enregistrement du golden (7 décimales) — la
 * cascade interne reproduit la sortie REW au bit près.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildBiquadCascadeFromRewBank,
  buildCrossoverCascade,
} from '../../src/measurement/rew-filter-bank.js';
import {
  computeCascadeImpulseResponse,
  computeNormalizedBankImpulseResponse,
  processThroughCascade,
} from '../../src/dsp/impulseResponse.js';
import { getCascadeComplexResponse } from '../../src/dsp/biquadResponse.js';

const manifest = JSON.parse(readFileSync('./test/fixtures/oca/manifest.json', 'utf-8'));
const golden = JSON.parse(
  readFileSync('./test/fixtures/oca/kef-fl-sw1.oca.json', 'utf-8'),
);
const GAIN_ADJUSTMENT = Math.pow(10, -0.35);
const GOLDEN_QUANTUM = 1e-7; // le golden est enregistré avec toFixed(7)

const CHANNEL_INDEXES = { FL: 0, SW1: 59 };

for (const [code, spec] of Object.entries(manifest.channels)) {
  test(`IR interne identique au golden REW — ${code} (${spec.bank.length} filtres${code === 'SW1' ? ', dont all-pass slot 20' : ''})`, () => {
    const goldenChannel = golden.channels.find(
      channel => channel.channelType === CHANNEL_INDEXES[code],
    );
    assert.ok(goldenChannel, `canal ${code} absent du golden`);

    const cascade = buildBiquadCascadeFromRewBank(spec.bank, spec.filterSpec.frequency);
    const impulseResponse = computeNormalizedBankImpulseResponse(
      cascade,
      spec.filterSpec.samples,
    );

    assert.equal(impulseResponse.length, goldenChannel.filter.length);
    let maxDiff = 0;
    for (let i = 0; i < impulseResponse.length; i++) {
      const diff = Math.abs(impulseResponse[i] * GAIN_ADJUSTMENT - goldenChannel.filter[i]);
      if (diff > maxDiff) maxDiff = diff;
    }
    assert.ok(
      maxDiff <= GOLDEN_QUANTUM,
      `${code}: écart max ${maxDiff.toExponential(3)} > quantum du golden ${GOLDEN_QUANTUM}`,
    );
  });
}

// ─── Mapping du bank ─────────────────────────────────────────────────────────

test('le mapping ignore les slots None/désactivés/gain nul', () => {
  const cascade = buildBiquadCascadeFromRewBank(
    [
      { index: 1, type: 'PK', enabled: true, frequency: 100, q: 4, gaindB: -3 },
      { index: 2, type: 'None', enabled: true },
      { index: 3, type: 'PK', enabled: false, frequency: 200, q: 4, gaindB: -3 },
      { index: 4, type: 'PK', enabled: true, frequency: 300, q: 4, gaindB: 0 },
      { index: 20, type: 'All pass', enabled: true, frequency: 60, q: 0.7 },
    ],
    48000,
  );
  assert.equal(cascade.length, 2); // PK actif + all-pass
});

test('un type actif non réalisable lève une erreur explicite avec le slot', () => {
  assert.throws(
    () =>
      buildBiquadCascadeFromRewBank(
        [{ index: 21, type: 'Low pass', enabled: true, frequency: 120, q: 0.7 }],
        48000,
      ),
    /Unsupported filter type "Low pass" at slot 21/,
  );
});

test('un bank vide produit une impulsion unité', () => {
  const impulseResponse = computeCascadeImpulseResponse([], 16);
  assert.equal(impulseResponse[0], 1);
  for (let i = 1; i < 16; i++) assert.equal(impulseResponse[i], 0);
});

// ─── Générateur OCA complet, hors ligne, contre le golden ───────────────────

const avrFileContent = {
  targetModelName: 'Denon AVC-A1H',
  enMultEQType: 2,
  title: 'kef.4sub.3pos',
  enAmpAssignType: 6,
  ampAssignInfo: 'x',
  detectedChannels: [
    { enChannelType: 0, commandId: 'FL', responseData: {} },
    { enChannelType: 59, commandId: 'SW1', responseData: {} },
  ],
  avr: {
    multEQSpecs: {
      speakerFilter: manifest.channels.FL.filterSpec,
      subFilter: manifest.channels.SW1.filterSpec,
    },
  },
};

const makeItem = (code, spec, overrides = {}) => ({
  haveImpulseResponse: true,
  isSub: () => code === 'SW1',
  inverted: () => false,
  channelName: () => code,
  channelDetails: () => ({ channelIndex: CHANNEL_INDEXES[code], group: code === 'SW1' ? 'Subwoofer' : 'Front' }),
  speakerType: () => spec.speakerType,
  distanceInMeters: () => spec.distance,
  splForAvr: () => spec.trim,
  crossover: () => spec.crossover,
  splIsAboveLimit: () => false,
  exceedsDistance: () => 'ok',
  displayMeasurementTitle: () => code,
  getFilters: async () => spec.bank,
  ...overrides,
});

// Ancrage REW réel de la FIR produite (FIR du bank ⊛ BW12 électrique au
// crossover), par chaîne — pas de fixture dédiée : depuis le passage à la
// génération interne, relancer le harnais golden ne produirait plus de
// référence REW indépendante :
//   1. FIR du bank seul == chemin REW historique (golden kef-fl-sw1.oca.json,
//      quantum float32) ;
//   2. biquad setHighPass == type « HP » de REW (filter-types.json, quantum
//      float32) ;
//   3. dans REW (5.40 B128, sondé) : type « HP » == filtre de raccord
//      « High pass BU 12 » (Δ = 0, bit-exact) et « High pass L-R 24 » ==
//      2× « High pass BU 12 » (Δ = 0) — sonde versionnée
//      test/auto-eq/rew/probe-hp-lr24.mjs (REW réel requis) ;
//   4. FIR produite = FIR du bank ⊛ setHighPass (composition exacte, vérifiée
//      ci-dessous au double-quantum du golden).

test('OCAFileGenerator : FIR enceinte = golden ⊛ BW12(fc), sub identique au golden', async () => {
  const { default: OCAFileGenerator } = await import('../../src/oca-file.js');

  const generator = new OCAFileGenerator(avrFileContent);
  generator.tcName = 'oca-golden-harness';
  const produced = JSON.parse(
    await generator.createOCAFile([
      makeItem('FL', manifest.channels.FL),
      makeItem('SW1', manifest.channels.SW1),
    ]),
  );
  assert.equal(produced.channels.length, golden.channels.length);

  // Sub (crossover 0) : strictement identique au golden.
  const sub = produced.channels.find(c => c.channelType === CHANNEL_INDEXES.SW1);
  const goldenSub = golden.channels.find(c => c.channelType === CHANNEL_INDEXES.SW1);
  assert.deepEqual(sub.filter, goldenSub.filter);
  assert.equal(sub.speakerType, goldenSub.speakerType);
  assert.equal(sub.distanceInMeters, goldenSub.distanceInMeters);
  assert.equal(sub.trimAdjustmentInDbs, goldenSub.trimAdjustmentInDbs);

  // Enceinte : FIR = FIR golden ⊛ BW12(fc) — le BW12 est appliqué après la
  // normalisation pic=1, le gain (scalaire) commute avec la convolution.
  const speaker = produced.channels.find(c => c.channelType === CHANNEL_INDEXES.FL);
  const goldenSpeaker = golden.channels.find(c => c.channelType === CHANNEL_INDEXES.FL);
  assert.equal(speaker.speakerType, goldenSpeaker.speakerType);
  assert.equal(speaker.distanceInMeters, goldenSpeaker.distanceInMeters);
  assert.equal(speaker.trimAdjustmentInDbs, goldenSpeaker.trimAdjustmentInDbs);
  assert.equal(speaker.xover, goldenSpeaker.xover);
  const fc = manifest.channels.FL.crossover;
  const electricalCascade = buildCrossoverCascade(
    { type: 'High pass', frequency: fc, shape: 'BU', slopedBPerOctave: 12 },
    manifest.channels.FL.filterSpec.frequency,
  );
  const expected = processThroughCascade(
    Float64Array.from(goldenSpeaker.filter),
    electricalCascade,
  );
  assert.equal(speaker.filter.length, goldenSpeaker.filter.length);
  let maxDiff = 0;
  for (let i = 0; i < speaker.filter.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(speaker.filter[i] - expected[i]));
  }
  // deux arrondis toFixed(7) en cascade (golden + sortie produite)
  assert.ok(maxDiff <= 2 * GOLDEN_QUANTUM, `écart max ${maxDiff.toExponential(3)}`);

  // Le générateur trace les canaux réellement traités — c'est la source
  // unique des logs de l'appelant (exports.js), émis après génération.
  assert.deepEqual(generator.electricalHighPassChannels, [
    { channelName: 'FL', crossover: fc },
  ]);

  // Sanité fréquentielle du BW12 ajouté : −3 dB à fc, ~−12 dB/oct sous fc,
  // ~0 dB dans la bande passante.
  const magDbAt = f => {
    const h = getCascadeComplexResponse(electricalCascade, f, 48000);
    return 20 * Math.log10(Math.hypot(h.re, h.im));
  };
  assert.ok(Math.abs(magDbAt(fc) - -3.01) < 0.05, `à fc: ${magDbAt(fc)}`);
  assert.ok(Math.abs(magDbAt(fc / 2) - magDbAt(fc / 4) - 12) < 1.5, 'pente sous fc');
  assert.ok(Math.abs(magDbAt(fc * 8)) < 0.1, 'bande passante');
});

test('enceinte Large (crossover 0) : pas de BW12, FIR identique au golden', async () => {
  const { default: OCAFileGenerator } = await import('../../src/oca-file.js');

  const generator = new OCAFileGenerator(avrFileContent);
  generator.tcName = 'oca-golden-harness';
  const produced = JSON.parse(
    await generator.createOCAFile([
      makeItem('FL', manifest.channels.FL, {
        crossover: () => 0,
        speakerType: () => 'L',
      }),
      makeItem('SW1', manifest.channels.SW1),
    ]),
  );

  const speaker = produced.channels.find(c => c.channelType === CHANNEL_INDEXES.FL);
  const goldenSpeaker = golden.channels.find(c => c.channelType === CHANNEL_INDEXES.FL);
  // même bank, pas de BW12 → FIR identique au golden ; pas de champ xover
  assert.deepEqual(speaker.filter, goldenSpeaker.filter);
  assert.equal(speaker.xover, undefined);
  assert.equal(speaker.speakerType, 'L');
  assert.deepEqual(generator.electricalHighPassChannels, []);
});

test('crossover non numérique : traité comme Large — export réussi, pas de BW12 ni xover', async () => {
  // Avant le BW12 électrique, un crossover undefined ne nourrissait que le
  // champ optionnel xover (silencieusement omis) : l'export réussissait. La
  // garde Number.isFinite préserve cette tolérance au lieu de faire échouer
  // tout l'export dans setHighPass(undefined).
  const { default: OCAFileGenerator } = await import('../../src/oca-file.js');

  const generator = new OCAFileGenerator(avrFileContent);
  generator.tcName = 'oca-golden-harness';
  const produced = JSON.parse(
    await generator.createOCAFile([
      makeItem('FL', manifest.channels.FL, { crossover: () => undefined }),
      makeItem('SW1', manifest.channels.SW1),
    ]),
  );

  const speaker = produced.channels.find(c => c.channelType === CHANNEL_INDEXES.FL);
  const goldenSpeaker = golden.channels.find(c => c.channelType === CHANNEL_INDEXES.FL);
  assert.deepEqual(speaker.filter, goldenSpeaker.filter);
  assert.equal(speaker.xover, undefined);
  assert.deepEqual(generator.electricalHighPassChannels, []);
});
