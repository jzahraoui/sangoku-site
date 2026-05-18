/**
 * rew-api-filters.test.js
 * Compare Auto-EQ filter response against REW's match-target via the REW API.
 */

import { AutoEQCalculator } from '../../src/index.js';
import RewApi from '../../src/rew/rew-api.js';
import {
  createNearestSampler,
  createConfig,
  getRewMeasurementSampleRate,
  resolveRewApiBaseUrl,
  parseREWFileAsAPI,
  projectResponseToReferenceGrid,
  DEFAULT_CONFIG,
  toFrequencyResponse,
} from '../test-config.js';

const EQ_CONFIG = {
  ...DEFAULT_CONFIG,
  startFrequency: DEFAULT_CONFIG.matchRangeStart,
  endFrequency: DEFAULT_CONFIG.matchRangeEnd,
  individualMaxBoostdB: 3,
  individualMaxBoostDb: 3,
  overallMaxBoostdB: DEFAULT_CONFIG.overallMaxBoostDb,
  overallMaxBoostDb: DEFAULT_CONFIG.overallMaxBoostDb,
  flatnessTargetdB: DEFAULT_CONFIG.flatnessTarget,
  flatnessTarget: DEFAULT_CONFIG.flatnessTarget,
  allowNarrowFiltersBelow200Hz: false,
  varyQAbove200Hz: false,
  allowLowShelf: false,
  allowHighShelf: false,
  equalizerManufacturer: 'Generic',
  equalizerModel: 'Generic',
};

const MAX_TOLERANCE_DB = 1;
const FR_OPTIONS = { unit: 'SPL', ppo: 48 };

async function getLastMeasurementUUID(api) {
  const entries = Object.values(await api.rewMeasurements.list());
  if (entries.length === 0) throw new Error('Aucune mesure dans REW après import');
  return entries.at(-1).uuid;
}

async function generateFilterResponse(api, measuredDataIndex) {
  const result = await api.rewMeasurements.generateFiltersMeasurement(measuredDataIndex);
  const uuid =
    Object.values(result?.results ?? {}).at(0)?.UUID ??
    (await getLastMeasurementUUID(api));
  return api.rewMeasurements.getFrequencyResponse(uuid, FR_OPTIONS);
}

function buildFilterSlots(activeFilters) {
  const numSlots = Math.max(22, activeFilters.length);
  return Array.from({ length: numSlots }, (_, i) =>
    i < activeFilters.length
      ? {
          index: i + 1,
          type: 'PK',
          enabled: true,
          isAuto: true,
          frequency: activeFilters[i].fc,
          q: activeFilters[i].Q,
          gaindB: activeFilters[i].gain,
        }
      : { index: i + 1, type: 'None', enabled: true, isAuto: true },
  );
}

function compareResponses(filterResponseREW, filterResponseAEQ) {
  const filterREW = createNearestSampler(filterResponseREW);
  const filterAEQ = createNearestSampler(filterResponseAEQ);
  const n = filterResponseREW.freqs.length;

  let maxDiff = 0;
  let maxDiffFreq = 0;
  let sumSqDiff = 0;
  let countOver1 = 0;
  const top5 = []; // min-heap of size 5

  for (const f of filterResponseREW.freqs) {
    const rewVal = filterREW(f);
    const aeqVal = filterAEQ(f);
    const diff = Math.abs(rewVal - aeqVal);
    sumSqDiff += diff * diff;
    if (diff > MAX_TOLERANCE_DB) countOver1++;
    if (diff > maxDiff) {
      maxDiff = diff;
      maxDiffFreq = f;
    }
    if (top5.length < 5 || diff > top5[0].diff) {
      if (top5.length >= 5) top5.shift();
      top5.push({ freq: f, diff, rew: rewVal, aeq: aeqVal });
      top5.sort((a, b) => a.diff - b.diff);
    }
  }

  const rmsDiff = Math.sqrt(sumSqDiff / n);
  top5.sort((a, b) => b.diff - a.diff);

  console.log(`   Max diff: ${maxDiff.toFixed(3)} dB @ ${maxDiffFreq.toFixed(1)} Hz`);
  console.log(`   RMS diff: ${rmsDiff.toFixed(3)} dB`);
  console.log(`   Points >${MAX_TOLERANCE_DB} dB: ${countOver1}/${n}`);
  console.log('   Top 5 worst:');
  for (const p of top5) {
    console.log(
      `     ${p.freq.toFixed(1)} Hz: REW=${p.rew.toFixed(2)}, AEQ=${p.aeq.toFixed(2)}, diff=${p.diff.toFixed(3)} dB`,
    );
  }

  return { maxDiff, maxDiffFreq, rmsDiff, countOver1, n };
}

// ============================================================================
// MAIN PROCESSING
// ============================================================================

