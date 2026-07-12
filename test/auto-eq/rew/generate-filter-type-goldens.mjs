/**
 * generate-filter-type-goldens.mjs — IR de référence REW par type de filtre
 * (extension LP/HP/shelves de l'export OCA interne).
 *
 * Pour chaque type : pose le filtre seul sur une mesure temporaire, génère la
 * mesure-filtre (chemin historique : Generate filters measurement → fenêtres
 * rectangulaires → trim → getImpulseResponse normalisée), et enregistre les
 * 2048 premiers échantillons — suffisant pour valider les coefficients biquad
 * au bit près, la queue étant déterminée par eux.
 *
 * Une seule exécution REW ; l'itération DSP se fait ensuite hors ligne contre
 * test/fixtures/oca/filter-types.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import RewApi from '../../../src/rew/rew-api.js';
import { createMeasurementOperations } from '../../../src/services/measurement-operations.js';
import { getWindowsHostIP } from '../test-config.js';

const SAMPLE_COUNT = 2048;
const TARGET_RATE = 48000;

const TYPES = [
  { name: 'LP', filter: { type: 'LP', frequency: 100 } },
  { name: 'HP', filter: { type: 'HP', frequency: 100 } },
  { name: 'LP1', filter: { type: 'LP1', frequency: 100 } },
  { name: 'HP1', filter: { type: 'HP1', frequency: 100 } },
  { name: 'LS', filter: { type: 'LS', frequency: 100, gaindB: 5 } },
  { name: 'HS', filter: { type: 'HS', frequency: 5000, gaindB: -5 } },
  { name: 'LS-neg', filter: { type: 'LS', frequency: 100, gaindB: -5 } },
  { name: 'HS-pos', filter: { type: 'HS', frequency: 5000, gaindB: 5 } },
  { name: 'LS 6dB', filter: { type: 'LS 6dB', frequency: 100, gaindB: 5 } },
  { name: 'LS 12dB', filter: { type: 'LS 12dB', frequency: 100, gaindB: 5 } },
  { name: 'HS 6dB', filter: { type: 'HS 6dB', frequency: 5000, gaindB: -5 } },
  { name: 'HS 12dB', filter: { type: 'HS 12dB', frequency: 5000, gaindB: -5 } },
  { name: 'Notch', filter: { type: 'Notch', frequency: 1000 } },
  { name: 'Modal', filter: { type: 'Modal', frequency: 60, gaindB: -6, t60Target: 300 } },
];

const rew = new RewApi(`http://${getWindowsHostIP()}:4735`);
const ops = createMeasurementOperations({
  log: { debug: () => {}, info: () => {}, warn: m => console.warn(`  [ops] ${m}`), error: console.error },
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const created = [];
let knownUuids = new Set();

async function listUuids() {
  const all = await rew.request('/measurements');
  return new Set(Object.values(all ?? {}).map(m => m.uuid));
}
async function waitForNew(label, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const all = await rew.request('/measurements');
    const entry = Object.values(all ?? {}).find(m => !knownUuids.has(m.uuid));
    if (entry) {
      knownUuids.add(entry.uuid);
      created.push(entry.uuid);
      return entry.uuid;
    }
    await sleep(300);
  }
  throw new Error(`Timeout: ${label}`);
}

function makeAdapter(uuid, title, { isFilter = false } = {}) {
  const adapter = {
    uuid,
    title: () => title,
    displayMeasurementTitle: () => title,
    notes: '',
    isFilter,
    haveImpulseResponse: true,
    sampleRate: TARGET_RATE,
    inverted: () => false,
    timeOfIRPeakSeconds: 0,
    splOffsetdB: 0,
    initialSplOffsetdB: 0,
    alignSPLOffsetdB: 0,
    splresidual: 0,
    crossover: () => null,
    update(partial) {
      if (partial.title !== undefined) {
        const value = partial.title;
        adapter.title = () => value;
        adapter.displayMeasurementTitle = () => value;
      }
      if (partial.inverted !== undefined) adapter.inverted = () => partial.inverted;
      if (partial.sampleRate !== undefined) adapter.sampleRate = partial.sampleRate;
    },
  };
  return adapter;
}

const session = {
  async analyseApiResponse() {
    const uuid = await waitForNew('generated');
    return makeAdapter(uuid, `gen-${uuid.slice(0, 8)}`, { isFilter: true });
  },
  removeMeasurements: async () => {},
  removeMeasurementUuid: async uuid => {
    await rew.request(`/measurements/${uuid}`, 'DELETE');
    const at = created.indexOf(uuid);
    if (at >= 0) created.splice(at, 1);
  },
  findMeasurementByUuid: () => null,
};

async function main() {
  const version = await rew.request('/version');
  console.log(JSON.stringify(version));
  const ady = JSON.parse(readFileSync('work/Denon AVC-A1H_kef.4sub.3pos.ady', 'utf-8'));
  const samples = Object.values(
    ady.detectedChannels.find(c => c.commandId === 'FL').responseData,
  )[0];

  knownUuids = await listUuids();
  await rew.request('/import/impulse-response-data', 'POST', {
    identifier: 'filter-type-goldens',
    startTime: 0,
    sampleRate: TARGET_RATE,
    splOffset: 80,
    applyCal: false,
    data: RewApi.encodeFloat32ToBase64(new Float32Array(samples)),
  });
  const measurementUuid = await waitForNew('import');
  const measurement = makeAdapter(measurementUuid, 'filter-type-goldens');

  const goldens = {
    rewVersion: version?.message ?? null,
    generatedAt: new Date().toISOString(),
    sampleRate: TARGET_RATE,
    sampleCount: SAMPLE_COUNT,
    note: 'IR normalisée (pic=1) des 2048 premiers échantillons, chemin REW historique.',
    types: {},
  };

  try {
    for (const { name, filter } of TYPES) {
      await rew.request(`/measurements/${measurementUuid}/filters`, 'POST', {
        filters: [{ index: 1, enabled: true, isAuto: false, ...filter }],
      });
      await sleep(200);

      const filterItem = await ops.generateFilterMeasurement(
        rew.rewMeasurements,
        measurement,
        session,
      );
      await ops.setIrWindows(rew.rewMeasurements, filterItem, {
        leftWindowType: 'Rectangular',
        rightWindowType: 'Rectangular',
        leftWindowWidthms: 0,
        rightWindowWidthms: ((SAMPLE_COUNT - 1) * 1000) / TARGET_RATE,
        refTimems: 0,
        addFDW: false,
        addMTW: false,
      });
      const trimmed = await ops.trimIRToWindows(rew.rewMeasurements, filterItem, session);
      const trimmedAdapter = makeAdapter(trimmed.uuid, 'trimmed', { isFilter: true });
      const impulseResponse = await ops.getImpulseResponse(
        rew.rewMeasurements,
        trimmedAdapter,
        { freq: TARGET_RATE, unit: 'percent', windowed: true, normalised: true },
      );

      goldens.types[name] = {
        filter,
        impulseResponse: Array.from(impulseResponse.slice(0, SAMPLE_COUNT), v =>
          Number(v.toFixed(9)),
        ),
      };
      console.log(
        `  ${name.padEnd(8)} ir[0..2]=${[0, 1, 2].map(i => impulseResponse[i].toFixed(6))}`,
      );

      await session.removeMeasurementUuid(trimmed.uuid ?? trimmedAdapter.uuid);
      await session.removeMeasurementUuid(filterItem.uuid);
      await rew.request(`/measurements/${measurementUuid}/filters`, 'POST', {
        filters: [{ index: 1, type: 'None', enabled: true, isAuto: false }],
      });
      await sleep(150);
    }

    writeFileSync(
      'test/fixtures/oca/filter-types.json',
      JSON.stringify(goldens, null, 1) + '\n',
    );
    console.log('golden écrit: test/fixtures/oca/filter-types.json');
  } finally {
    for (const uuid of [...created].reverse()) {
      try {
        await rew.request(`/measurements/${uuid}`, 'DELETE');
      } catch {
        /* déjà supprimé */
      }
    }
    console.log('nettoyage terminé');
  }
}

await main();
