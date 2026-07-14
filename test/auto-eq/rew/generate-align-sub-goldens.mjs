/**
 * generate-align-sub-goldens.mjs — parité du chemin interne « mesures
 * filtrées » de Find Sub Alignment (applyBankAndCrossoverToIr) contre le
 * chemin REW de production (eqGenerate + filtres de raccord + offsetTZero).
 *
 * Pour chaque cas (enceinte + sub du corpus, banks de filtres réalistes,
 * fréquence de raccord, variantes inversion / offset t=0) :
 *  - chemin REW (celui de produceAligned aujourd'hui) : predicted de
 *    l'enceinte, LP L-R 24 sur le sub + HP BU 12 sur le predicted (slot X
 *    libre), predicted des deux, pics REW, offsetTZero du delta, IR lues,
 *    aligneur interne (déjà à parité démontrée : test:ir-align-parity) ;
 *  - chemin interne : IR brutes exportées + banks → cascade + raccord en
 *    local, pics parabole, décalage de startTime, même aligneur.
 * Écrit le golden (IR d'entrée versionnées + sorties du chemin REW) et
 * affiche les écarts. Nettoie REW en fin de run.
 *
 * Usage : node test/auto-eq/rew/generate-align-sub-goldens.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import RewApi from '../../../src/rew/rew-api.js';
import { alignImpulseResponses } from '../../../src/dsp/ir-align.js';
import { applyBankAndCrossoverToIr } from '../../../src/measurement/rew-filter-bank.js';
import { combineImpulseResponses } from '../../../src/dsp/impulseResponse.js';
import { calculateCombinedResponse } from '../../../src/optimizer/response.js';
import { synthesizeImpulseFromResponse } from '../../../src/dsp/impulse-synthesis.js';
import { getWindowsHostIP } from '../test-config.js';

const rew = new RewApi(`http://${getWindowsHostIP()}:4735`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const created = [];

const listMeasurements = () => rew.request('/measurements');

async function waitForNew(before, label) {
  for (let i = 0; i < 100; i++) {
    const all = await listMeasurements();
    const found = Object.values(all).find(m => !before.has(m.uuid));
    if (found) {
      created.push(found.uuid);
      return found;
    }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function importIr(identifier, samples, startTime = 0) {
  const before = new Set(Object.values(await listMeasurements()).map(m => m.uuid));
  for (let attempt = 0; ; attempt++) {
    try {
      await rew.request('/import/impulse-response-data', 'POST', {
        identifier,
        startTime,
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
  return waitForNew(before, identifier);
}

async function fetchIr(uuid) {
  const body = await rew.rewMeasurements.getImpulseResponse(uuid, {
    unit: 'percent',
    windowed: false,
    normalised: false,
  });
  return { data: body.data, sampleRate: body.sampleRate, startTime: body.startTime ?? 0 };
}

/** IR predicted (/eq/impulse-response) — l'entrée exacte du chemin interne. */
async function fetchEqIr(uuid) {
  const body = await rew.rewMeasurements.getPredictedImpulseResponse(uuid, {
    unit: 'percent',
    windowed: false,
    normalised: false,
  });
  return { data: body.data, sampleRate: body.sampleRate, startTime: body.startTime ?? 0 };
}

const infoOf = uuid => rew.request(`/measurements/${uuid}`);

async function eqGenerate(uuid, label) {
  const before = new Set(Object.values(await listMeasurements()).map(m => m.uuid));
  await rew.rewMeasurements.generatePredictedMeasurement(uuid);
  return waitForNew(before, label);
}

async function remove(uuid) {
  try {
    await rew.request(`/measurements/${uuid}`, 'DELETE');
  } catch {
    /* déjà supprimé */
  }
  const index = created.indexOf(uuid);
  if (index !== -1) created.splice(index, 1);
}

/** Bank complet 22 slots : les entrées données, None ailleurs (état net). */
function fullBank(entries = []) {
  const byIndex = new Map(entries.map(f => [f.index, f]));
  return Array.from({ length: 22 }, (_, i) => {
    return byIndex.get(i + 1) ?? { index: i + 1, type: 'None', enabled: true, isAuto: false };
  });
}

