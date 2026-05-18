import assert from 'node:assert/strict';
import test from 'node:test';

import { FilterSet } from '../../src/dsp/FilterSet.js';
import { AutoEQCalculator } from '../../src/index.js';
import RewApi from '../../src/rew/rew-api.js';
import {
  adjustFilterPrecision,
  calculateEqualizationStats,
  calculateRMSError,
  createConfig,
  createNearestSampler,
  getWindowsHostIP,
  getRewMeasurementSampleRate,
  parseREWFile,
  parseREWFileAsAPI,
  projectResponseToReferenceGrid,
  toFrequencyResponse,
  toDataArray,
} from '../test-config.js';

const BASE_PATH = './tests-auto-eq/samples-96ppo';
const MEASUREMENT_FILE = 'Cavg.txt';
const TARGET_FILE = 'Target Mar 23 11_03_to_Target Mar 23 11_03.txt';
const FIXTURE_SAMPLE_RATE = 88200;
const MATCH_RANGE_START = 40;
const MATCH_RANGE_END = 3000;
const FULL_RANGE_START = 20;
const FULL_RANGE_END = 20000;
const HIGH_BAND_START = 8000;
const HIGH_BAND_END = 20000;
const FLATNESS_TARGET = 1;
const HIGH_BAND_POSITIVE_RMS_THRESHOLD = 1;
const REW_API_HIGH_BAND_DELTA_RMS_THRESHOLD = 0.4;
const REW_API_HIGH_BAND_DELTA_MEAN_THRESHOLD = 0.75;
const REW_EXPORT_HIGH_BAND_RMS_THRESHOLD = 0.5;
const REW_EXPORT_HIGH_BAND_P95_THRESHOLD = 1;

async function uploadResponseToRew(api, data) {
  return api.rewImport.importFrequencyResponseData({
    identifier: data.identifier,
    isImpedance: false,
    startFreq: data.freqs[0],
    freqStep: data.freqStep,
    magnitude: data.magnitude,
    phase: data.phase,
    ppo: data.ppo,
  });
}

function toRewFilterPayload(filters) {
  const payload = Array.from({ length: 22 }, (_, index) => ({
    index: index + 1,
    type: 'None',
    enabled: true,
    isAuto: true,
  }));

  filters.forEach((filter, index) => {
    payload[index] = {
      ...payload[index],
      type: 'PK',
      frequency: filter.fc,
      q: filter.Q,
      gaindB: filter.gain,
    };
  });

  return payload;
}

function calculateBandStats(data, targetFn, startFreq, endFreq) {
  const inRange = data.filter(point => point.freq >= startFreq && point.freq <= endFreq);
  const errors = inRange.map(point => point.spl - targetFn(point.freq));
  const sorted = [...errors].sort((left, right) => left - right);
  const rms = Math.sqrt(
    errors.reduce((sum, error) => sum + error * error, 0) / Math.max(errors.length, 1),
  );
  const positiveRms = Math.sqrt(
    errors.reduce((sum, error) => sum + Math.max(error, 0) ** 2, 0) /
      Math.max(errors.length, 1),
  );
  const mean = errors.reduce((sum, error) => sum + error, 0) / Math.max(errors.length, 1);
  const p95 =
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? Number.NaN;
  const max = errors.length > 0 ? Math.max(...errors) : Number.NaN;

  return {
    count: inRange.length,
    rms,
    positiveRms,
    mean,
    p95,
    max,
  };
}

function calculateCurveDeltaStats(referenceCurveFn, data, startFreq, endFreq) {
  const inRange = data.filter(point => point.freq >= startFreq && point.freq <= endFreq);
  const deltas = inRange.map(point => point.spl - referenceCurveFn(point.freq));
  const absDeltas = deltas.map(Math.abs).sort((left, right) => left - right);

  return {
    count: inRange.length,
    rms: Math.sqrt(
      deltas.reduce((sum, delta) => sum + delta * delta, 0) / Math.max(deltas.length, 1),
    ),
    mean: deltas.reduce((sum, delta) => sum + delta, 0) / Math.max(deltas.length, 1),
    p95Abs:
      absDeltas[Math.min(absDeltas.length - 1, Math.floor(absDeltas.length * 0.95))] ??
      Number.NaN,
    maxAbs: absDeltas.length > 0 ? absDeltas.at(-1) : Number.NaN,
  };
}

