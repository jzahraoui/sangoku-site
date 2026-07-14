/**
 * generate-ir-align-goldens.mjs — parité de l'implémentation interne de
 * « Align IRs » (src/dsp/ir-align.js) contre l'alignment tool de REW réel.
 *
 * Pour chaque paire d'IR du corpus (canaux réels, subs compris) et chaque
 * fréquence d'alignement : pose A et B dans REW, fixe les bornes, lance
 * « Align IRs », lit Delay B ms / Invert B ; calcule la même chose en
 * interne sur les IR brutes (avec startTime) ; écrit le golden et affiche
 * les écarts. Nettoie REW en fin de run.
 *
 * Usage : node test/auto-eq/rew/generate-ir-align-goldens.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import RewApi from '../../../src/rew/rew-api.js';
import { alignImpulseResponses } from '../../../src/dsp/ir-align.js';
import { getWindowsHostIP } from '../test-config.js';

const rew = new RewApi(`http://${getWindowsHostIP()}:4735`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const created = [];

async function importIr(identifier, samples) {
  const before = new Set(Object.values(await rew.request('/measurements')).map(m => m.uuid));
  // Une erreur d'un run précédent peut traîner dans la file de process de
  // REW et polluer la première requête : réessayer une fois après une pause.
  for (let attempt = 0; ; attempt++) {
    try {
      await rew.request('/import/impulse-response-data', 'POST', {
        identifier,
        startTime: 0,
        sampleRate: 48000,
        splOffset: 80,
        applyCal: false,
        data: RewApi.encodeFloat32ToBase64(new Float32Array(samples)),
      });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      await sleep(2000);
    }
  }
  for (let i = 0; i < 100; i++) {
    const all = await rew.request('/measurements');
    const found = Object.values(all).find(m => !before.has(m.uuid));
    if (found) {
      created.push(found.uuid);
      return found.uuid;
    }
    await sleep(300);
  }
  throw new Error(`import timeout: ${identifier}`);
}

async function fetchIr(uuid) {
  const body = await rew.rewMeasurements.getImpulseResponse(uuid, {
    unit: 'percent',
    windowed: false,
    normalised: false,
  });
  return { data: body.data, sampleRate: body.sampleRate, startTime: body.startTime ?? 0 };
}

/**
 * REW livre le résultat d'un process échoué dans la réponse de la requête
 * SUIVANTE : encaisser ces messages en attente avant de continuer.
 */
async function drainPendingProcess() {
  for (let i = 0; i < 3; i++) {
    try {
      await rew.rewAlignmentTool.resetAll();
      return;
    } catch {
      await sleep(300);
    }
  }
}

async function rewAlign(uuidA, uuidB, frequency, minDelayMs, maxDelayMs) {
  const tool = rew.rewAlignmentTool;
  await tool.setRemoveTimeDelay(false);
  await tool.resetAll();
  await tool.setMaxNegativeDelay(minDelayMs);
  await tool.setMaxPositiveDelay(maxDelayMs);
  try {
    const result = await tool.alignIRsBatch(uuidA, uuidB, frequency);
    const details = result.results?.[0] ?? {};
    if (details.Error?.length) {
      return { error: String(details.Error) };
    }
    return {
      delayMs: Number(details['Delay B ms']),
      invertB: details['Invert B'] === 'true' || details['Invert B'] === true,
    };
  } catch (error) {
    // « Delay too large » : REW refuse et indique le délai requis ; purger le
    // message de process en attente avant la requête suivante.
    await drainPendingProcess();
    // Nombre décimal explicite : `[\d.]+` chevauchait `[^0-9-]*` sur le « . »
    // (backtracking super-linéaire, S8786) ; capture identique sur les
    // messages REW réels (« … too large … -12.34 ms »).
    const match = /too large[^0-9-]*(-?\d+(?:\.\d+)?)\s*ms/i.exec(error.message);
    return { error: error.message.slice(0, 140), requiredDelayMs: match ? Number(match[1]) : null };
  }
}