const postFilters = (uuid, filters) =>
  rew.request(`/measurements/${uuid}/filters`, 'POST', { filters });

/** Même choix de slot que getFreeXFilterIndex (slots 21/22, 1-indexés). */
async function freeXSlot(uuid) {
  const filters = await rew.request(`/measurements/${uuid}/filters`);
  const free = [20, 21].find(i => filters[i]?.type === 'None');
  if (free === undefined) throw new Error(`no free X slot on ${uuid}`);
  return free + 1;
}

// --- Chemin REW = réplique de businessTools.produceAligned/applyCutOffFilter ---

async function rewPath(speakerUuid, subUuid, fc) {
  const temp = [];
  try {
    const predictedSpeaker = await eqGenerate(speakerUuid, 'predicted speaker');
    temp.push(predictedSpeaker.uuid);

    const subSlot = await freeXSlot(subUuid);
    const speakerSlot = await freeXSlot(predictedSpeaker.uuid);
    await postFilters(subUuid, [
      {
        index: subSlot, type: 'Low pass', enabled: true, isAuto: false,
        frequency: fc, shape: 'L-R', slopedBPerOctave: 24,
      },
    ]);
    await postFilters(predictedSpeaker.uuid, [
      {
        index: speakerSlot, type: 'High pass', enabled: true, isAuto: false,
        frequency: fc, shape: 'BU', slopedBPerOctave: 12,
      },
    ]);

    const subFiltered = await eqGenerate(subUuid, 'sub filtered');
    temp.push(subFiltered.uuid);
    const speakerFiltered = await eqGenerate(predictedSpeaker.uuid, 'speaker filtered');
    temp.push(speakerFiltered.uuid);

    const subPeak = (await infoOf(subFiltered.uuid)).timeOfIRPeakSeconds;
    const speakerPeak = (await infoOf(speakerFiltered.uuid)).timeOfIRPeakSeconds;

    // arithmétique de produceAligned
    const cutoffPeriod = 1 / fc;
    const delay = cutoffPeriod / 16;
    const maxForwardSearchMs = Math.round((cutoffPeriod / 2) * 1000 * 100) / 100;
    const finalDistance0 = subPeak - speakerPeak - delay;

    await rew.rewMeasurements.offsetTZero(subFiltered.uuid, finalDistance0);
    await sleep(400);

    const speakerIr = await fetchIr(speakerFiltered.uuid);
    const subIr = await fetchIr(subFiltered.uuid);
    let align;
    try {
      align = alignImpulseResponses(speakerIr, subIr, {
        frequency: fc,
        minDelayMs: 0,
        maxDelayMs: maxForwardSearchMs,
      });
    } catch (error) {
      align = { error: error.message };
    }

    return {
      speakerPeak,
      subPeak,
      delay,
      maxForwardSearchMs,
      finalDistance0,
      align: align.error
        ? { error: align.error }
        : {
            delayMs: align.delayMs,
            invertB: align.invertB,
            withinBounds: align.withinBounds,
            requiredDelayMs: align.requiredDelayMs,
          },
      finalDistanceSeconds: align.error
        ? null
        : finalDistance0 - align.delayMs / 1000,
    };
  } finally {
    // remettre les slots de raccord à None (comme le finally de production)
    await postFilters(subUuid, fullBank(BANKS_POSTED.get(subUuid) ?? []));
    for (const uuid of temp.toReversed()) await remove(uuid);
  }
}

// --- Chemin interne = applyBankAndCrossoverToIr sur les IR exportées ---------