function buildEqualizedData(filters, measuredData, sampleRate = FIXTURE_SAMPLE_RATE) {
  const filterSet = new FilterSet(Math.max(filters.length, 1), sampleRate);
  filterSet.resetAll();

  filters.forEach((filter, index) => {
    const target = filterSet.filters[index];
    target.fc = filter.fc;
    target.Q = filter.Q;
    target.gain = filter.gain;
    target.filterType = 'PEAKING';
    target.enabled = true;
    target.calcBiquad();
  });

  return measuredData.map(point => {
    const response = filterSet.getCumulativeComplexResponse(point.freq);
    return {
      freq: point.freq,
      spl: point.spl + response.magnitudeDB,
    };
  });
}

function calculatePositiveRms(data, targetFn, startFreq, endFreq) {
  const inRange = data.filter(point => point.freq >= startFreq && point.freq <= endFreq);
  const sum = inRange.reduce((acc, point) => {
    const overshoot = Math.max(point.spl - targetFn(point.freq), 0);
    return acc + overshoot * overshoot;
  }, 0);
  return Math.sqrt(sum / Math.max(inRange.length, 1));
}

function countOvershoots(data, targetFn, startFreq, endFreq, threshold = 0.5) {
  return data.filter(point => {
    if (point.freq < startFreq || point.freq > endFreq) {
      return false;
    }
    return point.spl - targetFn(point.freq) > threshold;
  }).length;
}

function findMaxOvershoot(data, targetFn, startFreq, endFreq) {
  return data
    .filter(point => point.freq >= startFreq && point.freq <= endFreq)
    .reduce(
      (best, point) => {
        const overshoot = point.spl - targetFn(point.freq);
        if (overshoot > best.overshoot) {
          return { freq: point.freq, overshoot };
        }
        return best;
      },
      { freq: Number.NaN, overshoot: Number.NEGATIVE_INFINITY },
    );
}

