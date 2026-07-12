/**
 * generate-ady-fixtures.mjs — Phase 0 du plan qualité audio.
 *
 * Génère les fixtures multi-positions depuis un fichier .ady (3 positions)
 * en pilotant un REW réel (WSL : WINDOWS_HOST). Pour chaque canal retenu :
 *   - importe les 3 positions (IR brutes, comme l'app : Float32Array, 48 kHz,
 *     splOffset 80, sans calibration micro),
 *   - cross-corr align,
 *   - sauvegarde la réponse 96 PPO brute de chaque position,
 *   - pour chacune des 3 méthodes de moyenne de l'app (Vector average,
 *     Magn plus phase average, dB plus phase average) : sauvegarde la réponse
 *     brute puis la réponse avec le fenêtrage « Optimized MTW » appliqué.
 * Les mesures créées dans REW sont supprimées en fin de run (état restauré).
 *
 * Usage :
 *   node test/auto-eq/rew/generate-ady-fixtures.mjs \
 *     "work/Denon AVC-A1H_kef.4sub.3pos.ady" test/fixtures/ady-3pos FL C SBR
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import RewApi from '../../../src/rew/rew-api.js';
import { IR_WINDOW_PRESETS } from '../../../src/measurement/working-settings.js';
import { getWindowsHostIP } from '../test-config.js';

const [, , adyPath, outDir, ...channelArgs] = process.argv;
const channels = channelArgs.length ? channelArgs : ['FL', 'C', 'SBR'];
if (!adyPath || !outDir) {
  console.error(
    'Usage: node generate-ady-fixtures.mjs <fichier.ady> <dossier-sortie> [canaux…]',
  );
  process.exit(1);
}

const AVERAGE_METHODS = [
  { method: 'Vector average', slug: 'vector-avg' },
  { method: 'Magn plus phase average', slug: 'rms-avg' },
  { method: 'dB plus phase average', slug: 'db-avg' },
];
const SPL_OFFSET = 80; // défaut de l'app (MeasurementViewModel.js:392)
const PPO = 96;

const rew = new RewApi(`http://${getWindowsHostIP()}:4735`);

// Le script utilise des requêtes brutes (rew.request) plutôt que la
// chorégraphie process du client applicatif : un résultat de process périmé
// dans REW ne doit pas faire dérailler la génération. La complétion des
// opérations asynchrones est détectée par polling de l'état (liste des
// mesures, fenêtres IR).

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function listUuids() {
  const all = await rew.request('/measurements');
  return new Set(Object.values(all ?? {}).map(m => m.uuid));
}

/** Attend qu'une nouvelle mesure apparaisse par rapport à `before`. */
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

async function waitForMtwWindows(uuid, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const windows = await rew.request(`/measurements/${uuid}/ir-windows`);
    if (windows?.addMTW === true) {
      await sleep(500); // laisse REW recalculer la réponse fenêtrée
      return;
    }
    await sleep(300);
  }
  throw new Error(`Timeout waiting for MTW windows on ${uuid}`);
}

function writeFixture(filePath, response, comment) {
  const lines = [
    `* ${comment}`,
    `* Généré par generate-ady-fixtures.mjs le ${new Date().toISOString()}`,
    '* Freq(Hz)\tSPL(dB)',
  ];
  for (let i = 0; i < response.freqs.length; i++) {
    lines.push(`${response.freqs[i].toFixed(6)}\t${response.magnitude[i].toFixed(4)}`);
  }
  writeFileSync(filePath, lines.join('\n') + '\n');
  console.log(`  écrit: ${filePath} (${response.freqs.length} points)`);
}

async function fetchResponse(uuid) {
  return rew.rewMeasurements.getFrequencyResponse(uuid, { ppo: PPO });
}