function internalPath(speakerIr, speakerBank, subIr, subBank, fc) {
  const speakerFiltered = applyBankAndCrossoverToIr(speakerIr, speakerBank, {
    type: 'High pass', frequency: fc, shape: 'BU', slopedBPerOctave: 12,
  });
  const subFiltered = applyBankAndCrossoverToIr(subIr, subBank, {
    type: 'Low pass', frequency: fc, shape: 'L-R', slopedBPerOctave: 24,
  });

  const cutoffPeriod = 1 / fc;
  const delay = cutoffPeriod / 16;
  const maxForwardSearchMs = Math.round((cutoffPeriod / 2) * 1000 * 100) / 100;
  const finalDistance0 =
    subFiltered.timeOfIRPeakSeconds - speakerFiltered.timeOfIRPeakSeconds - delay;

  // équivalent interne de offsetTZero(finalDistance0)
  const shiftedSub = { ...subFiltered, startTime: subFiltered.startTime - finalDistance0 };

  let align;
  try {
    align = alignImpulseResponses(speakerFiltered, shiftedSub, {
      frequency: fc,
      minDelayMs: 0,
      maxDelayMs: maxForwardSearchMs,
    });
  } catch (error) {
    align = { error: error.message };
  }

  return {
    speakerPeak: speakerFiltered.timeOfIRPeakSeconds,
    subPeak: subFiltered.timeOfIRPeakSeconds,
    finalDistance0,
    align,
    finalDistanceSeconds: align.error ? null : finalDistance0 - align.delayMs / 1000,
  };
}

// --- Corpus, banks et cas ------------------------------------------------------

const BANK_SPEAKER_A = [
  { index: 1, type: 'PK', enabled: true, isAuto: true, frequency: 42, q: 4.6, gaindB: -6.2 },
  { index: 2, type: 'PK', enabled: true, isAuto: true, frequency: 88, q: 2.1, gaindB: 3.4 },
  { index: 3, type: 'PK', enabled: true, isAuto: true, frequency: 156, q: 5.0, gaindB: -4.8 },
  { index: 4, type: 'PK', enabled: true, isAuto: true, frequency: 320, q: 1.4, gaindB: 2.2 },
  { index: 5, type: 'PK', enabled: true, isAuto: true, frequency: 1240, q: 3.2, gaindB: -2.6 },
  { index: 6, type: 'PK', enabled: true, isAuto: true, frequency: 5200, q: 2.0, gaindB: 1.8 },
];
const BANK_SPEAKER_B = [
  { index: 1, type: 'LS', enabled: true, isAuto: false, frequency: 70, gaindB: 2.5 },
  { index: 2, type: 'PK', enabled: true, isAuto: true, frequency: 110, q: 3.8, gaindB: -5.1 },
  { index: 3, type: 'PK', enabled: true, isAuto: true, frequency: 480, q: 2.6, gaindB: 2.9 },
  { index: 4, type: 'HS', enabled: true, isAuto: false, frequency: 8000, gaindB: -1.5 },
];
const BANK_SUB_S = [
  { index: 1, type: 'PK', enabled: true, isAuto: true, frequency: 28, q: 3.9, gaindB: -5.5 },
  { index: 2, type: 'PK', enabled: true, isAuto: true, frequency: 47, q: 5.2, gaindB: -8.1 },
  { index: 3, type: 'PK', enabled: true, isAuto: true, frequency: 63, q: 2.4, gaindB: 3.1 },
  { index: 4, type: 'PK', enabled: true, isAuto: true, frequency: 96, q: 4.1, gaindB: -3.7 },
  { index: 20, type: 'All pass', enabled: true, isAuto: false, frequency: 55, q: 0.62 },
];
const BANK_SUB_S2 = [
  { index: 1, type: 'PK', enabled: true, isAuto: true, frequency: 34, q: 4.4, gaindB: -6.9 },
  { index: 2, type: 'PK', enabled: true, isAuto: true, frequency: 71, q: 3.0, gaindB: 2.4 },
  { index: 20, type: 'All pass', enabled: true, isAuto: false, frequency: 90, q: 1.1 },
];
const BANK_EMPTY = [];

// banks actuellement postés (pour la remise à None du finally)
const BANKS_POSTED = new Map();

async function applyBank(uuid, bank) {
  await postFilters(uuid, fullBank(bank));
  BANKS_POSTED.set(uuid, bank);
  await sleep(300);
}