async function processMeasurement(api, file, basePath) {
  // Load & upload measurement
  const measuredData = parseREWFileAsAPI(`${basePath}/${file}`);
  console.log(`\n📂 ${file}: ${measuredData.freqs.length} points`);

  await api.rewImport.importFrequencyResponseData({
    identifier: measuredData.identifier,
    isImpedance: false,
    startFreq: measuredData.freqs[0],
    freqStep: measuredData.freqStep,
    magnitude: measuredData.magnitude,
    phase: measuredData.phase,
    ppo: measuredData.ppo,
  });
  const measuredDataIndex = await getLastMeasurementUUID(api);

  // Configure measurement in REW
  await api.rewMeasurements.setEqualiser(measuredDataIndex, api.rewEq.defaulEqtSettings);
  await api.rewMeasurements.resetTargetSettings(measuredDataIndex);
  await api.rewMeasurements.resetRoomCurveSettings(measuredDataIndex);
  const measurementSampleRate = await getRewMeasurementSampleRate(api, measuredDataIndex);
  const targetData = await api.rewMeasurements.getTargetResponse(measuredDataIndex);

  const targetAt1k = createNearestSampler(targetData)(1000);
  if (targetAt1k < 50 || targetAt1k > 100) {
    throw new Error(
      `Target invalide pour ${file}: SPL@1kHz=${targetAt1k.toFixed(1)} dB (attendu 50-100)`,
    );
  }

  // --- REW match target ---
  await api.rewEq.setMatchTargetSettings(EQ_CONFIG);
  const rewStart = Date.now();
  await api.rewMeasurements.matchTarget(measuredDataIndex);
  const rewElapsedMs = Date.now() - rewStart;
  console.log(`\n✅ REW terminé en ${(rewElapsedMs / 1000).toFixed(2)}s`);

  const rewActiveFilters = Object.values(
    await api.rewMeasurements.getFilters(measuredDataIndex),
  ).filter(f => f.type !== 'None' && f.enabled);
  console.log(`   ${rewActiveFilters.length} filtre(s) actif(s)`);

  const filterResponseREW = await generateFilterResponse(api, measuredDataIndex);

  // --- Auto-EQ ---
  const measuredResponse = toFrequencyResponse(measuredData);
  const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
  const calculator = new AutoEQCalculator(
    createConfig(
      { ...EQ_CONFIG, sampleRate: measurementSampleRate },
      { silent: false, verbose: true },
    ),
  );

  const aeqStart = Date.now();
  const result = await calculator.calculate(measuredResponse, targetResponse);
  const aeqElapsedMs = Date.now() - aeqStart;
  console.log(`\n✅ Auto-EQ terminé en ${(aeqElapsedMs / 1000).toFixed(2)}s`);
  console.log(`   Sample rate mesure REW: ${measurementSampleRate} Hz`);

  const activeFilters = result.filters.sort((a, b) => a.fc - b.fc);
  for (const f of activeFilters) {
    f.fc = Math.round(f.fc * 10) / 10;
    f.gain = Math.round(f.gain * 10) / 10;
    f.Q = Math.round(f.Q * 1000) / 1000;
  }
  console.log(`   ${activeFilters.length} filtres actifs`);

  // Upload our filters to REW and get the response
  await api.rewMeasurements.postFilters(measuredDataIndex, {
    filters: buildFilterSlots(activeFilters),
  });
  const filterResponseAEQ = await generateFilterResponse(api, measuredDataIndex);

  // --- Compare ---
  console.log('\n📊 Comparaison des réponses de filtres:');
  const { maxDiff, maxDiffFreq, countOver1 } = compareResponses(
    filterResponseREW,
    filterResponseAEQ,
  );

  if (countOver1 > 0) {
    throw new Error(
      `${countOver1} point(s) dépassent ${MAX_TOLERANCE_DB} dB. ` +
        `Max diff: ${maxDiff.toFixed(3)} dB @ ${maxDiffFreq.toFixed(1)} Hz`,
    );
  }

  if (aeqElapsedMs > rewElapsedMs * 2) {
    throw new Error(
      `Auto-EQ (${(aeqElapsedMs / 1000).toFixed(2)}s) est plus de 2× REW (${(rewElapsedMs / 1000).toFixed(2)}s)`,
    );
  }

  console.log('\n🎉 Test terminé avec succès!');
}

// ============================================================================
// ENTRY POINT
// ============================================================================

console.log('🎵 Test Auto-EQ vs REW API\n' + '='.repeat(70));

const apiService = new RewApi(await resolveRewApiBaseUrl(), false, true);
await apiService.initializeAPI();
await apiService.rewMeasurements.deleteAll();

await apiService.rewEq.request('/eq/command', 'POST', {
  command: 'Generate target measurement',
});

const basePath = './tests-auto-eq/samples-96ppo';
const measurementFiles = ['Cavg.txt'];
const failures = [];

for (const file of measurementFiles) {
  try {
    await processMeasurement(apiService, file, basePath);
  } catch (error) {
    console.error(`\n❌ ${file}: ${error.message}`);
    failures.push({ file, error: error.message });
  }
}

console.log('\n' + '='.repeat(70));
if (failures.length > 0) {
  console.error(`❌ ${failures.length}/${measurementFiles.length} échec(s):`);
  failures.forEach(({ file, error }) => console.error(`   • ${file}: ${error}`));
  process.exit(1);
}
console.log(`✅ ${measurementFiles.length}/${measurementFiles.length} fichiers OK`);
