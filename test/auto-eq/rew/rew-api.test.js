/**
 * test-rew-files.js
 * Test avec fichiers REW réels: FRavg.txt et Target Harmon 75.42dB.txt
 * Génère un fichier résultat importable dans REW
 */

import { AutoEQCalculator } from '../../../src/index.js';
import RewApi from '../../../src/rew/rew-api.js';
import {
  createNearestSampler,
  createConfig,
  calculateRMSError,
  calculateEqualizationStats,
  getWindowsHostIP,
  getRewMeasurementSampleRate,
  adjustFilterPrecision,
  parseREWFileAsAPI,
  projectResponseToReferenceGrid,
  toDataArray,
  toFrequencyResponse,
} from '../test-config.js';

/**
 * Évalue la qualité d'un filtre audio basée sur des critères perceptuels
 * @param {Object} filterResponse - Réponse en fréquence {freqs, magnitude, phase, ppo, startFreq}
 * @param {Object} groupDelay - Délai de groupe {freqs, magnitude (en secondes), ppo, startFreq}
 * @returns {Object} Résultats de l'évaluation avec scores et avertissements
 */
function analyzeGroupDelay(
  gdMag,
  gdFreqs,
  matchRangeStart,
  matchRangeEnd,
  warnings,
  scores,
) {
  // Convertir en millisecondes pour l'analyse
  const gdMs = Array.from(gdMag).map(v => v * 1000);

  // Statistiques du group delay
  const gdMin = Math.min(...gdMs);
  const gdMax = Math.max(...gdMs);
  const gdRange = gdMax - gdMin;

  // Variation du group delay (dérivée)
  const gdVariation = [];
  for (let i = 1; i < gdMs.length; i++) {
    gdVariation.push(Math.abs(gdMs[i] - gdMs[i - 1]));
  }
  const gdMaxVariation = Math.max(...gdVariation);

  console.log(`      Min: ${gdMin.toFixed(2)} ms, Max: ${gdMax.toFixed(2)} ms`);
  console.log(`      Plage totale: ${gdRange.toFixed(2)} ms`);
  console.log(`      Variation max entre points: ${gdMaxVariation.toFixed(3)} ms`);

  // Seuils perceptuels pour le group delay
  // < 1.5 ms: inaudible, 1.5-3 ms: subtil, > 3 ms: audible, > 10 ms: problématique
  if (gdRange > 20) {
    warnings.push(
      `⚠️  CRITIQUE: Variation GD excessive (${gdRange.toFixed(1)} ms) - Smearing temporel probable`,
    );
    scores.groupDelay = 0;
  } else if (gdRange > 10) {
    warnings.push(
      `⚠️  Variation GD élevée (${gdRange.toFixed(1)} ms) - Peut affecter la cohérence temporelle`,
    );
    scores.groupDelay = 50;
  } else if (gdRange > 5) {
    warnings.push(
      `⚡ Variation GD modérée (${gdRange.toFixed(1)} ms) - Généralement acceptable`,
    );
    scores.groupDelay = 75;
  } else {
    scores.groupDelay = 100;
  }

  // Vérifier le group delay dans les basses (< 200 Hz) - plus critique
  const lowFreqGD = [];
  for (let i = 0; i < gdFreqs.length; i++) {
    if (
      gdFreqs[i] >= matchRangeStart &&
      gdFreqs[i] <= matchRangeEnd &&
      gdFreqs[i] <= 200
    ) {
      lowFreqGD.push(gdMs[i]);
    }
  }
  if (lowFreqGD.length > 0) {
    const lowFreqGDRange = Math.max(...lowFreqGD) - Math.min(...lowFreqGD);
    console.log(
      `      Plage GD basses fréquences (${matchRangeStart}-${Math.min(matchRangeEnd, 200)} Hz): ${lowFreqGDRange.toFixed(2)} ms`,
    );
    if (lowFreqGDRange > 15) {
      warnings.push(
        `⚠️  GD élevé en basses fréquences (${lowFreqGDRange.toFixed(1)} ms) - Impact sur punch/définition`,
      );
    }
  }
}

