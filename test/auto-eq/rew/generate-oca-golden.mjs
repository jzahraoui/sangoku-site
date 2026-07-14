/**
 * generate-oca-golden.mjs — harnais du chantier « export OCA interne ».
 *
 * Génère un fichier OCA de référence avec le CODE ACTUEL (chemin REW :
 * generateFilterMeasurement → fenêtres → trim → getImpulseResponse) sur des
 * données déterministes, pour vérifier que la future génération interne (DSP)
 * produit exactement le même résultat.
 *
 * Déroulé (REW réel requis, WSL : WINDOWS_HOST) :
 *   1. importe l'IR position 1 de FL (enceinte) et SW1 (sub) depuis l'ADY de
 *      référence ;
 *   2. pose un bank de filtres DÉTERMINISTE sur chaque canal (PK pour
 *      l'enceinte ; PK + all-pass slot 20 pour le sub — le cas critique) ;
 *   3. exécute OCAFileGenerator.createsFilters à travers les services réels
 *      (createMeasurementOperations) via des adaptateurs minces ;
 *   4. écrit le fichier OCA + un manifeste (banks posés, specs AVR) dans
 *      test/fixtures/oca/ ;
 *   5. supprime toutes les mesures créées dans REW.
 *
 * Usage :
 *   WINDOWS_HOST=… node test/auto-eq/rew/generate-oca-golden.mjs \
 *     "work/Denon AVC-A1H_kef.4sub.3pos.ady" test/fixtures/oca
 */

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import RewApi from '../../../src/rew/rew-api.js';
import OCAFileGenerator from '../../../src/oca-file.js';
import AvrCaracteristics from '../../../src/avr-caracteristics.js';
import { CHANNEL_TYPES } from '../../../src/audyssey.js';
import { createMeasurementOperations } from '../../../src/services/measurement-operations.js';
import { getWindowsHostIP } from '../test-config.js';

// Empêche un argument CLI malveillant (ex. via un agent LLM) de sortir du
// dossier d'invocation : canonicalise le chemin puis vérifie qu'il reste
// à l'intérieur du répertoire de travail courant.
function safePath(target) {
  const baseDir = realpathSync(process.cwd());
  let resolved;
  try {
    resolved = realpathSync(target); // résout liens symboliques et « .. »
  } catch {
    resolved = path.resolve(baseDir, target); // cible pas encore créée (sortie)
  }
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    throw new Error(`path '${target}' is outside the allowed directory`);
  }
  return resolved;
}

const [, , adyPathArg, outDirArg] = process.argv;
if (!adyPathArg || !outDirArg) {
  console.error('Usage: node generate-oca-golden.mjs <fichier.ady> <dossier-sortie>');
  process.exit(1);
}
const adyPath = safePath(adyPathArg);
const outDir = safePath(outDirArg);

// Banks déterministes — couvrent PK multiples et le all-pass slot 20 des subs.
const SPEAKER_BANK = [
  { index: 1, type: 'PK', enabled: true, isAuto: true, frequency: 62.5, q: 4.5, gaindB: -6.2 },
  { index: 2, type: 'PK', enabled: true, isAuto: true, frequency: 118, q: 7.5, gaindB: 6 },
  { index: 3, type: 'PK', enabled: true, isAuto: true, frequency: 476, q: 1.9, gaindB: 4.1 },
  { index: 4, type: 'PK', enabled: true, isAuto: true, frequency: 1503, q: 3.2, gaindB: -3.7 },
  { index: 5, type: 'PK', enabled: true, isAuto: true, frequency: 5883, q: 5.3, gaindB: 2.4 },
];
const SUB_BANK = [
  { index: 1, type: 'PK', enabled: true, isAuto: false, frequency: 45.5, q: 5, gaindB: -4 },
  { index: 2, type: 'PK', enabled: true, isAuto: false, frequency: 63, q: 8, gaindB: -8.5 },
  { index: 20, type: 'All pass', enabled: true, isAuto: false, frequency: 60, q: 0.7 },
];