async function main() {
  console.log(JSON.stringify(await rew.request('/version')));
  await drainPendingProcess();
  const systems = {
    kef: JSON.parse(readFileSync('work/Denon AVC-A1H_kef.4sub.3pos.ady', 'utf-8')),
    bar: JSON.parse(readFileSync('work/barmatic_Denon_AVC-X3800H_23-07-2025_15-11-20.ady', 'utf-8')),
  };
  const irOf = (sys, code) =>
    Object.values(systems[sys].detectedChannels.find(c => c.commandId === code).responseData)[0];

  // Paires représentatives : enceinte↔sub (cas produit), enceinte↔enceinte,
  // sub↔sub, une paire avec inversion forcée, et un second système.
  const uuids = {};
  for (const code of ['FL', 'C', 'SRA', 'TFL', 'SW1', 'SW2']) {
    uuids[code] = await importIr(`iralign-${code}`, irOf('kef', code));
  }
  for (const code of ['FL', 'TML', 'SW1']) {
    uuids[`bar.${code}`] = await importIr(`iralign-bar-${code}`, irOf('bar', code));
  }
  const inverted = Array.from(irOf('kef', 'SW2'), v => -v);
  uuids['SW2inv'] = await importIr('iralign-SW2inv', inverted);

  const CASES = [
    { a: 'FL', b: 'SW1', fcs: [60, 80, 100, 120], bounds: [-0.5, 3] },
    { a: 'C', b: 'SW1', fcs: [80, 120], bounds: [-0.5, 3] },
    { a: 'TFL', b: 'SW1', fcs: [80, 120], bounds: [-0.5, 3] },
    { a: 'FL', b: 'SW2', fcs: [80], bounds: [-0.5, 3] },
    { a: 'FL', b: 'SW2inv', fcs: [80], bounds: [-0.5, 3] },
    { a: 'FL', b: 'C', fcs: [80, 200], bounds: [-3, 3] },
    { a: 'SW1', b: 'SW2', fcs: [60, 80], bounds: [-3, 3] },
    // bornes serrées pour provoquer la recherche contrainte / Delay too large
    { a: 'FL', b: 'SW1', fcs: [80], bounds: [-0.1, 0.1] },
    // second système (barmatic), dont le canal au pic pathologique (TML)
    { a: 'bar.FL', b: 'bar.SW1', fcs: [60, 80, 120], bounds: [-0.5, 3] },
    { a: 'bar.TML', b: 'bar.SW1', fcs: [120], bounds: [-0.5, 3] },
    { a: 'bar.FL', b: 'bar.TML', fcs: [120], bounds: [-3, 3] },
  ];

  const goldens = { rewVersion: null, generatedAt: new Date().toISOString(), irs: {}, cases: [] };
  goldens.rewVersion = (await rew.request('/version'))?.message ?? null;

  const irCache = {};
  for (const code of Object.keys(uuids)) {
    irCache[code] = await fetchIr(uuids[code]);
    // entrées versionnées avec le golden : le test de parité rejoue l'interne
    // hors ligne sur EXACTEMENT ce que REW a vu
    goldens.irs[code] = {
      sampleRate: irCache[code].sampleRate,
      startTime: irCache[code].startTime,
      data: Array.from(irCache[code].data, v => Number(v.toFixed(7))),
    };
  }

  let maxDelayDiff = 0;
  let invertMismatches = 0;
  for (const { a, b, fcs, bounds } of CASES) {
    for (const fc of fcs) {
      const rewResult = await rewAlign(uuids[a], uuids[b], fc, bounds[0], bounds[1]);
      let internal;
      try {
        internal = alignImpulseResponses(irCache[a], irCache[b], {
          frequency: fc,
          minDelayMs: bounds[0],
          maxDelayMs: bounds[1],
        });
      } catch (error) {
        internal = { error: error.message };
      }
      goldens.cases.push({ a, b, fc, bounds, rew: rewResult, internal });
      const delayDiff =
        Number.isFinite(rewResult.delayMs) && Number.isFinite(internal.delayMs)
          ? Math.abs(rewResult.delayMs - internal.delayMs)
          : null;
      if (delayDiff !== null) maxDelayDiff = Math.max(maxDelayDiff, delayDiff);
      const invertMatch =
        rewResult.invertB === undefined || rewResult.invertB === internal.invertB;
      if (!invertMatch) invertMismatches++;
      const rewCol = rewResult.error
        ? 'ERR ' + (rewResult.requiredDelayMs ?? '') + ' (' + rewResult.error.slice(0, 60) + ')'
        : rewResult.delayMs.toFixed(2) + ' ms inv=' + rewResult.invertB;
      const internalCol = internal.error
        ? 'ERR ' + internal.error.slice(0, 60)
        : internal.delayMs.toFixed(2) + ' ms inv=' + internal.invertB +
          ' (libre ' + internal.requiredDelayMs.toFixed(2) + ')';
      const deltaCol = delayDiff !== null ? `  Δ=${delayDiff.toFixed(3)} ms` : '';
      const invertCol = invertMatch ? '' : '  ⚠ INVERT';
      console.log(
        `${a}↔${b}@${fc} [${bounds}]  REW: ${rewCol}  interne: ${internalCol}${deltaCol}${invertCol}`,
      );
    }
  }

  writeFileSync(
    'test/fixtures/ir-align/goldens.json',
    JSON.stringify(goldens, null, 1) + '\n',
  );
  console.log(
    `\nΔ délai max ${maxDelayDiff.toFixed(3)} ms, désaccords d'inversion : ${invertMismatches}`,
  );
  console.log('golden écrit: test/fixtures/ir-align/goldens.json');
}

try {
  await main();
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