function analyzeMagnitude(frMag, warnings, scores) {
  const magArray = Array.from(frMag);
  const magMin = Math.min(...magArray);
  const magMax = Math.max(...magArray);
  const magRange = magMax - magMin;

  // Énergie totale (somme des corrections en dB)
  const totalBoost = magArray.filter(v => v > 0).reduce((a, b) => a + b, 0);
  const totalCut = magArray.filter(v => v < 0).reduce((a, b) => a + Math.abs(b), 0);

  console.log(
    `      Gain max: ${magMax.toFixed(2)} dB, Cut max: ${magMin.toFixed(2)} dB`,
  );
  console.log(`      Plage totale: ${magRange.toFixed(2)} dB`);
  console.log(
    `      Boost total: +${totalBoost.toFixed(1)} dB, Cut total: -${totalCut.toFixed(1)} dB`,
  );

  // Évaluer les corrections excessives
  if (magMax > 6) {
    warnings.push(
      `⚠️  Boost élevé (+${magMax.toFixed(1)} dB) - Risque de distorsion/clipping`,
    );
    scores.magnitude = Math.max(0, 100 - (magMax - 6) * 10);
  } else if (magMax > 3) {
    scores.magnitude = 80;
  } else {
    scores.magnitude = 100;
  }

  if (Math.abs(magMin) > 12) {
    warnings.push(
      `⚠️  Cut très profond (${magMin.toFixed(1)} dB) - Peut affecter le naturel du son`,
    );
    scores.magnitude = Math.min(scores.magnitude, 60);
  }

  return magArray;
}

function analyzeSlewRate(frFreqs, magArray, warnings, scores) {
  // Calculer le taux de changement en dB/octave
  const slewRates = [];
  for (let i = 1; i < frFreqs.length; i++) {
    const freqRatio = Math.log2(frFreqs[i] / frFreqs[i - 1]); // en octaves
    if (freqRatio > 0) {
      const dbChange = Math.abs(magArray[i] - magArray[i - 1]);
      const slewRate = dbChange / freqRatio; // dB/octave
      slewRates.push({ freq: frFreqs[i], rate: slewRate });
    }
  }

  const maxSlewRate = Math.max(...slewRates.map(s => s.rate));
  const maxSlewFreq = slewRates.find(s => s.rate === maxSlewRate)?.freq || 0;
  const avgSlewRate = slewRates.reduce((a, b) => a + b.rate, 0) / slewRates.length;

  console.log(
    `      Pente max: ${maxSlewRate.toFixed(1)} dB/octave @ ${maxSlewFreq.toFixed(0)} Hz`,
  );
  console.log(`      Pente moyenne: ${avgSlewRate.toFixed(2)} dB/octave`);

  // Pentes > 12 dB/octave peuvent être audibles, > 24 dB/octave problématiques
  if (maxSlewRate > 24) {
    warnings.push(
      `⚠️  Pente très raide (${maxSlewRate.toFixed(0)} dB/oct @ ${maxSlewFreq.toFixed(0)} Hz) - Artefacts possibles`,
    );
    scores.slewRate = 50;
  } else if (maxSlewRate > 12) {
    scores.slewRate = 75;
  } else {
    scores.slewRate = 100;
  }
}