const rew = new RewApi(`http://${getWindowsHostIP()}:4735`);
const ops = createMeasurementOperations({
  log: { debug: () => {}, info: m => console.log(`  [ops] ${m}`), warn: m => console.warn(`  [ops] ${m}`), error: console.error },
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const created = [];

async function listUuids() {
  const all = await rew.request('/measurements');
  return new Set(Object.values(all ?? {}).map(m => m.uuid));
}

async function waitForNewMeasurement(before, label, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const all = await rew.request('/measurements');
    const entry = Object.values(all ?? {}).find(m => !before.has(m.uuid));
    if (entry) return entry.uuid;
    await sleep(300);
  }
  throw new Error(`Timeout waiting for measurement: ${label}`);
}

/**
 * Adaptateur minimal exposant la surface MeasurementItem consommée par
 * OCAFileGenerator et par les opérations qu'il déclenche. Toute la logique
 * réelle passe par createMeasurementOperations — l'adaptateur ne fait que
 * porter l'état (uuid, titre) et relier session/ops.
 */
function makeAdapter(uuid, title, { isFilter = false } = {}) {
  const adapter = {
    uuid,
    title: () => title,
    displayMeasurementTitle: () => title,
    notes: '',
    isFilter,
    haveImpulseResponse: true,
    sampleRate: 48000,
    inverted: () => false,
    timeOfIRPeakSeconds: 0,
    splOffsetdB: 0,
    initialSplOffsetdB: 0,
    alignSPLOffsetdB: 0,
    splresidual: 0,
    update(partial) {
      if (partial.title !== undefined) {
        const value = partial.title;
        adapter.title = () => value;
        adapter.displayMeasurementTitle = () => value;
      }
      if (partial.inverted !== undefined) adapter.inverted = () => partial.inverted;
      if (partial.sampleRate !== undefined) adapter.sampleRate = partial.sampleRate;
    },
    // surface OCAFileGenerator/ops
    setIrWindows: windows => ops.setIrWindows(rew.rewMeasurements, adapter, windows),
    setInverted: value => ops.setInverted(rew.rewMeasurements, adapter, value),
    trimIRToWindows: () => ops.trimIRToWindows(rew.rewMeasurements, adapter, session),
    getImpulseResponse: (freq, unit, windowed, normalised) =>
      ops.getImpulseResponse(rew.rewMeasurements, adapter, { freq, unit, windowed, normalised }),
    generateFilterMeasurement: () =>
      ops.generateFilterMeasurement(rew.rewMeasurements, adapter, session),
    delete: async () => {
      await rew.request(`/measurements/${adapter.uuid}`, 'DELETE');
      created.splice(created.indexOf(adapter.uuid), 1);
    },
  };
  return adapter;
}

// Session minimale : analyseApiResponse détecte la nouvelle mesure créée par
// la dernière commande REW et l'enveloppe dans un adaptateur.
let knownUuids = new Set();
const session = {
  async analyseApiResponse(response) {
    const uuid = await waitForNewMeasurement(knownUuids, JSON.stringify(response).slice(0, 60));
    knownUuids.add(uuid);
    created.push(uuid);
    return makeAdapter(uuid, `generated-${uuid.slice(0, 8)}`, { isFilter: true });
  },
  removeMeasurements: async items => {
    for (const item of items) await item.delete();
  },
  removeMeasurementUuid: async uuid => {
    await rew.request(`/measurements/${uuid}`, 'DELETE');
    const at = created.indexOf(uuid);
    if (at >= 0) created.splice(at, 1);
  },
  findMeasurementByUuid: () => null,
};

function channelItem(adapter, code, { channelIndex, crossover, speakerType, distance, trim }) {
  // Plusieurs entrées CHANNEL_TYPES partagent le code SW1 : sélection par
  // channelIndex (l'enChannelType du fichier ADY).
  const details = Object.values(CHANNEL_TYPES).find(
    channel => channel.channelIndex === channelIndex,
  );
  if (!details) throw new Error(`Unknown channel index ${channelIndex} (${code})`);
  return Object.assign(adapter, {
    isSub: () => code.startsWith('SW'),
    channelName: () => code,
    channelDetails: () => details,
    speakerType: () => speakerType,
    distanceInMeters: () => distance,
    splForAvr: () => trim,
    crossover: () => crossover,
    splIsAboveLimit: () => false,
    exceedsDistance: () => 'ok',
  });
}

async function importChannel(ady, code) {
  const channel = ady.detectedChannels.find(c => c.commandId === code);
  if (!channel) throw new Error(`Canal ${code} absent de l'ADY`);
  const samples = Object.values(channel.responseData)[0];
  const before = await listUuids();
  await rew.request('/import/impulse-response-data', 'POST', {
    identifier: `oca-golden-${code}`,
    startTime: 0,
    sampleRate: 48000,
    splOffset: 80,
    applyCal: false,
    data: RewApi.encodeFloat32ToBase64(new Float32Array(samples)),
  });
  const uuid = await waitForNewMeasurement(before, code);
  knownUuids.add(uuid);
  created.push(uuid);
  return makeAdapter(uuid, `oca-golden-${code}`);
}

async function main() {
  const version = await rew.request('/version');
  console.log(`REW: ${JSON.stringify(version)}`);
  const ady = JSON.parse(readFileSync(adyPath, 'utf-8'));
  mkdirSync(outDir, { recursive: true });
  knownUuids = await listUuids();

  try {
    // 1-2. Import + banks déterministes
    const speaker = await importChannel(ady, 'FL');
    await rew.request(`/measurements/${speaker.uuid}/filters`, 'POST', { filters: SPEAKER_BANK });
    const sub = await importChannel(ady, 'SW1');
    await rew.request(`/measurements/${sub.uuid}/filters`, 'POST', { filters: SUB_BANK });

    // 3. Export OCA par le chemin actuel
    const avr = new AvrCaracteristics(ady.targetModelName, ady.enMultEQType).toJSON();
    const avrFileContent = {
      ...ady,
      detectedChannels: ady.detectedChannels
        .filter(channel => ['FL', 'SW1'].includes(channel.commandId))
        .map(channel => ({ ...channel, responseData: {} })),
      avr,
    };
    const generator = new OCAFileGenerator(avrFileContent);
    generator.tcName = 'oca-golden-harness';

    const items = [
      channelItem(speaker, 'FL', { channelIndex: 0, crossover: 80, speakerType: 'S', distance: 3.4, trim: -2.5 }),
      channelItem(sub, 'SW1', { channelIndex: 59, crossover: 0, speakerType: 'E', distance: 2.1, trim: 1.5 }),
    ];

    const ocaJson = await generator.createOCAFile(items);

    // 4. Golden + manifeste
    writeFileSync(path.join(outDir, 'kef-fl-sw1.oca.json'), ocaJson + '\n');
    writeFileSync(
      path.join(outDir, 'manifest.json'),
      JSON.stringify(
        {
          source: path.basename(adyPath),
          rewVersion: version?.message ?? null,
          generatedAt: new Date().toISOString(),
          channels: {
            FL: { bank: SPEAKER_BANK, crossover: 80, speakerType: 'S', distance: 3.4, trim: -2.5, filterSpec: avr.multEQSpecs.speakerFilter },
            SW1: { bank: SUB_BANK, crossover: 0, speakerType: 'E', distance: 2.1, trim: 1.5, filterSpec: avr.multEQSpecs.subFilter },
          },
          note:
            'Golden du chemin OCA actuel (via REW). La génération interne (DSP) devra reproduire les tableaux `filter` de kef-fl-sw1.oca.json sur ces mêmes banks.',
        },
        null,
        2,
      ) + '\n',
    );
    const parsed = JSON.parse(ocaJson);
    for (const channel of parsed.channels) {
      console.log(
        `  canal ${channel.channelType}: filter[${channel.filter.length}] premier=${channel.filter[0]} xover=${channel.xover ?? 'FB'}`,
      );
    }
    console.log(`\nGolden écrit: ${path.join(outDir, 'kef-fl-sw1.oca.json')}`);
  } finally {
    for (const uuid of [...created].reverse()) {
      try {
        await rew.request(`/measurements/${uuid}`, 'DELETE');
      } catch (error) {
        console.warn(`Suppression ${uuid} impossible: ${error.message}`);
      }
    }
    console.log(`Nettoyage: mesures supprimées de REW`);
  }
}

await main();