// Complexité assumée (revue 2026-07-14) : script de génération de goldens
// piloté sur REW réel — le restructurer n'est vérifiable qu'avec REW branché.
// eslint-disable-next-line sonarjs/cognitive-complexity
async function main() {
  console.log(JSON.stringify(await rew.request('/version')));

  const systems = {
    kef: JSON.parse(readFileSync('work/Denon AVC-A1H_kef.4sub.3pos.ady', 'utf-8')),
    bar: JSON.parse(readFileSync('work/barmatic_Denon_AVC-X3800H_23-07-2025_15-11-20.ady', 'utf-8')),
  };
  const irOf = (sys, code) =>
    Object.values(systems[sys].detectedChannels.find(c => c.commandId === code).responseData)[0];

  // Imports : les variantes (inversion, offset t=0) ont leur propre mesure
  // pour que chaque clé du golden désigne UN état exporté.
  const uuids = {};
  uuids['kef.FL'] = (await importIr('alignsub-FL', irOf('kef', 'FL'))).uuid;
  uuids['kef.C'] = (await importIr('alignsub-C', irOf('kef', 'C'))).uuid;
  uuids['kef.TFL'] = (await importIr('alignsub-TFL', irOf('kef', 'TFL'))).uuid;
  uuids['kef.SW1'] = (await importIr('alignsub-SW1', irOf('kef', 'SW1'))).uuid;
  uuids['kef.SW2'] = (await importIr('alignsub-SW2', irOf('kef', 'SW2'))).uuid;
  uuids['kef.SW1inv'] = (await importIr('alignsub-SW1inv', irOf('kef', 'SW1'))).uuid;
  uuids['kef.SW1off'] = (await importIr('alignsub-SW1off', irOf('kef', 'SW1'))).uuid;
  uuids['bar.FL'] = (await importIr('alignsub-barFL', irOf('bar', 'FL'))).uuid;
  uuids['bar.TML'] = (await importIr('alignsub-barTML', irOf('bar', 'TML'))).uuid;
  uuids['bar.SW1'] = (await importIr('alignsub-barSW1', irOf('bar', 'SW1'))).uuid;

  // variantes d'état (production : le sub peut être inversé / déjà décalé)
  await rew.request(`/measurements/${uuids['kef.SW1inv']}/command`, 'POST', { command: 'Invert' });
  await rew.rewMeasurements.offsetTZero(uuids['kef.SW1off'], 0.0031); // fractionnaire
  await sleep(500);

  const CASES = [
    { speaker: 'kef.FL', sub: 'kef.SW1', fc: 80, speakerBank: BANK_SPEAKER_A, subBank: BANK_SUB_S },
    { speaker: 'kef.C', sub: 'kef.SW1', fc: 120, speakerBank: BANK_SPEAKER_B, subBank: BANK_SUB_S },
    { speaker: 'kef.TFL', sub: 'kef.SW1', fc: 100, speakerBank: BANK_SPEAKER_A, subBank: BANK_SUB_S2 },
    { speaker: 'kef.FL', sub: 'kef.SW1inv', fc: 80, speakerBank: BANK_SPEAKER_A, subBank: BANK_SUB_S },
    { speaker: 'kef.FL', sub: 'kef.SW1off', fc: 80, speakerBank: BANK_SPEAKER_A, subBank: BANK_SUB_S },
    { speaker: 'kef.FL', sub: 'kef.SW2', fc: 80, speakerBank: BANK_SPEAKER_A, subBank: BANK_SUB_S },
    { speaker: 'kef.FL', sub: 'kef.SW1', fc: 60, speakerBank: BANK_EMPTY, subBank: BANK_EMPTY },
    { speaker: 'bar.FL', sub: 'bar.SW1', fc: 80, speakerBank: BANK_SPEAKER_A, subBank: BANK_SUB_S },
    { speaker: 'bar.TML', sub: 'bar.SW1', fc: 120, speakerBank: BANK_SPEAKER_B, subBank: BANK_SUB_S2 },
    { speaker: 'bar.FL', sub: 'bar.SW1', fc: 40, speakerBank: BANK_SPEAKER_A, subBank: BANK_SUB_S },
  ];

  const goldens = {
    rewVersion: (await rew.request('/version'))?.message ?? null,
    generatedAt: new Date().toISOString(),
    irs: {},
    cases: [],
  };

  // IR d'entrée versionnées : l'état EXPORTÉ (inversion/offset intégrés) —
  // exactement ce que getImpulseResponseInfo donne au chemin interne en prod.
  const irCache = {};
  for (const key of Object.keys(uuids)) {
    irCache[key] = await fetchIr(uuids[key]);
    goldens.irs[key] = {
      sampleRate: irCache[key].sampleRate,
      startTime: irCache[key].startTime,
      data: Array.from(irCache[key].data, v => Number(v.toFixed(7))),
    };
  }

  let maxPeakDiff = 0;
  let maxFinalDiff = 0;
  let invertMismatches = 0;
  for (const { speaker, sub, fc, speakerBank, subBank } of CASES) {
    await applyBank(uuids[speaker], speakerBank);
    await applyBank(uuids[sub], subBank);

    const rewResult = await rewPath(uuids[speaker], uuids[sub], fc);
    const internal = internalPath(irCache[speaker], speakerBank, irCache[sub], subBank, fc);

    goldens.cases.push({ speaker, sub, fc, speakerBank, subBank, rew: rewResult });

    const peakDiff = Math.max(
      Math.abs(rewResult.speakerPeak - internal.speakerPeak),
      Math.abs(rewResult.subPeak - internal.subPeak),
    );
    maxPeakDiff = Math.max(maxPeakDiff, peakDiff);
    const bothOk = !rewResult.align.error && !internal.align.error;
    const finalDiffMs = bothOk
      ? Math.abs(rewResult.finalDistanceSeconds - internal.finalDistanceSeconds) * 1000
      : null;
    if (finalDiffMs !== null) maxFinalDiff = Math.max(maxFinalDiff, finalDiffMs);
    const invertMatch =
      Boolean(rewResult.align.invertB) === Boolean(internal.align.invertB) ||
      Boolean(rewResult.align.error) !== Boolean(internal.align.error);
    if (bothOk && rewResult.align.invertB !== internal.align.invertB) invertMismatches++;

    console.log(
      `${speaker}↔${sub}@${fc}  pics Δ=${(peakDiff * 1000).toFixed(4)} ms  ` +
        (bothOk
          ? `final REW=${(rewResult.finalDistanceSeconds * 1000).toFixed(3)} ms interne=${(internal.finalDistanceSeconds * 1000).toFixed(3)} ms Δ=${finalDiffMs.toFixed(3)} ms inv=${rewResult.align.invertB}/${internal.align.invertB}`
          : `REW: ${rewResult.align.error ?? 'ok'} | interne: ${internal.align.error ?? 'ok'}`) +
        (invertMatch ? '' : '  ⚠ INVERT'),
    );
  }

  // --- Cas multi-sub : « somme vraie » interne (Σ pondérée des eqIR des
  // subs) vs chemin prod complet (capture FR predicted par sub → somme
  // complexe → synthèse → import projection → eqGenerate + raccord REW).
  const SUM_CASES = [
    {
      label: 'm1', speaker: 'kef.FL', speakerBank: BANK_SPEAKER_A, fc: 80,
      subs: [
        { code: 'SW1', bank: BANK_SUB_S },
        { code: 'SW2', bank: BANK_SUB_S2, splOffsetDb: 3.5, offsetSeconds: 0.0017 },
      ],
    },
    {
      label: 'm2', speaker: 'kef.C', speakerBank: BANK_SPEAKER_B, fc: 120,
      subs: [
        { code: 'SW1', bank: BANK_SUB_S },
        { code: 'SW2', bank: BANK_SUB_S, offsetSeconds: -0.0023 },
        { code: 'SW3', bank: BANK_SUB_S2, splOffsetDb: -4 },
        { code: 'SW4', bank: BANK_SUB_S2 },
      ],
    },
    {
      label: 'm3', speaker: 'kef.FL', speakerBank: BANK_SPEAKER_A, fc: 80,
      subs: [{ code: 'SW1', bank: BANK_SUB_S2 }],
    },
  ];

  goldens.sumCases = [];
  let maxSumFinalDiff = 0;
  for (const { label, speaker, speakerBank, fc, subs: subDefs } of SUM_CASES) {
    const caseUuids = [];
    try {
      const subInputs = [];
      for (const def of subDefs) {
        const m = await importIr(`as-${label}-${def.code}`, irOf('kef', def.code));
        caseUuids.push(m.uuid);
        await applyBank(m.uuid, def.bank);
        if (def.splOffsetDb) {
          await rew.rewMeasurements.addSPLOffset(m.uuid, def.splOffsetDb);
          await sleep(300);
        }
        if (def.offsetSeconds) {
          await rew.rewMeasurements.offsetTZero(m.uuid, def.offsetSeconds);
          await sleep(300);
        }
        subInputs.push({ def, uuid: m.uuid });
      }
      await applyBank(uuids[speaker], speakerBank);

      // chemin prod : projection synthétisée depuis les FR predicted des subs
      const responses = [];
      for (const { uuid } of subInputs) {
        responses.push(await rew.rewMeasurements.getPredictedFrequencyResponse(uuid, {}));
      }
      const sum = calculateCombinedResponse(responses);
      const impulse = synthesizeImpulseFromResponse(sum, { sampleRate: 48000, center: true });
      const projection = await importIr(`as-${label}-LFE`, impulse.data, impulse.startTimeSeconds);
      caseUuids.push(projection.uuid);
      const rewResult = await rewPath(uuids[speaker], projection.uuid, fc);

      // entrées exactes du chemin interne, versionnées avec le golden
      const speakerEqIr = await fetchEqIr(uuids[speaker]);
      goldens.irs[`sum.${label}.speaker`] = {
        sampleRate: speakerEqIr.sampleRate,
        startTime: speakerEqIr.startTime,
        data: Array.from(speakerEqIr.data, v => Number(v.toFixed(7))),
      };
      const eqIrs = [];
      const weightsDb = [];
      for (const [i, { uuid }] of subInputs.entries()) {
        const eqIr = await fetchEqIr(uuid);
        const info = await infoOf(uuid);
        eqIrs.push(eqIr);
        weightsDb.push(info.splOffsetdB);
        goldens.irs[`sum.${label}.sub${i}`] = {
          sampleRate: eqIr.sampleRate,
          startTime: eqIr.startTime,
          data: Array.from(eqIr.data, v => Number(v.toFixed(7))),
        };
      }

      goldens.sumCases.push({ label, speaker, fc, subCount: subDefs.length, weightsDb, rew: rewResult });

      // chemin interne « somme vraie » — même arithmétique que produceAligned
      const speakerFiltered = applyBankAndCrossoverToIr(speakerEqIr, [], {
        type: 'High pass', frequency: fc, shape: 'BU', slopedBPerOctave: 12,
      });
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
      const shiftedSub = { ...subFiltered, startTime: subFiltered.startTime - finalDistance0 };
      let align;
      try {
        align = alignImpulseResponses(speakerFiltered, shiftedSub, {
          frequency: fc, minDelayMs: 0, maxDelayMs: maxForwardSearchMs,
        });
      } catch (error) {
        align = { error: error.message };
      }
      const bothOk = !rewResult.align.error && !align.error;
      const finalDiffMs = bothOk
        ? Math.abs(rewResult.finalDistanceSeconds - (finalDistance0 - align.delayMs / 1000)) * 1000
        : null;
      if (finalDiffMs !== null) maxSumFinalDiff = Math.max(maxSumFinalDiff, finalDiffMs);
      console.log(
        `SUM ${label} (${subDefs.length} subs)@${fc}  ` +
          (bothOk
            ? `final prod=${(rewResult.finalDistanceSeconds * 1000).toFixed(3)} ms interne=${((finalDistance0 - align.delayMs / 1000) * 1000).toFixed(3)} ms Δ=${finalDiffMs.toFixed(3)} ms inv=${rewResult.align.invertB}/${align.invertB}`
            : `prod: ${rewResult.align.error ?? 'ok'} | interne: ${align.error ?? 'ok'}`),
      );
    } finally {
      for (const uuid of caseUuids.toReversed()) await remove(uuid);
    }
  }

  writeFileSync(
    'test/fixtures/align-sub/goldens.json',
    JSON.stringify(goldens, null, 1) + '\n',
  );
  console.log(
    `\nΔ pic max ${(maxPeakDiff * 1000).toFixed(4)} ms, Δ final max ${maxFinalDiff.toFixed(3)} ms, Δ final somme max ${maxSumFinalDiff.toFixed(3)} ms, désaccords d'inversion : ${invertMismatches}`,
  );
  console.log('golden écrit: test/fixtures/align-sub/goldens.json');
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
