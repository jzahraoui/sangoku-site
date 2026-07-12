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

import { buildBiquadCascadeFromRewBank } from '../../src/measurement/rew-filter-bank.js';
import {
  computeCascadeImpulseResponse,
  computeNormalizedBankImpulseResponse,
} from '../../src/dsp/impulseResponse.js';

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

test('OCAFileGenerator (chemin interne) reproduit le fichier golden sans REW', async () => {
  const { default: OCAFileGenerator } = await import('../../src/oca-file.js');

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

  const makeItem = (code, spec) => ({
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
  });

  const generator = new OCAFileGenerator(avrFileContent);
  generator.tcName = 'oca-golden-harness';
  const ocaJson = await generator.createOCAFile([
    makeItem('FL', manifest.channels.FL),
    makeItem('SW1', manifest.channels.SW1),
  ]);
  const produced = JSON.parse(ocaJson);

  assert.equal(produced.channels.length, golden.channels.length);
  for (const goldenChannel of golden.channels) {
    const channel = produced.channels.find(
      c => c.channelType === goldenChannel.channelType,
    );
    assert.ok(channel, `canal ${goldenChannel.channelType} manquant`);
    assert.equal(channel.filter.length, goldenChannel.filter.length);
    assert.equal(channel.speakerType, goldenChannel.speakerType);
    assert.equal(channel.distanceInMeters, goldenChannel.distanceInMeters);
    assert.equal(channel.trimAdjustmentInDbs, goldenChannel.trimAdjustmentInDbs);
    assert.equal(channel.xover, goldenChannel.xover);
    let maxDiff = 0;
    for (let i = 0; i < channel.filter.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(channel.filter[i] - goldenChannel.filter[i]));
    }
    assert.ok(
      maxDiff <= GOLDEN_QUANTUM,
      `canal ${goldenChannel.channelType}: écart max ${maxDiff.toExponential(3)}`,
    );
  }
});