function analyzeBandsAndSummary(frFreqs, magArray, scores, warnings) {
  // =========================================================================
  // 5. COHÉRENCE BANDES DE FRÉQUENCES
  // =========================================================================
  console.log('\n   📊 Équilibre par bande:');

  const bands = [
    { name: 'Sub (20-60)', start: 20, end: 60 },
    { name: 'Bass (60-250)', start: 60, end: 250 },
    { name: 'Mid (250-2k)', start: 250, end: 2000 },
    { name: 'Hi-Mid (2k-6k)', start: 2000, end: 6000 },
    { name: 'High (6k-20k)', start: 6000, end: 20000 },
  ];

  const bandStats = bands
    .map(band => {
      const bandMag = [];
      for (let i = 0; i < frFreqs.length; i++) {
        if (frFreqs[i] >= band.start && frFreqs[i] < band.end) {
          bandMag.push(magArray[i]);
        }
      }
      if (bandMag.length === 0) return null;

      const avg = bandMag.reduce((a, b) => a + b, 0) / bandMag.length;
      const max = Math.max(...bandMag);
      const min = Math.min(...bandMag);
      return { name: band.name, avg, max, min, range: max - min };
    })
    .filter(Boolean);

  bandStats.forEach(b => {
    const sign = b.avg >= 0 ? '+' : '';
    console.log(
      `      ${b.name.padEnd(15)}: avg ${sign}${b.avg.toFixed(
        1,
      )} dB, range ${b.range.toFixed(1)} dB`,
    );
  });

  // =========================================================================
  // 6. SCORE GLOBAL ET RÉSUMÉ
  // =========================================================================
  const validScores = Object.values(scores).filter(v => typeof v === 'number');
  const overallScore = validScores.reduce((a, b) => a + b, 0) / validScores.length;

  console.log("\n   📊 Résumé de l'évaluation:");
  console.log(`      Score Group Delay: ${scores.groupDelay}/100`);
  console.log(`      Score Magnitude: ${scores.magnitude}/100`);
  console.log(`      Score Pentes: ${scores.slewRate}/100`);
  if (scores.phase) console.log(`      Score Phase: ${scores.phase}/100`);
  console.log(`      ────────────────────────`);
  console.log(`      Score Global: ${overallScore.toFixed(0)}/100`);

  if (warnings.length > 0) {
    console.log('\n   ⚠️  Avertissements:');
    warnings.forEach(w => console.log(`      ${w}`));
  } else {
    console.log('\n   ✅ Aucun problème majeur détecté');
  }

  // Recommandations
  console.log('\n   💡 Recommandations:');
  if (overallScore >= 80) {
    console.log('      ✅ Filtre de bonne qualité, devrait sonner naturel');
  } else if (overallScore >= 60) {
    console.log('      ⚡ Filtre acceptable, quelques compromis perceptibles');
  } else {
    console.log('      ⚠️  Filtre agressif, envisager de réduire les corrections');
  }

  return { overallScore, bandStats };
}

function analyzePhase(filterResponse, warnings, scores) {
  // =========================================================================
  // 4. ANALYSE DE LA PHASE (si disponible)
  // =========================================================================
  if (!filterResponse.phase) return;

  console.log('\n   📊 Analyse de la phase:');
  const phaseArray = Array.from(filterResponse.phase);
  const phaseMax = Math.max(...phaseArray.map(Math.abs));
  const phaseRange = Math.max(...phaseArray) - Math.min(...phaseArray);

  console.log(`      Rotation de phase max: ${phaseMax.toFixed(1)}°`);
  console.log(`      Plage de phase: ${phaseRange.toFixed(1)}°`);

  if (phaseMax > 180) {
    warnings.push(
      `⚡ Rotation de phase importante (${phaseMax.toFixed(
        0,
      )}°) - Normal pour EQ paramétrique`,
    );
  }
  scores.phase = phaseMax > 360 ? 70 : 100;
}

function filterQuality(filterResponse, groupDelay, matchRangeStart, matchRangeEnd) {
  const warnings = [];
  const scores = {};

  // Convertir en tableaux si nécessaire
  const frFreqs = filterResponse.freqs || generateFreqArray(filterResponse);
  const gdFreqs = groupDelay.freqs || generateFreqArray(groupDelay);
  const gdMag = groupDelay.magnitude; // en secondes

  // =========================================================================
  // 1. ANALYSE DU GROUP DELAY
  // =========================================================================
  console.log('\n   📊 Analyse du Group Delay:');
  analyzeGroupDelay(gdMag, gdFreqs, matchRangeStart, matchRangeEnd, warnings, scores);

  // =========================================================================
  // 2. ANALYSE DE LA RÉPONSE EN FRÉQUENCE
  // =========================================================================
  console.log('\n   📊 Analyse de la réponse en fréquence:');
  const magArray = analyzeMagnitude(filterResponse.magnitude, warnings, scores);

  // =========================================================================
  // 3. ANALYSE DES PENTES (SLEW RATE)
  // =========================================================================
  console.log('\n   📊 Analyse des pentes:');
  analyzeSlewRate(frFreqs, magArray, warnings, scores);

  analyzePhase(filterResponse, warnings, scores);

  const { overallScore, bandStats } = analyzeBandsAndSummary(
    frFreqs,
    magArray,
    scores,
    warnings,
  );

  return { scores, overallScore, warnings, bandStats };
}

/**
 * Génère un tableau de fréquences à partir des métadonnées REW
 */
