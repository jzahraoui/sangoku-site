/**
 * test-rew-files.js
 * Test avec fichiers REW réels: FRavg.txt et Target Harmon 75.42dB.txt
 * Génère un fichier résultat importable dans REW
 */
import process from 'node:process';
import { writeFileSync } from 'node:fs';
import { AutoEQCalculator } from '../../src/index.js';
import {
  parseREWFile,
  createNearestSampler,
  createConfig,
  toFrequencyResponse,
  projectResponseToReferenceGrid,
} from '../test-config.js';

console.log('🎵 Test Auto-EQ avec fichiers REW réels\n');
console.log('='.repeat(70));

// ============================================================================
// 2. CHARGEMENT DES DONNÉES
// ============================================================================

console.log('\n📊 Chargement des mesures...');

const measuredData = parseREWFile('./tests-auto-eq/exemple1/FRavg.txt');
const targetData = parseREWFile('./tests-auto-eq/exemple1/Target FRavg.txt');

const measuredResponse = toFrequencyResponse(measuredData);
const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
const measuredSampler = createNearestSampler(measuredResponse);
const targetSampler = createNearestSampler(targetResponse);

// Vérification
console.log('\n🔍 Vérification des échantillonneurs bruts:');
const testFreqs = [100, 1000, 10000];
testFreqs.forEach(f => {
  console.log(
    `   ${f} Hz: Mesure=${measuredSampler(f).toFixed(2)} dB, Cible=${targetSampler(
      f,
    ).toFixed(2)} dB, Erreur=${(measuredSampler(f) - targetSampler(f)).toFixed(2)} dB`,
  );
});

// ============================================================================
// 3. CALCUL AUTO-EQ
// ============================================================================

console.log('\n⚙️  Configuration Auto-EQ...');