test('Cavg local target regression', async () => {
  const measuredData = parseREWFile(`${BASE_PATH}/${MEASUREMENT_FILE}`);
  const targetData = parseREWFile(`${BASE_PATH}/${TARGET_FILE}`);

  const measuredResponse = toFrequencyResponse(measuredData);
  const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
  const targetCurve = createNearestSampler(targetResponse);
  const calculator = new AutoEQCalculator(
    createConfig(
      {
        sampleRate: FIXTURE_SAMPLE_RATE,
        flatnessTarget: FLATNESS_TARGET,
        equalizerManufacturer: 'Generic',
        equalizerModel: 'Generic',
        allowNarrowFiltersBelow200Hz: false,
        varyQAbove200Hz: false,
      },
      { silent: false, verbose: true },
    ),
  );

  console.log(`\n🎯 Cas isolé local: ${MEASUREMENT_FILE}`);
  console.log(`🎯 Cible locale: ${TARGET_FILE}`);
  console.log('='.repeat(70));

  await calculator.calculate(measuredResponse, targetResponse);

  const activeFilters = calculator.filterSet
    .getActiveFilters()
    .slice()
    .sort((left, right) => left.fc - right.fc);

  assert.ok(activeFilters.length > 0, 'Auto-EQ doit produire au moins un filtre actif');

  const equalizedData = buildEqualizedData(
    activeFilters,
    measuredData,
    FIXTURE_SAMPLE_RATE,
  );

  console.log(`\n📊 Filtres actifs Auto-EQ: ${activeFilters.length}`);

  console.log('\n📊 Statistiques mesure brute');
  calculateEqualizationStats(
    measuredData,
    MATCH_RANGE_START,
    MATCH_RANGE_END,
    measuredData,
    targetCurve,
  );

  console.log('\n📊 Statistiques Auto-EQ');
  calculateEqualizationStats(
    equalizedData,
    MATCH_RANGE_START,
    MATCH_RANGE_END,
    measuredData,
    targetCurve,
  );

  const measuredMidRms = calculateRMSError(
    measuredData,
    targetCurve,
    MATCH_RANGE_START,
    MATCH_RANGE_END,
  );
  const correctedMidRms = calculateRMSError(
    equalizedData,
    targetCurve,
    MATCH_RANGE_START,
    MATCH_RANGE_END,
  );
  const measuredFullRms = calculateRMSError(
    measuredData,
    targetCurve,
    FULL_RANGE_START,
    FULL_RANGE_END,
  );
  const correctedFullRms = calculateRMSError(
    equalizedData,
    targetCurve,
    FULL_RANGE_START,
    FULL_RANGE_END,
  );
  const measuredHighRms = calculateRMSError(
    measuredData,
    targetCurve,
    HIGH_BAND_START,
    HIGH_BAND_END,
  );
  const correctedHighRms = calculateRMSError(
    equalizedData,
    targetCurve,
    HIGH_BAND_START,
    HIGH_BAND_END,
  );
  const measuredHighPositiveRms = calculatePositiveRms(
    measuredData,
    targetCurve,
    HIGH_BAND_START,
    HIGH_BAND_END,
  );
  const correctedHighPositiveRms = calculatePositiveRms(
    equalizedData,
    targetCurve,
    HIGH_BAND_START,
    HIGH_BAND_END,
  );
  const measuredHighOvershoots = countOvershoots(
    measuredData,
    targetCurve,
    HIGH_BAND_START,
    HIGH_BAND_END,
  );
  const correctedHighOvershoots = countOvershoots(
    equalizedData,
    targetCurve,
    HIGH_BAND_START,
    HIGH_BAND_END,
  );
  const correctedHighMaxOvershoot = findMaxOvershoot(
    equalizedData,
    targetCurve,
    HIGH_BAND_START,
    HIGH_BAND_END,
  );
  const matchRangeImprovementPct = (1 - correctedMidRms / measuredMidRms) * 100;

  console.log('\n📈 Comparaison mesure brute vs Auto-EQ');
  console.log(
    `   RMS vs cible (${FULL_RANGE_START}-${FULL_RANGE_END} Hz): ` +
      `${measuredFullRms.toFixed(3)} dB -> ${correctedFullRms.toFixed(3)} dB`,
  );
  console.log(
    `   RMS vs cible (${MATCH_RANGE_START}-${MATCH_RANGE_END} Hz): ` +
      `${measuredMidRms.toFixed(3)} dB -> ${correctedMidRms.toFixed(3)} dB`,
  );
  console.log(
    `   Amélioration vs cible (${MATCH_RANGE_START}-${MATCH_RANGE_END} Hz): ` +
      `${matchRangeImprovementPct.toFixed(2)}%`,
  );
  console.log(
    `   RMS vs cible (${HIGH_BAND_START}-${HIGH_BAND_END} Hz): ` +
      `${measuredHighRms.toFixed(3)} dB -> ${correctedHighRms.toFixed(3)} dB`,
  );
  console.log(
    `   Positive-RMS vs cible (${HIGH_BAND_START}-${HIGH_BAND_END} Hz): ` +
      `${measuredHighPositiveRms.toFixed(3)} dB -> ${correctedHighPositiveRms.toFixed(3)} dB`,
  );
  console.log(
    `   Overshoots > 0.5 dB (${HIGH_BAND_START}-${HIGH_BAND_END} Hz): ` +
      `${measuredHighOvershoots} -> ${correctedHighOvershoots}`,
  );
  console.log(
    `   Overshoot max Auto-EQ (${HIGH_BAND_START}-${HIGH_BAND_END} Hz): ` +
      `${correctedHighMaxOvershoot.overshoot.toFixed(3)} dB @ ${correctedHighMaxOvershoot.freq.toFixed(0)} Hz`,
  );

  assert.ok(
    Number.isFinite(matchRangeImprovementPct),
    `Le calcul d'amélioration RMS sur ${MATCH_RANGE_START}-${MATCH_RANGE_END} Hz doit être fini`,
  );
  assert.ok(
    Number.isFinite(correctedHighPositiveRms),
    'Le calcul de la positive-RMS haute fréquence vers la cible doit être fini',
  );
  assert.ok(
    correctedHighPositiveRms <= HIGH_BAND_POSITIVE_RMS_THRESHOLD,
    `Régression HF: la positive-RMS Auto-EQ vers la cible sur ${HIGH_BAND_START}-${HIGH_BAND_END} Hz ` +
      `est de ${correctedHighPositiveRms.toFixed(3)} dB, au-dessus du seuil ` +
      `${HIGH_BAND_POSITIVE_RMS_THRESHOLD.toFixed(1)} dB`,
  );
});