function generateFreqArray(data) {
  const length = data.magnitude.length;
  const freqs = new Float32Array(length);

  if (data.ppo) {
    // Espacement logarithmique (points par octave)
    for (let i = 0; i < length; i++) {
      freqs[i] = data.startFreq * Math.pow(2, i / data.ppo);
    }
  } else if (data.freqStep) {
    // Espacement linéaire
    for (let i = 0; i < length; i++) {
      freqs[i] = data.startFreq + i * data.freqStep;
    }
  }

  return freqs;
}

/**
 * Parse une ligne de données REW et retourne un objet ou null si invalide
 */
/**
 * Affiche les statistiques des données chargées
 */
function logDataStats(filePath, data) {
  console.log(`\n📂 Lecture de ${filePath}...`);
  console.log(`   ✓ ${data.length} points de données chargés`);
  console.log(
    `   ✓ Plage: ${data[0].freq.toFixed(2)} Hz - ${data.at(-1).freq.toFixed(2)} Hz`,
  );
  console.log(
    `   ✓ SPL: ${Math.min(...data.map(d => d.spl)).toFixed(2)} dB - ${Math.max(
      ...data.map(d => d.spl),
    ).toFixed(2)} dB`,
  );
}

function loadMeasuredData(filePath) {
  const data = parseREWFileAsAPI(filePath);
  const dataForStats = toDataArray(data);

  if (dataForStats.length > 0) {
    logDataStats(filePath, dataForStats);
  }

  return data;
}

function getScoreRowOutcome(rewScore, autoScore, threshold = 5) {
  if (typeof rewScore !== 'number' || typeof autoScore !== 'number') {
    return { diff: null, winner: '' };
  }

  const diff = autoScore - rewScore;
  if (diff > threshold) {
    return { diff, winner: '✅ Auto-EQ' };
  }
  if (diff < -threshold) {
    return { diff, winner: '✅ REW' };
  }

  return { diff, winner: '≈' };
}

function formatDisplayedScore(score) {
  return typeof score === 'number' ? score.toFixed(0) : 'N/A';
}

function formatDisplayedDiff(diff) {
  if (typeof diff !== 'number') {
    return 'N/A';
  }

  return `${diff >= 0 ? '+' : ''}${diff.toFixed(0)}`;
}

function printCriterionScores(rewQuality, autoEQQuality) {
  const criteria = [
    ['groupDelay', 'Group Delay'],
    ['magnitude', 'Magnitude'],
    ['slewRate', 'Pentes'],
  ];

  for (const [criterion, label] of criteria) {
    const rewScore = rewQuality.scores[criterion];
    const autoScore = autoEQQuality.scores[criterion];
    const { diff, winner } = getScoreRowOutcome(rewScore, autoScore);

    console.log(
      `   ${label.padEnd(18)} ${formatDisplayedScore(rewScore).padStart(5)}    ${formatDisplayedScore(
        autoScore,
      ).padStart(5)}     ${formatDisplayedDiff(diff).padStart(6)}  ${winner}`,
    );
  }
}

function printOverallScoreRow(rewQuality, autoEQQuality) {
  const { diff, winner } = getScoreRowOutcome(
    rewQuality.overallScore,
    autoEQQuality.overallScore,
  );

  console.log(
    `   ${'Score Global'.padEnd(18)} ${rewQuality.overallScore
      .toFixed(0)
      .padStart(
        5,
      )}    ${autoEQQuality.overallScore.toFixed(0).padStart(5)}     ${formatDisplayedDiff(
      diff,
    ).padStart(6)}  ${winner}`,
  );
}

function getRmsWinner(rewRMS, autoRMS) {
  if (autoRMS < rewRMS - 0.1) {
    return '✅ Auto-EQ';
  }
  if (rewRMS < autoRMS - 0.1) {
    return '✅ REW';
  }
  return '≈';
}

function printFinalVerdict(rewQuality, autoEQQuality, rewRMS, autoRMS) {
  let rewWins = 0;
  let autoWins = 0;

  if (rewQuality.overallScore > autoEQQuality.overallScore + 5) {
    rewWins++;
  } else if (autoEQQuality.overallScore > rewQuality.overallScore + 5) {
    autoWins++;
  }

  if (rewRMS < autoRMS - 0.1) {
    rewWins++;
  } else if (autoRMS < rewRMS - 0.1) {
    autoWins++;
  }

  console.log('\n' + '─'.repeat(70));
  console.log('🏆 VERDICT:');

  if (autoWins > rewWins) {
    console.log('   ✅ Auto-EQ offre de meilleurs résultats globaux');
  } else if (rewWins > autoWins) {
    console.log('   ✅ REW offre de meilleurs résultats globaux');
  } else {
    console.log('   ≈ Les deux solutions offrent des résultats comparables');
  }
  console.log('─'.repeat(70));
}

