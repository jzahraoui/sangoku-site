/**
 * probe-filter-types.mjs — sonde de découverte des types de filtres acceptés
 * par l'équaliseur Generic de REW via l'API (préparation de l'extension
 * LP/HP/shelves de l'export OCA interne).
 *
 * Importe une mesure temporaire, tente de poser chaque variante candidate sur
 * le slot 1, relit le bank et affiche la forme canonique renvoyée par REW.
 * Nettoie la mesure en fin de run.
 */
import { readFileSync } from 'node:fs';
import RewApi from '../../../src/rew/rew-api.js';
import { getWindowsHostIP } from '../test-config.js';

const rew = new RewApi(`http://${getWindowsHostIP()}:4735`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const CANDIDATES = [
  { type: 'LP', frequency: 100 },
  { type: 'HP', frequency: 100 },
  { type: 'Notch', frequency: 1000 },
  { type: 'Modal', frequency: 60, gaindB: -6, t60Target: 300 },
  { type: 'Modal', frequency: 60, gaindB: -6 },
  { index: 21, type: 'Low pass', frequency: 100, shape: 'L-R', slopedBPerOctave: 24 },
  { index: 21, type: 'Low pass', frequency: 100, shape: 'L-R', slopedBPerOctave: 12 },
  { index: 21, type: 'Low pass', frequency: 100, shape: 'L-R', slopedBPerOctave: 48 },
  { index: 21, type: 'Low pass', frequency: 100, shape: 'BU', slopedBPerOctave: 24 },
  { index: 22, type: 'High pass', frequency: 100, shape: 'L-R', slopedBPerOctave: 24 },
  { index: 21, type: 'All pass', frequency: 60, q: 0.7 },
];

async function main() {
  console.log(JSON.stringify(await rew.request('/version')));
  const ady = JSON.parse(
    readFileSync('work/Denon AVC-A1H_kef.4sub.3pos.ady', 'utf-8'),
  );
  const samples = Object.values(
    ady.detectedChannels.find(c => c.commandId === 'FL').responseData,
  )[0];

  const before = new Set(
    Object.values(await rew.request('/measurements')).map(m => m.uuid),
  );
  await rew.request('/import/impulse-response-data', 'POST', {
    identifier: 'probe-filter-types',
    startTime: 0,
    sampleRate: 48000,
    splOffset: 80,
    applyCal: false,
    data: RewApi.encodeFloat32ToBase64(new Float32Array(samples)),
  });
  let uuid = null;
  for (let i = 0; i < 100 && !uuid; i++) {
    const all = await rew.request('/measurements');
    uuid = Object.values(all).find(m => !before.has(m.uuid))?.uuid ?? null;
    if (!uuid) await sleep(300);
  }
  if (!uuid) throw new Error('import timeout');

  try {
    for (const candidate of CANDIDATES) {
      const slotIndex = candidate.index ?? 1;
      const wanted = { index: slotIndex, enabled: true, isAuto: false, ...candidate };
      let postError = null;
      try {
        await rew.request(`/measurements/${uuid}/filters`, 'POST', {
          filters: [wanted],
        });
      } catch (error) {
        postError = error.message.slice(0, 120);
      }
      await sleep(150);
      const bank = await rew.request(`/measurements/${uuid}/filters`);
      const slot1 = (Array.isArray(bank) ? bank : Object.values(bank)).find(
        f => f.index === slotIndex,
      );
      console.log(
        `POST ${JSON.stringify(candidate).padEnd(78)} → ${postError ? 'ERR ' + postError : JSON.stringify(slot1)}`,
      );
      // reset slot 1
      await rew.request(`/measurements/${uuid}/filters`, 'POST', {
        filters: [{ index: slotIndex, type: 'None', enabled: true, isAuto: false }],
      });
      await sleep(100);
    }
  } finally {
    await rew.request(`/measurements/${uuid}`, 'DELETE');
    console.log('mesure temporaire supprimée');
  }
}

await main();