const calculator = new AutoEQCalculator(
  createConfig({}, { silent: false, verbose: true }),
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
  for (const filter of activeFilters) {
    if (filter.enabled && filter.filterType !== 'NONE') {
      // Arrondir avec la même précision que l'export CamillaDSP
      filter.fc = Math.round(filter.fc * 10) / 10; // 1 décimale
      filter.gain = Math.round(filter.gain * 10) / 10; // 1 décimale
      filter.Q = Math.round(filter.Q * 1000) / 1000; // 3 décimales
      filter.calcBiquad(); // Recalculer les coefficients avec les valeurs arrondies
    }
  }

  // ============================================================================
  // 5. CALCUL DE LA RÉPONSE ÉQUALISÉE
  // ============================================================================

  console.log('🔧 Calcul de la réponse équalisée...');

  const equalizedData = measuredData.map(point => {
    const freq = point.freq;
    const originalSPL = point.spl;
    const originalPhase = point.phase;

    // Obtenir la réponse complexe cumulative des filtres
    const filterResponse = calculator.filterSet.getCumulativeComplexResponse(freq);

    // Pour la magnitude: addition en dB (équivalent à multiplication des magnitudes linéaires)
    // SPL_out = SPL_in + filter_gain_dB
    const equalizedSPL = originalSPL + filterResponse.magnitudeDB;

    // Pour la phase: addition des phases
    const equalizedPhase = originalPhase + filterResponse.phase;

    return {
      freq: freq,
      spl: equalizedSPL,
      phase: equalizedPhase,
      correction: filterResponse.magnitudeDB,
    };
  });

  // Calculer les statistiques (seulement dans la plage de match 20-20000 Hz)
  const matchRangeStart = 20;
  const matchRangeEnd = 20000;

  const inRangeData = equalizedData.filter(
    d => d.freq >= matchRangeStart && d.freq <= matchRangeEnd,
  );
  const inRangeOriginal = measuredData.filter(
    d => d.freq >= matchRangeStart && d.freq <= matchRangeEnd,
  );

  const errors = inRangeData.map(d => d.spl - targetSampler(d.freq));
  const originalErrors = inRangeOriginal.map(d => d.spl - targetSampler(d.freq));

  const rmsError = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length);
  const originalRmsError = Math.sqrt(
    originalErrors.reduce((sum, e) => sum + e * e, 0) / originalErrors.length,
  );
  const maxError = Math.max(...errors.map(Math.abs));
  const maxCorrection = Math.max(...inRangeData.map(d => Math.abs(d.correction)));

  // Trouver la fréquence du max error
  const maxErrorIdx = errors.findIndex(e => Math.abs(e) === maxError);
  const maxErrorFreq = inRangeData[maxErrorIdx]?.freq || 0;

  console.log("\n📈 Statistiques de l'égalisation (20-20000 Hz):");
  console.log(`   RMS Error avant:  ${originalRmsError.toFixed(3)} dB`);
  console.log(`   RMS Error après:  ${rmsError.toFixed(3)} dB`);
  console.log(
    `   Amélioration:     ${((1 - rmsError / originalRmsError) * 100).toFixed(1)}%`,
  );
  console.log(
    `   Max erreur:       ${maxError.toFixed(2)} dB @ ${maxErrorFreq.toFixed(0)} Hz`,
  );
  console.log(`   Max correction:   ${maxCorrection.toFixed(2)} dB`);

  // Breakdown par bande de fréquence
  const bands = [
    { name: 'Sub-bass (20-60 Hz)', start: 20, end: 60 },
    { name: 'Bass (60-250 Hz)', start: 60, end: 250 },
    { name: 'Low-mid (250-500 Hz)', start: 250, end: 500 },
    { name: 'Mid (500-2000 Hz)', start: 500, end: 2000 },
    { name: 'High-mid (2-6 kHz)', start: 2000, end: 6000 },
    { name: 'High (6-20 kHz)', start: 6000, end: 20000 },
  ];

  console.log('\n📊 Erreur RMS par bande de fréquence:');
  for (const band of bands) {
    const bandDataBefore = inRangeOriginal.filter(
      d => d.freq >= band.start && d.freq < band.end,
    );
    const bandDataAfter = inRangeData.filter(
      d => d.freq >= band.start && d.freq < band.end,
    );

    if (bandDataBefore.length === 0) continue;

    const errBefore = bandDataBefore.map(d => d.spl - targetSampler(d.freq));
    const errAfter = bandDataAfter.map(d => d.spl - targetSampler(d.freq));

    const rmsBefore = Math.sqrt(
      errBefore.reduce((s, e) => s + e * e, 0) / errBefore.length,
    );
    const rmsAfter = Math.sqrt(errAfter.reduce((s, e) => s + e * e, 0) / errAfter.length);
    const improvement = (1 - rmsAfter / rmsBefore) * 100;

    console.log(
      `   ${band.name.padEnd(20)}: ${rmsBefore.toFixed(2)} dB → ${rmsAfter.toFixed(
        2,
      )} dB (${improvement >= 0 ? '+' : ''}${improvement.toFixed(0)}%)`,
    );
  }

  // Afficher les statistiques de group delay
  console.log('\n⏱️  Statistiques du Group Delay:');
  const gdStats = calculator.filterSet.getGroupDelayStats(20, 20000, 200);
  console.log(`   Min: ${gdStats.min.toFixed(2)} ms`);
  console.log(`   Max: ${gdStats.max.toFixed(2)} ms @ ${gdStats.maxFreq.toFixed(0)} Hz`);
  console.log(`   Variation (max-min): ${gdStats.range.toFixed(2)} ms`);
  console.log(`   Variation moyenne: ${gdStats.avgAbsVariation.toFixed(3)} ms/point`);

  // ============================================================================
  // 6. EXPORT AU FORMAT REW
  // ============================================================================

  console.log('\n💾 Génération du fichier résultat...');

  const outputPath = './test-results/FRavg_Equalized.txt';

  // Générer l'en-tête REW
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 19).replace('T', ' ');

  let output = '';
  output += '* Measurement data generated by AutoEQCalculator\n';
  output += '* Source: FRavg.txt with Auto-EQ applied\n';
  output += '* Format: Equalized frequency response\n';
  output += `* Dated: ${dateStr}\n`;
  output += '* Auto-EQ Settings:\n';
  output += `*  Number of filters: ${activeFilters.length}\n`;
  output += `*  Frequency range: 20-20000 Hz\n`;
  output += `*  Max boost per filter: 6 dB\n`;
  output += `*  Max overall boost: 12 dB\n`;
  output += `*  RMS error before: ${originalRmsError.toFixed(3)} dB\n`;
  output += `*  RMS error after: ${rmsError.toFixed(3)} dB\n`;
  output += `*  Improvement: ${((1 - rmsError / originalRmsError) * 100).toFixed(1)}%\n`;
  output += '* Filters applied:\n';

  activeFilters.forEach((filter, i) => {
    output += `*  Filter ${i + 1}: fc=${filter.fc.toFixed(1)} Hz, Q=${filter.Q.toFixed(
      3,
    )}, gain=${filter.gain.toFixed(2)} dB\n`;
  });

  output += '*\n';
  output += '* Freq(Hz)\tSPL(dB)\tPhase(degrees)\n';

  // Ajouter les données
  equalizedData.forEach(d => {
    output += `${d.freq.toFixed(6)}\t${d.spl.toFixed(3)}\t${d.phase.toFixed(4)}\n`;
  });

  writeFileSync(outputPath, output, 'utf-8');

  console.log(`   ✓ Fichier généré: ${outputPath}`);
  console.log(`   ✓ ${equalizedData.length} points de données exportés`);

  // Générer aussi un fichier avec juste la correction (pour vérifier dans REW)
  const correctionPath = './test-results/EQ_Correction.txt';
  let correctionOutput = '';
  correctionOutput += '* EQ Correction curve (magnitude response of filters)\n';
  correctionOutput += '* Generated by AutoEQCalculator\n';
  correctionOutput += `* Dated: ${dateStr}\n`;
  correctionOutput += '*\n';
  correctionOutput += '* Freq(Hz)\tCorrection(dB)\n';

  // Générer la courbe de correction sur une grille régulière
  const correctionPoints = [];
  for (let freq = 10; freq <= 24000; freq *= Math.pow(10, 1 / 96)) {
    const correction = calculator.filterSet.getCumulativeResponse(freq);
    correctionPoints.push({ freq, correction });
  }

  correctionPoints.forEach(p => {
    correctionOutput += `${p.freq.toFixed(6)}\t${p.correction.toFixed(3)}\n`;
  });

  writeFileSync(correctionPath, correctionOutput, 'utf-8');
  console.log(`   ✓ Courbe de correction: ${correctionPath}`);

  // Exporter les filtres en JSON pour référence
  const filtersJSON = calculator.exportFilters();
  const jsonPath = './test-results/EQ_Filters.json';
  writeFileSync(jsonPath, JSON.stringify(filtersJSON, null, 2), 'utf-8');
  console.log(`   ✓ Filtres (JSON): ${jsonPath}`);

  // Exporter au format CamillaDSP YAML
  const camillaDSPPath = './test-results/EQ_CamillaDSP.yml';
  let camillaYAML = 'filters:\n';

  // Exporter TOUS les filtres (pas seulement les actifs)
  const allFilters = calculator.filterSet.filters;
  allFilters.forEach((filter, i) => {
    const filterNum = i + 1;
    camillaYAML += `  filter_${filterNum}:\n`;
    camillaYAML += `    type: Biquad\n`;
    camillaYAML += `    parameters:\n`;
    camillaYAML += `      type: Peaking\n`;
    camillaYAML += `      freq: ${filter.fc.toFixed(1)}\n`;
    camillaYAML += `      gain: ${filter.gain.toFixed(1)}\n`;
    camillaYAML += `      q: ${filter.Q.toFixed(3)}\n`;
  });

  // Ajouter le pipeline pour un seul canal (mono/channel 0)
  camillaYAML += 'pipeline:\n';
  camillaYAML += '  - type: Filter\n';
  camillaYAML += '    channel: 0\n';
  camillaYAML += '    names:\n';
  allFilters.forEach((_, i) => {
    camillaYAML += `      - filter_${i + 1}\n`;
  });

  writeFileSync(camillaDSPPath, camillaYAML, 'utf-8');
  console.log(`   ✓ CamillaDSP (YAML): ${camillaDSPPath} (${allFilters.length} filtres)`);

  console.log('\n' + '='.repeat(70));
  console.log('✅ SUCCÈS - Fichiers générés prêts pour import dans REW!');
  console.log('='.repeat(70));
  console.log('\n📋 Fichiers générés:');
  console.log(`   1. ${outputPath}`);
  console.log(`      → Réponse équalisée (à comparer avec la cible)`);
  console.log(`   2. ${correctionPath}`);
  console.log(`      → Courbe de correction EQ appliquée`);
  console.log(`   3. ${jsonPath}`);
  console.log(`      → Paramètres des filtres (JSON)`);
  console.log(`   4. ${camillaDSPPath}`);
  console.log(`      → Configuration CamillaDSP (à utiliser avec camilladsp)`);
  console.log('\n💡 Utilisation:');
  console.log('   REW: Importer FRavg_Equalized.txt et comparer avec la cible');
  console.log('   CamillaDSP: Utiliser EQ_CamillaDSP.yml dans votre config');
  console.log('   Hardware: Utiliser EQ_Filters.json pour export vers DSP');
} catch (error) {
  console.error('\n❌ Erreur lors du calcul:', error.message);
  console.error(error.stack);
  process.exit(1);
}
