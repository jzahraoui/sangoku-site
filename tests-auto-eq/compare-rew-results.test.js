/**
 * compare-rew-results.js
 *
 * Compare les résultats de notre AutoEQ avec ceux de REW
 * Parse le fichier d'export REW et compare filtre par filtre
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { AutoEQCalculator } from '../src/index.js';
import {
  createNearestSampler,
  createConfig,
  parseREWFilters,
  toFrequencyResponse,
  projectResponseToReferenceGrid,
} from './test-config.js';

console.log('🔬 Comparaison Auto-EQ: Notre implémentation vs REW\n');
console.log('='.repeat(70));

// ============================================================================
// 1. PARSING DU FICHIER RÉSULTATS REW
// ============================================================================

/**
 * Parse un fichier REW de mesure (Freq/SPL/Phase)
 */
function parseREWMeasurement(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const data = [];
  let inData = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (line.startsWith('*')) {
      inData = inData || line.includes('Freq(Hz)');
      continue;
    }

    if (!inData) continue;

    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const freq = Number.parseFloat(parts[0]);
    const spl = Number.parseFloat(parts[1]);
    const phase = parts.length >= 3 ? Number.parseFloat(parts[2]) : 0;

    if (!Number.isNaN(freq) && !Number.isNaN(spl)) {
      data.push({ freq, spl, phase });
    }
  }

  return data;
}

// ============================================================================
// 2. CHARGEMENT DES DONNÉES
// ============================================================================

console.log('\n📂 Chargement des fichiers...');

// Charger les filtres REW
const rewFilters = parseREWFilters('./tests-auto-eq/exemple1/rew-auto-eq.txt');
console.log(`   ✓ ${rewFilters.length} filtres REW chargés`);

// Afficher les filtres REW
console.log('\n📊 Filtres REW:');
console.log('   ' + '-'.repeat(60));
console.log('    #   Freq (Hz)    Gain (dB)     Q       BW (Hz)');
console.log('   ' + '-'.repeat(60));
for (const [index, f] of rewFilters.entries()) {
  const displayedBandwidth = '-';
  console.log(
    `   ${(index + 1).toString().padStart(2)}   ${f.fc.toFixed(1).padStart(8)}    ${
      (f.gain >= 0 ? '+' : '') + f.gain.toFixed(1).padStart(6)
    }   ${f.Q.toFixed(3).padStart(6)}   ${displayedBandwidth}`,
  );
}
console.log('   ' + '-'.repeat(60));

// Statistiques REW
const rewBoosts = rewFilters.filter(f => f.gain > 0);
const rewCuts = rewFilters.filter(f => f.gain < 0);
const rewMaxBoost = rewBoosts.length > 0 ? Math.max(...rewBoosts.map(f => f.gain)) : 0;
const rewMaxCut = rewCuts.length > 0 ? Math.min(...rewCuts.map(f => f.gain)) : 0;
const rewQMin = Math.min(...rewFilters.map(f => f.Q));
const rewQMax = Math.max(...rewFilters.map(f => f.Q));

console.log(`\n📈 Statistiques REW:`);
console.log(
  `   Filtres: ${rewFilters.length} (${rewBoosts.length} boosts, ${rewCuts.length} cuts)`,
);
console.log(`   Boost max: +${rewMaxBoost.toFixed(1)} dB`);
console.log(`   Cut max: ${rewMaxCut.toFixed(1)} dB`);
console.log(`   Q range: ${rewQMin.toFixed(3)} - ${rewQMax.toFixed(3)}`);

// Charger les données de mesure
const measuredData = parseREWMeasurement('./tests-auto-eq/exemple1/FRavg.txt');
const targetData = parseREWMeasurement('./tests-auto-eq/exemple1/Target FRavg.txt');

console.log(`\n📊 Données de mesure:`);
console.log(
  `   Mesure: ${measuredData.length} points (${measuredData[0].freq.toFixed(
    1,
  )} - ${measuredData.at(-1).freq.toFixed(1)} Hz)`,
);
console.log(`   Target: ${targetData.length} points`);

const measuredResponse = toFrequencyResponse(measuredData);
const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
const measuredSampler = createNearestSampler(measuredResponse);
const targetSampler = createNearestSampler(targetResponse);

// ============================================================================
// 3. CALCUL AVEC NOTRE ALGORITHME
// ============================================================================

console.log('\n⚙️  Configuration Auto-EQ (paramètres REW-like)...');

