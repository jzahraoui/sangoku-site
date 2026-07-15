/**
 * probe-hp-lr24.mjs — sonde REW réel (chantier raccord crossover v2).
 *
 * Ancre versionnée de la chaîne de preuve de l'export OCA (citée par
 * test/auto-eq/oca-internal-generation.test.js) : vérifie que l'API REW
 * accepte le filtre de raccord { type:'High pass', shape:'L-R',
 * slopedBPerOctave:24 } (nécessaire au chemin preview du remède A « BW12
 * électrique ») et que, dans REW, « High pass L-R 24 » == 2× « High pass
 * BU 12 » (bit-exact) et type « HP » == « High pass BU 12 ». À relancer sur
 * un nouveau build REW si la revalidation de ces faits s'impose.
 * Contrôle : parité HP BU 12 (déjà démontrée, calibre le quantum attendu).
 *
 * IR d'entrée : kef.FL des goldens versionnés (test/fixtures/align-sub).
 * Nettoie la mesure temporaire en fin de run.
 *
 * Usage (REW réel requis) : node test/auto-eq/rew/probe-hp-lr24.mjs
 */
import { readFileSync } from 'node:fs';
import RewApi from '../../../src/rew/rew-api.js';
import { BiquadFilter } from '../../../src/dsp/BiquadFilter.js';
import { processThroughCascade } from '../../../src/dsp/impulseResponse.js';
import { getWindowsHostIP } from '../test-config.js';