function printScoresAndVerdict(
  rewQuality,
  autoEQQuality,
  rewEqualizedDataArray,
  equalizedDataArray,
  targetCurve,
  matchRangeStart,
  matchRangeEnd,
) {
  console.log('\n📊 Scores de qualité:');
  console.log('   Critère              REW      Auto-EQ   Différence');
  console.log('   ─────────────────────────────────────────────────');
  printCriterionScores(rewQuality, autoEQQuality);
  console.log('   ─────────────────────────────────────────────────');
  printOverallScoreRow(rewQuality, autoEQQuality);

  console.log("\n📈 Précision de l'égalisation:");
  const rewRMS = calculateRMSError(
    rewEqualizedDataArray,
    targetCurve,
    matchRangeStart,
    matchRangeEnd,
  );
  const autoRMS = calculateRMSError(
    equalizedDataArray,
    targetCurve,
    matchRangeStart,
    matchRangeEnd,
  );
  const rmsWinner = getRmsWinner(rewRMS, autoRMS);
  console.log(`   REW RMS Error:     ${rewRMS.toFixed(3)} dB`);
  console.log(`   Auto-EQ RMS Error: ${autoRMS.toFixed(3)} dB  ${rmsWinner}`);

  printFinalVerdict(rewQuality, autoEQQuality, rewRMS, autoRMS);
}

function printComparison(
  rewActiveFilters,
  activeFilters,
  rewQuality,
  autoEQQuality,
  rmsData,
  matchRangeStart,
  matchRangeEnd,
) {
  const { rewEqualizedDataArray, equalizedDataArray, targetCurve } = rmsData;
  console.log('\n' + '='.repeat(70));
  console.log('📊 COMPARAISON DIRECTE REW vs AUTO-EQ');
  console.log('='.repeat(70));

  // Comparaison des filtres générés
  console.log('\n📋 Comparaison des filtres:');
  console.log(`   REW:     ${rewActiveFilters.length} filtres actifs`);
  console.log(`   Auto-EQ: ${activeFilters.length} filtres actifs`);

  // Tableau comparatif des filtres
  console.log('\n   Filtres REW:');
  rewActiveFilters
    .slice()
    .sort((a, b) => a.frequency - b.frequency)
    .forEach((f, i) => {
      const sign = f.gaindB >= 0 ? '+' : '';
      console.log(
        `      ${(i + 1).toString().padStart(2)}. ${f.frequency
          .toFixed(1)
          .padStart(
            8,
          )} Hz, Q=${f.q.toFixed(3).padStart(6)}, ${sign}${f.gaindB.toFixed(2)} dB`,
      );
    });

  console.log('\n   Filtres Auto-EQ:');
  activeFilters.forEach((f, i) => {
    const sign = f.gain >= 0 ? '+' : '';
    console.log(
      `      ${(i + 1).toString().padStart(2)}. ${f.fc
        .toFixed(1)
        .padStart(
          8,
        )} Hz, Q=${f.Q.toFixed(3).padStart(6)}, ${sign}${f.gain.toFixed(2)} dB`,
    );
  });

  // Comparaison des scores de qualité et verdict
  printScoresAndVerdict(
    rewQuality,
    autoEQQuality,
    rewEqualizedDataArray,
    equalizedDataArray,
    targetCurve,
    matchRangeStart,
    matchRangeEnd,
  );
}

async function uploadResponseToRew(api, data) {
  const options = {
    identifier: data.identifier,
    isImpedance: false,
    startFreq: data.freqs[0],
    freqStep: data.freqStep,
    magnitude: data.magnitude,
    phase: data.phase,
    ppo: data.ppo,
  };
  return api.rewImport.importFrequencyResponseData(options);
}

console.log('🎵 Test Auto-EQ avec fichiers REW réels\n');
console.log('='.repeat(70));

const windowsHost = getWindowsHostIP();
const apiService = new RewApi(`http://${windowsHost}:4735`, false, true);