// Déterminer la fréquence max d'égalisation depuis les filtres REW
const rewMaxFreq = Math.max(...rewFilters.map(f => f.fc));
const eqRangeEnd = Math.ceil(rewMaxFreq / 100) * 100 + 500; // Arrondir + marge
console.log(
  `   Fréquence max REW: ${rewMaxFreq.toFixed(0)} Hz → limite à ${eqRangeEnd} Hz`,
);

// Utiliser exactement le même nombre de filtres que REW
const calculator = new AutoEQCalculator(
  createConfig({}, { silent: false, verbose: true }),
);

console.log('\n🚀 Calcul Auto-EQ...\n');

const startTime = Date.now();
await calculator.calculate(measuredResponse, targetResponse);
const elapsed = (Date.now() - startTime) / 1000;

console.log(`✅ Calcul terminé en ${elapsed.toFixed(2)}s`);

// ============================================================================
// 4. COMPARAISON DES RÉSULTATS
// ============================================================================

const ourFilters = calculator.filterSet.getActiveFilters();

console.log('\n📊 Nos filtres:');
console.log('   ' + '-'.repeat(60));
console.log('    #   Freq (Hz)    Gain (dB)     Q');
console.log('   ' + '-'.repeat(60));
for (let i = 0; i < ourFilters.length; i++) {
  const f = ourFilters[i];
  console.log(
    `   ${(i + 1).toString().padStart(2)}   ${f.fc.toFixed(1).padStart(8)}    ${
      (f.gain >= 0 ? '+' : '') + f.gain.toFixed(1).padStart(6)
    }   ${f.Q.toFixed(3).padStart(6)}`,
  );
}
console.log('   ' + '-'.repeat(60));

// Statistiques nos filtres
const ourBoosts = ourFilters.filter(f => f.gain > 0);
const ourCuts = ourFilters.filter(f => f.gain < 0);
const ourMaxBoost = ourBoosts.length > 0 ? Math.max(...ourBoosts.map(f => f.gain)) : 0;
const ourMaxCut = ourCuts.length > 0 ? Math.min(...ourCuts.map(f => f.gain)) : 0;
const ourQMin = ourFilters.length > 0 ? Math.min(...ourFilters.map(f => f.Q)) : 0;
const ourQMax = ourFilters.length > 0 ? Math.max(...ourFilters.map(f => f.Q)) : 0;

console.log(`\n📈 Statistiques notre implémentation:`);
console.log(
  `   Filtres: ${ourFilters.length} (${ourBoosts.length} boosts, ${ourCuts.length} cuts)`,
);
console.log(`   Boost max: +${ourMaxBoost.toFixed(1)} dB`);
console.log(`   Cut max: ${ourMaxCut.toFixed(1)} dB`);
console.log(`   Q range: ${ourQMin.toFixed(3)} - ${ourQMax.toFixed(3)}`);

// ============================================================================
// 5. COMPARAISON FILTRE PAR FILTRE
// ============================================================================

console.log('\n🔍 Comparaison des filtres correspondants:');
console.log('   ' + '-'.repeat(75));
console.log('   Freq REW   Freq Notre   ΔFreq     Gain REW  Gain Notre  ΔGain   Q match');
console.log('   ' + '-'.repeat(75));

/**
 * Trouve le filtre le plus proche en fréquence
 */
function findClosestFilter(filters, targetFc, tolerance = 0.3) {
  let closest = null;
  let minDiff = Infinity;

  for (const f of filters) {
    const ratio = f.fc / targetFc;
    if (ratio > 1 - tolerance && ratio < 1 + tolerance) {
      const diff = Math.abs(f.fc - targetFc);
      if (diff < minDiff) {
        minDiff = diff;
        closest = f;
      }
    }
  }
  return closest;
}

let matchCount = 0;
const matches = [];