test('Cavg REW API high-band parity regression', async t => {
  const measuredApiData = parseREWFileAsAPI(`${BASE_PATH}/${MEASUREMENT_FILE}`);
  const measuredLocalData = parseREWFile(`${BASE_PATH}/${MEASUREMENT_FILE}`);
  const windowsHost = getWindowsHostIP();
  const apiService = new RewApi(`http://${windowsHost}:4735`, false, true);

  try {
    await apiService.initializeAPI();
  } catch {
    t.skip('REW API non disponible');
    return;
  }

  await apiService.rewMeasurements.deleteAll();
  await uploadResponseToRew(apiService, measuredApiData);

  const measurementId = 1;
  await apiService.rewMeasurements.setEqualiser(
    measurementId,
    apiService.rewEq.defaulEqtSettings,
  );
  await apiService.rewMeasurements.resetTargetSettings(measurementId);
  await apiService.rewMeasurements.resetRoomCurveSettings(measurementId);

  const measurementSampleRate = await getRewMeasurementSampleRate(
    apiService,
    measurementId,
    FIXTURE_SAMPLE_RATE,
  );

  const targetData = await apiService.rewMeasurements.getTargetResponse(measurementId);
  const measuredResponse = toFrequencyResponse(measuredLocalData);
  const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
  const targetCurve = createNearestSampler(targetResponse);

  await apiService.rewEq.setMatchTargetSettings({
    startFrequency: 20,
    endFrequency: 20000,
    individualMaxBoostdB: 6,
    overallMaxBoostdB: 6,
    flatnessTargetdB: FLATNESS_TARGET,
    allowNarrowFiltersBelow200Hz: false,
    varyQAbove200Hz: false,
    allowLowShelf: false,
    allowHighShelf: false,
  });

  await apiService.rewMeasurements.matchTarget(measurementId);
  await apiService.rewMeasurements.generatePredictedMeasurement(measurementId);
  const rewEqualizedData = toDataArray(
    await apiService.rewMeasurements.getPredictedFrequencyResponse(measurementId),
  );

  const calculator = new AutoEQCalculator(
    createConfig(
      {
        sampleRate: measurementSampleRate,
        flatnessTarget: FLATNESS_TARGET,
        equalizerManufacturer: 'Generic',
        equalizerModel: 'Generic',
        allowNarrowFiltersBelow200Hz: false,
        varyQAbove200Hz: false,
      },
      { silent: true, verbose: false },
    ),
  );
  await calculator.calculate(measuredResponse, targetResponse);

  const activeFilters = calculator.filterSet
    .getActiveFilters()
    .slice()
    .sort((left, right) => left.fc - right.fc);
  adjustFilterPrecision(activeFilters);

  const localEqualizedData = buildEqualizedData(
    activeFilters,
    measuredLocalData,
    measurementSampleRate,
  );

  await apiService.rewMeasurements.postFilters(measurementId, {
    filters: toRewFilterPayload(activeFilters),
  });
  await apiService.rewMeasurements.generatePredictedMeasurement(measurementId);
  const rewPredictedFromAutoEQ = toDataArray(
    await apiService.rewMeasurements.getPredictedFrequencyResponse(measurementId),
  );

  const rewHighBandStats = calculateBandStats(
    rewEqualizedData,
    targetCurve,
    HIGH_BAND_START,
    HIGH_BAND_END,
  );
  const autoHighBandStats = calculateBandStats(
    rewPredictedFromAutoEQ,
    targetCurve,
    HIGH_BAND_START,
    HIGH_BAND_END,
  );
  const rewPredictedCurve = createNearestSampler(rewPredictedFromAutoEQ);
  const localVsRewHighBandStats = calculateCurveDeltaStats(
    rewPredictedCurve,
    localEqualizedData,
    HIGH_BAND_START,
    HIGH_BAND_END,
  );

  console.log('\n📉 Parité HF REW API vs Auto-EQ exporté');
  console.log(`   Sample rate REW mesure: ${measurementSampleRate} Hz`);
  console.log(
    `   REW RMS/mean (8-20 kHz): ${rewHighBandStats.rms.toFixed(3)} dB / ${rewHighBandStats.mean.toFixed(3)} dB`,
  );
  console.log(
    `   Auto RMS/mean (8-20 kHz): ${autoHighBandStats.rms.toFixed(3)} dB / ${autoHighBandStats.mean.toFixed(3)} dB`,
  );
  console.log(
    `   Ecart local vs REW exporté (8-20 kHz): RMS ${localVsRewHighBandStats.rms.toFixed(3)} dB, P95 abs ${localVsRewHighBandStats.p95Abs.toFixed(3)} dB`,
  );

  assert.ok(
    autoHighBandStats.rms <= rewHighBandStats.rms + REW_API_HIGH_BAND_DELTA_RMS_THRESHOLD,
    `Régression HF REW API: RMS 8-20 kHz Auto-EQ ${autoHighBandStats.rms.toFixed(3)} dB ` +
      `vs REW ${rewHighBandStats.rms.toFixed(3)} dB, delta ${(autoHighBandStats.rms - rewHighBandStats.rms).toFixed(3)} dB ` +
      `au-dessus du seuil ${REW_API_HIGH_BAND_DELTA_RMS_THRESHOLD.toFixed(2)} dB`,
  );
  assert.ok(
    autoHighBandStats.mean <=
      rewHighBandStats.mean + REW_API_HIGH_BAND_DELTA_MEAN_THRESHOLD ||
      Math.abs(autoHighBandStats.mean) <= Math.abs(rewHighBandStats.mean),
    `Régression HF REW API: biais moyen 8-20 kHz Auto-EQ ${autoHighBandStats.mean.toFixed(3)} dB ` +
      `vs REW ${rewHighBandStats.mean.toFixed(3)} dB, delta ${(autoHighBandStats.mean - rewHighBandStats.mean).toFixed(3)} dB ` +
      `au-dessus du seuil ${REW_API_HIGH_BAND_DELTA_MEAN_THRESHOLD.toFixed(2)} dB`,
  );
  assert.ok(
    localVsRewHighBandStats.rms <= REW_EXPORT_HIGH_BAND_RMS_THRESHOLD,
    `Régression export REW: l'écart RMS local vs REW sur 8-20 kHz est de ${localVsRewHighBandStats.rms.toFixed(3)} dB, ` +
      `au-dessus du seuil ${REW_EXPORT_HIGH_BAND_RMS_THRESHOLD.toFixed(2)} dB`,
  );
  assert.ok(
    localVsRewHighBandStats.p95Abs <= REW_EXPORT_HIGH_BAND_P95_THRESHOLD,
    `Régression export REW: le P95 absolu local vs REW sur 8-20 kHz est de ${localVsRewHighBandStats.p95Abs.toFixed(3)} dB, ` +
      `au-dessus du seuil ${REW_EXPORT_HIGH_BAND_P95_THRESHOLD.toFixed(2)} dB`,
  );
});