const rew = new RewApi(`http://${getWindowsHostIP()}:4735`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const FC = 80;
const SLOT = 21;

const listMeasurements = () => rew.request('/measurements');

async function waitForNew(before, label) {
  for (let i = 0; i < 100; i++) {
    const all = await listMeasurements();
    const found = Object.values(all).find(m => !before.has(m.uuid));
    if (found) return found;
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * Écart max échantillon à échantillon après recalage des référentiels t=0
 * (startTime REW ≠ startTime de l'IR brute : décalage entier d'échantillons).
 */
function maxDiffAligned(pred, predStart, internal, rawStart, sampleRate) {
  const offset = Math.round((rawStart - predStart) * sampleRate);
  let worst = 0;
  let count = 0;
  for (let i = 0; i < internal.length; i++) {
    const j = i + offset;
    if (j < 0 || j >= pred.length) continue;
    worst = Math.max(worst, Math.abs(pred[j] - internal[i]));
    count++;
  }
  if (!count) throw new Error(`aucun recouvrement (offset ${offset})`);
  return worst;
}

async function predictedIrWithFilters(uuid, settings) {
  const posed = settings.map((setting, i) => ({
    index: setting.index ?? SLOT + i,
    enabled: true,
    isAuto: false,
    ...setting,
  }));
  await rew.request(`/measurements/${uuid}/filters`, 'POST', { filters: posed });
  await sleep(200);
  const bank = Object.values(await rew.request(`/measurements/${uuid}/filters`));
  const echo = posed.map(p => bank.find(f => f.index === p.index));
  const body = await rew.rewMeasurements.getPredictedImpulseResponse(uuid, {
    unit: 'percent',
    windowed: false,
    normalised: false,
  });
  await rew.request(`/measurements/${uuid}/filters`, 'POST', {
    filters: posed.map(p => ({ index: p.index, type: 'None', enabled: true, isAuto: false })),
  });
  await sleep(100);
  return { echo, ir: body };
}

function internalCascadeIr(rawIr, highPassCount) {
  const cascade = [];
  for (let i = 0; i < highPassCount; i++) {
    const hp = new BiquadFilter(rawIr.sampleRate);
    hp.setHighPass(FC);
    cascade.push(hp);
  }
  return processThroughCascade(rawIr.data, cascade);
}

async function main() {
  console.log('REW:', JSON.stringify(await rew.request('/version')));
  const goldens = JSON.parse(
    readFileSync('test/fixtures/align-sub/goldens.json', 'utf-8'),
  );
  const samples = Float64Array.from(goldens.irs['kef.FL'].data, Number);

  const before = new Set(Object.values(await listMeasurements()).map(m => m.uuid));
  await rew.request('/import/impulse-response-data', 'POST', {
    identifier: 'probe-hp-lr24',
    startTime: 0,
    sampleRate: 48000,
    splOffset: 80,
    applyCal: false,
    data: RewApi.encodeFloat32ToBase64(new Float32Array(samples)),
  });
  const measurement = await waitForNew(before, 'import');
  const uuid = measurement.uuid;

  try {
    // Équaliseur Generic requis pour les types HP/LP (même reset que
    // applyCutOffFilter en production).
    await rew.rewMeasurements.setEqualiser(uuid, {
      manufacturer: 'Generic',
      model: 'Generic',
    });
    const raw = await rew.rewMeasurements.getImpulseResponse(uuid, {
      unit: 'percent',
      windowed: false,
      normalised: false,
    });
    console.log(`IR importée: ${raw.data.length} éch. @ ${raw.sampleRate} Hz`);
    const scale = Math.max(...raw.data.map(Math.abs));

    const buSetting = { type: 'High pass', frequency: FC, shape: 'BU', slopedBPerOctave: 12 };
    const lrSetting = { type: 'High pass', frequency: FC, shape: 'L-R', slopedBPerOctave: 24 };

    // Référence REW : deux BU12 en cascade (deux slots, même fc)
    const bu2 = await predictedIrWithFilters(uuid, [buSetting, buSetting]);
    console.log(`\n2× HP BU 12 @${FC} — écho REW: ${JSON.stringify(bu2.echo)}`);

    // Sonde : HP L-R 24 (un seul slot)
    const lr = await predictedIrWithFilters(uuid, [lrSetting]);
    console.log(`HP L-R 24  @${FC} — écho REW: ${JSON.stringify(lr.echo)}`);
    const accepted =
      lr.echo?.[0]?.type === 'High pass' &&
      lr.echo?.[0]?.shape === 'L-R' &&
      Number(lr.echo?.[0]?.slopedBPerOctave) === 24;

    // Sémantique interne à REW : predicted(L-R 24) == predicted(BU12 × BU12) ?
    const semDiff =
      maxDiffAligned(lr.ir.data, lr.ir.startTime ?? 0, bu2.ir.data, bu2.ir.startTime ?? 0, raw.sampleRate) /
      scale;
    console.log(`\nREW vs REW — L-R 24 vs 2× BU 12 : max|Δ|/pic = ${semDiff.toExponential(3)}`);

    // Maillon de la chaîne d'ancrage golden de l'export OCA :
    // le type de filtre « HP » (déjà golden au quantum float32 contre notre
    // setHighPass, test/fixtures/oca/filter-types.json) est-il identique,
    // dans REW, au filtre de raccord « High pass BU 12 » ?
    const hpType = await predictedIrWithFilters(uuid, [
      { index: 1, type: 'HP', frequency: FC },
    ]);
    const buSingle = await predictedIrWithFilters(uuid, [buSetting]);
    const typeDiff =
      maxDiffAligned(
        hpType.ir.data,
        hpType.ir.startTime ?? 0,
        buSingle.ir.data,
        buSingle.ir.startTime ?? 0,
        raw.sampleRate,
      ) / scale;
    console.log(
      `REW vs REW — type HP vs High pass BU 12 : max|Δ|/pic = ${typeDiff.toExponential(3)}`,
    );

    // Indicatif : écart REW predicted vs cascade biquad locale (conventions
    // de calcul différentes — la parité produit passe par les goldens, pas ici)
    const lrInternal = internalCascadeIr(raw, 2);
    const lrDiff =
      maxDiffAligned(lr.ir.data, lr.ir.startTime ?? 0, lrInternal, raw.startTime ?? 0, raw.sampleRate) /
      scale;
    console.log(`Indicatif — L-R 24 REW vs 2× setHighPass local : max|Δ|/pic = ${lrDiff.toExponential(3)}`);

    let semantics = 'À INVESTIGUER';
    if (semDiff < 1e-6) semantics = 'EXACTE';
    else if (semDiff < 1e-3) semantics = 'OK (quantum)';
    console.log(
      `\nVERDICT: écho ${accepted ? 'ACCEPTÉ' : 'REFUSÉ/ALTÉRÉ'}, ` +
        `sémantique LR24=BU12² ${semantics}`,
    );
  } finally {
    await rew.request(`/measurements/${uuid}`, 'DELETE');
    console.log('mesure temporaire supprimée');
  }
}

await main();