for (const rewF of rewFilters) {
  const ourF = findClosestFilter(ourFilters, rewF.fc, 0.25);

  if (ourF) {
    const freqDiff = ((ourF.fc - rewF.fc) / rewF.fc) * 100;
    const gainDiff = ourF.gain - rewF.gain;
    const qRatio = ourF.Q / rewF.Q;

    const freqMatch = Math.abs(freqDiff) < 15;
    const gainMatch = Math.abs(gainDiff) < 2;
    const qMatch = qRatio > 0.5 && qRatio < 2;

    let status = '✗';
    if (freqMatch && gainMatch) {
      status = '✓';
    } else if (freqMatch) {
      status = '~';
    }

    console.log(
      `   ${rewF.fc.toFixed(0).padStart(7)}   ${ourF.fc
        .toFixed(0)
        .padStart(8)}   ${freqDiff.toFixed(0).padStart(5)}%   ` +
        `${rewF.gain.toFixed(1).padStart(7)}   ${ourF.gain
          .toFixed(1)
          .padStart(8)}   ${gainDiff.toFixed(1).padStart(5)}   ` +
        `${qMatch ? '✓' : 'x'} (${qRatio.toFixed(2)})  ${status}`,
    );

    if (freqMatch && gainMatch) matchCount++;
    matches.push({ rew: rewF, ours: ourF, freqDiff, gainDiff, qRatio });
  } else {
    console.log(
      `   ${rewF.fc.toFixed(0).padStart(7)}   ${'---'.padStart(8)}   ${'---'.padStart(
        5,
      )}   ` +
        `${rewF.gain.toFixed(1).padStart(7)}   ${'---'.padStart(8)}   ${'---'.padStart(
          5,
        )}   ` +
        `--- ✗ MANQUANT`,
    );
  }
}

console.log('   ' + '-'.repeat(75));
console.log(
  `   Correspondances: ${matchCount}/${rewFilters.length} (${(
    (matchCount / rewFilters.length) *
    100
  ).toFixed(0)}%)`,
);

// ============================================================================
// 6. CALCUL MSE POUR LES DEUX SETS DE FILTRES
// ============================================================================

console.log('\n📉 Comparaison des performances (MSE):');

/**
 * Calcule le MSE d'un set de filtres
 */
function calculateMSE(filters, measuredSamplerFn, startFreq, endFreq) {
  const step = Math.pow(2, 1 / 96);
  let mse = 0;
  let count = 0;

  let freq = startFreq;
  while (freq <= endFreq) {
    const measured = measuredSamplerFn(freq);
    const target = targetSampler(freq);

    // Calculer la correction totale des filtres
    let correction = 0;
    for (const f of filters) {
      const ratio = freq / f.fc;
      const diff = ratio - 1 / ratio;
      correction += f.gain / (1 + f.Q * f.Q * diff * diff);
    }

    const error = measured + correction - target;
    mse += error * error;
    count++;
    freq *= step;
  }

  return Math.sqrt(mse / count);
}

const rewMSE = calculateMSE(rewFilters, measuredSampler, 20, 20000);
const ourMSE = calculateMSE(ourFilters, measuredSampler, 20, 20000);
const noFilterMSE = calculateMSE([], measuredSampler, 20, 20000);

console.log(`   Sans filtre:       ${noFilterMSE.toFixed(3)} dB RMS`);
console.log(
  `   Filtres REW:       ${rewMSE.toFixed(3)} dB RMS (amélioration: ${(
    (1 - rewMSE / noFilterMSE) *
    100
  ).toFixed(1)}%)`,
);
console.log(
  `   Nos filtres:       ${ourMSE.toFixed(3)} dB RMS (amélioration: ${(
    (1 - ourMSE / noFilterMSE) *
    100
  ).toFixed(1)}%)`,
);

const diff = ourMSE - rewMSE;
if (Math.abs(diff) < 0.1) {
  console.log(`\n   ✅ Performance équivalente (Δ = ${diff.toFixed(3)} dB)`);
} else if (diff < 0) {
  console.log(`\n   🏆 Notre implémentation est meilleure de ${(-diff).toFixed(3)} dB!`);
} else {
  console.log(`\n   ⚠️ REW est meilleur de ${diff.toFixed(3)} dB`);
}

// ============================================================================
// 7. EXPORT DU RAPPORT
// ============================================================================

const report = {
  timestamp: new Date().toISOString(),
  rewFilters,
  ourFilters: ourFilters.map(f => ({ fc: f.fc, Q: f.Q, gain: f.gain })),
  metrics: {
    noFilterMSE,
    rewMSE,
    ourMSE,
    rewImprovement: (1 - rewMSE / noFilterMSE) * 100,
    ourImprovement: (1 - ourMSE / noFilterMSE) * 100,
    matchCount,
    matchPercentage: (matchCount / rewFilters.length) * 100,
  },
  matches,
};

writeFileSync(
  './test-results/rew-comparison-report.json',
  JSON.stringify(report, null, 2),
);
console.log('\n📄 Rapport sauvegardé: ./test-results/rew-comparison-report.json');

console.log('\n' + '='.repeat(70));
console.log('🏁 Comparaison terminée');