try {
  await apiService.initializeAPI();
} catch {
  console.log('⚠️  REW API non disponible — test ignoré');
  process.exit(0);
}

// clean all measurements from REW before uploading new ones
await apiService.rewMeasurements.deleteAll();
let measurementCount = 0;

// ============================================================================
// 2. CHARGEMENT DES DONNÉES
// ============================================================================

console.log('\n📊 Chargement des mesures...');

const basePath = './test/auto-eq/samples-96ppo-alt';

// boucler sur l'ensemble des fichiers de mesure dans le dossier samples-96ppo
const measurementFiles = [
  'Cavg.txt',
  'FLavg.txt',
  'FRavg.txt',
  'LFE.txt',
  'SBLavg.txt',
  'SBRavg.txt',
  'SLAavg.txt',
  'SRAavg.txt',
  'TFLavg.txt',
  'TFRavg.txt',
  'TRLavg.txt',
  'TRRavg.txt',
];

for (const file of measurementFiles) {
  const measuredData = loadMeasuredData(`${basePath}/${file}`);
  await uploadResponseToRew(apiService, measuredData);
  measurementCount++;
  const measuredDataIndex = measurementCount;

  const customStartFrequency = 20; // Hz
  const customEndFrequency = 20000;
  const individualMaxBoostdB = 6; // dB
  const overallMaxBoostdB = 6; // dB
  const flatnessTargetdB = 1; // dB

  // Créer une nouvelle mesure REW pour l'égalisation
  console.log('\n🎚️  Configuration de la mesure pour Auto-EQ...');
  await apiService.rewMeasurements.setEqualiser(
    measuredDataIndex,
    apiService.rewEq.defaulEqtSettings,
  );

  await apiService.rewMeasurements.resetTargetSettings(measuredDataIndex);
  await apiService.rewMeasurements.resetRoomCurveSettings(measuredDataIndex);
  const measurementSampleRate = await getRewMeasurementSampleRate(
    apiService,
    measuredDataIndex,
  );
  const targetData =
    await apiService.rewMeasurements.getTargetResponse(measuredDataIndex);

  // Vérification de sanité de la target
  const targetInterp = createNearestSampler(targetData);
  if (targetInterp(1000) < 50 || targetInterp(1000) > 100) {
    console.error(
      `⚠️ [${file}] Données de target invalides à 1 kHz (${targetInterp(1000).toFixed(1)} dB) — fichier ignoré`,
    );
    continue;
  }

  await apiService.rewEq.setMatchTargetSettings({
    startFrequency: customStartFrequency,
    endFrequency: customEndFrequency,
    individualMaxBoostdB: individualMaxBoostdB,
    overallMaxBoostdB: overallMaxBoostdB,
    flatnessTargetdB: flatnessTargetdB,
    allowNarrowFiltersBelow200Hz: false,
    varyQAbove200Hz: false,
    allowLowShelf: false,
    allowHighShelf: false,
  });

  // lancer l'auto-égalisation de REW pour la mesure 1
  console.log("\n🤖 Lancement de l'appairage de la cible dans REW...");
  await apiService.rewMeasurements.matchTarget(measuredDataIndex);

  // recuperer les filtres générés par REW
  const rewFiltersRaw = await apiService.rewMeasurements.getFilters(measuredDataIndex);
  // Convertir en tableau (l'API retourne un array-like object)
  const rewFilters = Array.isArray(rewFiltersRaw)
    ? rewFiltersRaw
    : Object.values(rewFiltersRaw);
  const rewActiveFilters = rewFilters.filter(f => f.type !== 'None' && f.enabled);
  console.log(`   ✓ ${rewActiveFilters.length} filtres actifs récupérés de REW`);

  // ============================================================================
  // GENERER LA REPONSE ÉGALISÉE DANS REW POUR VÉRIFICATION
  // ============================================================================

  console.log('\n🔧 Génération de la réponse équalisée dans REW pour vérification...');
  await apiService.rewMeasurements.generatePredictedMeasurement(measuredDataIndex);
  measurementCount++;
  const rewEqualizedData =
    await apiService.rewMeasurements.getPredictedFrequencyResponse(measuredDataIndex);
  console.log('   ✓ Réponse équalisée générée dans REW');

  // ============================================================================
  // GENERER LA REPONSE DU FILTRE SEUL DANS REW POUR VÉRIFICATION
  // ============================================================================

  console.log(
    '\n🔧 Génération de la réponse du filtre seul dans REW pour vérification...',
  );
  await apiService.rewMeasurements.generateFiltersMeasurement(measuredDataIndex);
  measurementCount++;
  const rewFilterResponseIndex = measurementCount;
  const options = {
    unit: 'SPL',
    ppo: 48,
  };
  const rewFilterResponse = await apiService.rewMeasurements.getFrequencyResponse(
    rewFilterResponseIndex,
    options,
  );
  console.log('   ✓ Réponse du filtre seul générée dans REW');

  // ============================================================================
  // DONNEES DU GROUP DELAY DU FILTRE
  // ============================================================================
  console.log('\n🔧 Génération du Group Delay dans REW pour vérification...');
  const gdOptions = {
    ppo: 48,
  };
  const rewGroupDelay = await apiService.rewMeasurements.getGroupDelay(
    rewFilterResponseIndex,
    gdOptions,
  );
  console.log('   ✓ Group Delay généré dans REW');

  // ============================================================================
  // 3. CALCUL AUTO-EQ
  // ============================================================================

  const measuredResponse = toFrequencyResponse(measuredData);
  const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
  const measuredSPL = createNearestSampler(measuredResponse);
  const targetCurve = createNearestSampler(targetResponse);

  // Verification
  console.log('\n🔍 Vérification des réponses projetées:');
  const testFreqs = [100, 1000, 10000];
  testFreqs.forEach(f => {
    console.log(
      `   ${f} Hz: Mesure=${measuredSPL(f).toFixed(2)} dB, Cible=${targetCurve(f).toFixed(
        2,
      )} dB, Erreur=${(measuredSPL(f) - targetCurve(f)).toFixed(2)} dB`,
    );
  });

  // ============================================================================
  // 3. CALCUL AUTO-EQ
  // ============================================================================

  console.log('\n⚙️  Configuration Auto-EQ...');
  console.log(`   ✓ Sample rate mesure REW: ${measurementSampleRate} Hz`);

  const calculator = new AutoEQCalculator(
    createConfig(
      {
        sampleRate: measurementSampleRate,
        equalizerManufacturer: 'Generic',
        equalizerModel: 'Generic',
        allowNarrowFiltersBelow200Hz: false,
        varyQAbove200Hz: false,
      },
      { silent: false, verbose: true },
    ),
  );

  console.log('\n🚀 Lancement du calcul Auto-EQ...\n');

  const startTime = Date.now();

  try {
    await calculator.calculate(measuredResponse, targetResponse);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n✅ Calcul terminé en ${elapsed} secondes`);

    // Afficher les filtres générés
    const activeFilters = calculator.filterSet.getActiveFilters();
    console.log(`\n📊 ${activeFilters.length} filtres actifs générés:\n`);

    // trier les activeFilters par fréquence croissante
    activeFilters.sort((a, b) => a.fc - b.fc);

    activeFilters.forEach((filter, i) => {
      console.log(
        `   Filtre ${(i + 1).toString().padStart(2)}: ` +
          `fc=${filter.fc.toFixed(1).padStart(8)} Hz, ` +
          `Q=${filter.Q.toFixed(3).padStart(6)}, ` +
          `gain=${(filter.gain >= 0 ? '+' : '') + filter.gain.toFixed(2).padStart(6)} dB`,
      );
    });

    // ============================================================================
    // 4. ARRONDIR LES FILTRES POUR CORRESPONDRE À L'EXPORT CAMILLADSP
    // ============================================================================

    console.log('\n🔧 Arrondissement des filtres pour export...');

    // Arrondir les valeurs des filtres pour correspondre à ce qui sera exporté
    // Cela garantit que la courbe calculée correspond exactement à CamillaDSP
    adjustFilterPrecision(activeFilters);

    // ============================================================================
    // 6. EXPORT FILTRE VIA API REW
    // ============================================================================

    const filters = Array.from({ length: 22 }, (_, i) => ({
      index: i + 1,
      type: 'None',
      enabled: true,
      isAuto: true,
    }));

    activeFilters.forEach((f, i) => {
      // convert filterType to REW format PEAKING -> PK, NONE -> None, etc.
      let filterType;
      if (f.filterType === 'PEAKING') filterType = 'PK';
      else if (f.filterType === 'NONE') filterType = 'None';
      else filterType = f.filterType;
      filters[i] = {
        ...filters[i],
        type: filterType,
        frequency: f.fc,
        q: f.Q,
        gaindB: f.gain,
      };
    });

    console.log('\n📤 Export des filtres vers REW via API...');
    await apiService.rewMeasurements.postFilters(measuredDataIndex, {
      filters: filters,
    });

    console.log(`   ✓ ${filters.length} filtres exportés vers REW`);

    // ============================================================================
    // GENERER LA REPONSE ÉGALISÉE DANS REW POUR VÉRIFICATION
    // ============================================================================

    console.log('\n🔧 Génération de la réponse équalisée dans REW pour vérification...');
    await apiService.rewMeasurements.generatePredictedMeasurement(measuredDataIndex);
    measurementCount++;
    const equalizedData =
      await apiService.rewMeasurements.getPredictedFrequencyResponse(measuredDataIndex);
    console.log('   ✓ Réponse équalisée générée dans REW');

    // ============================================================================
    // GENERER LA REPONSE DU FILTRE SEUL DANS REW POUR VÉRIFICATION
    // ============================================================================

    console.log(
      '\n🔧 Génération de la réponse du filtre seul dans REW pour vérification...',
    );
    await apiService.rewMeasurements.generateFiltersMeasurement(measuredDataIndex);
    measurementCount++;
    const autoEQFilterResponseIndex = measurementCount;
    const filterResponse = await apiService.rewMeasurements.getFrequencyResponse(
      autoEQFilterResponseIndex,
      options,
    );
    console.log('   ✓ Réponse du filtre seul générée dans REW');

    // ============================================================================
    // GENERER LE GROUP DELAY DANS REW POUR VÉRIFICATION
    // ============================================================================
    console.log('\n🔧 Génération du Group Delay dans REW pour vérification...');
    const groupDelay = await apiService.rewMeasurements.getGroupDelay(
      autoEQFilterResponseIndex,
      gdOptions,
    );
    console.log('   ✓ Group Delay généré dans REW');

    // ============================================================================
    // 5. CALCUL STATISTIQUES
    // ============================================================================

    // Calculer les statistiques (seulement dans la plage de match 20-20000 Hz)
    const matchRangeStart = customStartFrequency;
    const matchRangeEnd = customEndFrequency;

    const equalizedDataArray = toDataArray(equalizedData);
    const measuredDataArray = toDataArray(measuredData);
    const rewEqualizedDataArray = toDataArray(rewEqualizedData);

    console.log('\n📊 Statistiques pour la réponse équalisée REW:');
    calculateEqualizationStats(
      rewEqualizedDataArray,
      matchRangeStart,
      matchRangeEnd,
      measuredDataArray,
      targetCurve,
    );

    console.log('\n📊 Statistiques pour la réponse équalisée Auto-EQ:');
    calculateEqualizationStats(
      equalizedDataArray,
      matchRangeStart,
      matchRangeEnd,
      measuredDataArray,
      targetCurve,
    );

    // ============================================================================
    // EVALUATION DES FILTRES
    // ============================================================================

    console.log('\n🔍 Évaluation des filtres REW...');
    const rewQuality = filterQuality(
      rewFilterResponse,
      rewGroupDelay,
      matchRangeStart,
      matchRangeEnd,
    );

    console.log('\n🔍 Évaluation des filtres Auto-EQ...');
    const autoEQQuality = filterQuality(
      filterResponse,
      groupDelay,
      matchRangeStart,
      matchRangeEnd,
    );

    // ============================================================================
    // COMPARAISON DIRECTE REW vs AUTO-EQ
    // ============================================================================

    printComparison(
      rewActiveFilters,
      activeFilters,
      rewQuality,
      autoEQQuality,
      { rewEqualizedDataArray, equalizedDataArray, targetCurve },
      matchRangeStart,
      matchRangeEnd,
    );

    // ============================================================================
    // FIN DU TEST
    // ============================================================================

    console.log('\n🎉 Test Auto-EQ terminé avec succès!');
  } catch (error) {
    console.error(`\n❌ [${file}] Erreur lors du calcul: ${error.message}`);
    console.error(error.stack);
    continue;
  }
}