async function main() {
  const rewVersion = await rew.request('/version');
  console.log(`REW: ${JSON.stringify(rewVersion)}`);
  const ady = JSON.parse(readFileSync(adyPath, 'utf-8'));
  if (!Array.isArray(ady.detectedChannels)) {
    throw new Error(
      'Ce fichier ne contient pas de detectedChannels/responseData — export de ' +
        'configuration (OCA) et non de mesures ?',
    );
  }
  mkdirSync(outDir, { recursive: true });

  const manifest = {
    source: path.basename(adyPath),
    title: ady.title ?? null,
    model: ady.targetModelName ?? null,
    rewVersion: rewVersion?.message ?? null,
    generatedAt: new Date().toISOString(),
    channels: {},
  };
  const created = [];
  try {
    for (const channelName of channels) {
      const channel = ady.detectedChannels.find(c => c.commandId === channelName);
      if (!channel) {
        console.warn(`Canal ${channelName} absent du fichier ADY, ignoré`);
        continue;
      }
      console.log(`\n── Canal ${channelName}`);
      manifest.channels[channelName] = {
        positions: Object.keys(channel.responseData).length,
        rolloffHz: channel.frequencyRangeRolloff ?? null,
      };

      // 1. Import des positions
      const positionUuids = [];
      for (const [position, samples] of Object.entries(channel.responseData)) {
        const name = `${channelName}_P${(Number(position) + 1).toString().padStart(2, '0')}`;
        const before = await listUuids();
        await rew.request('/import/impulse-response-data', 'POST', {
          identifier: name,
          startTime: 0,
          sampleRate: 48000,
          splOffset: SPL_OFFSET,
          applyCal: false,
          data: RewApi.encodeFloat32ToBase64(new Float32Array(samples)),
        });
        const uuid = await waitForNewMeasurement(before, name);
        positionUuids.push({ name, uuid });
        created.push(uuid);
      }

      // 2. Alignement par corrélation croisée (comme le service d'averaging)
      await rew.request('/measurements/process-measurements', 'POST', {
        processName: 'Cross corr align',
        measurementUUIDs: positionUuids.map(p => p.uuid),
        parameters: {},
      });
      await sleep(1500); // alignement in-place : pas de nouvelle mesure à guetter

      // 3. Réponses brutes par position
      for (const { name, uuid } of positionUuids) {
        writeFixture(
          path.join(outDir, `${name}.txt`),
          await fetchResponse(uuid),
          `${name} — position individuelle, brute (96 PPO, sans lissage, après cross-corr align)`,
        );
      }

      // 4. Moyennes × (brute, MTW)
      for (const { method, slug } of AVERAGE_METHODS) {
        const before = await listUuids();
        await rew.request('/measurements/process-measurements', 'POST', {
          processName: method,
          measurementUUIDs: positionUuids.map(p => p.uuid),
          parameters: {},
        });
        const avgUuid = await waitForNewMeasurement(before, `${channelName} ${method}`);
        created.push(avgUuid);

        writeFixture(
          path.join(outDir, `${channelName}_${slug}_raw.txt`),
          await fetchResponse(avgUuid),
          `${channelName} — ${method}, brute (96 PPO, sans lissage ni fenêtrage)`,
        );

        await rew.request(
          `/measurements/${avgUuid}/ir-windows`,
          'PUT',
          IR_WINDOW_PRESETS['Optimized MTW'],
        );
        await waitForMtwWindows(avgUuid);
        writeFixture(
          path.join(outDir, `${channelName}_${slug}_mtw.txt`),
          await fetchResponse(avgUuid),
          `${channelName} — ${method}, fenêtrage Optimized MTW (mtwTimesms ${IR_WINDOW_PRESETS['Optimized MTW'].mtwTimesms.join('/')})`,
        );
      }
    }
    writeFileSync(
      path.join(outDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    console.log(`\nmanifest.json écrit (${Object.keys(manifest.channels).length} canaux)`);
  } finally {
    // 5. Nettoyage : ne supprimer que ce que ce script a créé
    for (const uuid of created.reverse()) {
      try {
        await rew.request(`/measurements/${uuid}`, 'DELETE');
      } catch (error) {
        console.warn(`Suppression ${uuid} impossible: ${error.message}`);
      }
    }
    console.log(`\nNettoyage: ${created.length} mesure(s) supprimée(s) de REW`);
  }
}

await main();
