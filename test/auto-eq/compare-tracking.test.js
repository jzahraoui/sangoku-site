/**
 * compare-tracking.js
 *
 * Compare le tracking de la target entre:
 * - REW Auto-EQ (FRavg-rew-corrected.txt)
 * - Notre implémentation (FRavg_Equalized.txt)
 */

import { parseREWFile } from './test-config.js';

console.log('📊 Comparaison du Tracking de Target\n');
console.log('='.repeat(80));

// ============================================================================
// 1. PARSING DES FICHIERS
// ============================================================================

// Charger les fichiers
console.log('\n📂 Chargement des fichiers...');

const rewCorrected = parseREWFile('./test/auto-eq/exemple1/EQ FRavg.txt');
const ourCorrected = parseREWFile('./test-results/FRavg_Equalized.txt');
const target = parseREWFile('./test/auto-eq/exemple1/Target FRavg.txt');
const original = parseREWFile('./test/auto-eq/exemple1/FRavg.txt');

console.log(`   REW corrigé:    ${rewCorrected.length} points`);
console.log(`   Notre corrigé:  ${ourCorrected.length} points`);
console.log(`   Target:         ${target.length} points`);
console.log(`   Original:       ${original.length} points`);

// ============================================================================
// 2. ÉCHANTILLONNAGE DIRECT SUR LES DONNÉES BRUTES
// ============================================================================

function createNearestPointSampler(data) {
  return freq => {
    if (freq <= data[0].freq) return data[0];
    if (freq >= data[data.length - 1].freq) return data[data.length - 1];

    let left = 0,
      right = data.length - 1;
    while (right - left > 1) {
      const mid = Math.floor((left + right) / 2);
      if (data[mid].freq < freq) left = mid;
      else right = mid;
    }

    if (Math.abs(data[right].freq - freq) < Math.abs(freq - data[left].freq)) {
      return data[right];
    }

    return data[left];
  };
}

const getTarget = createNearestPointSampler(target);
const getOriginal = createNearestPointSampler(original);
const getRewCorrected = createNearestPointSampler(rewCorrected);
const getOurCorrected = createNearestPointSampler(ourCorrected);

function pickCloserToZeroWinner(
  leftValue,
  rightValue,
  leftLabel = 'REW',
  rightLabel = 'Nous',
) {
  if (Math.abs(leftValue) < Math.abs(rightValue)) {
    return leftLabel;
  }
  if (Math.abs(rightValue) < Math.abs(leftValue)) {
    return rightLabel;
  }
  return '=';
}

function pickLowerWinner(leftValue, rightValue, leftLabel = 'REW', rightLabel = 'Nous') {
  if (leftValue < rightValue) {
    return leftLabel;
  }
  if (rightValue < leftValue) {
    return rightLabel;
  }
  return '=';
}

function formatSigned(value, width) {
  const prefix = value >= 0 ? '+' : '';
  return prefix + value.toFixed(2).padStart(width);
}

function getBandWinnerMark(primary, secondary) {
  if (primary < secondary) {
    return '✓';
  }
  return '';
}

// ============================================================================
// 3. ANALYSE PAR BANDES DE FRÉQUENCES
// ============================================================================

console.log('\n📈 Analyse par bandes de fréquences:');
console.log('   ' + '-'.repeat(75));
console.log(
  '   Bande          | Original | REW EQ   | Notre EQ | Target   | Δ REW | Δ Nous',
);
console.log('   ' + '-'.repeat(75));

const bands = [
  { name: 'Sub-bass', start: 20, end: 60 },
  { name: 'Bass', start: 60, end: 200 },
  { name: 'Low-mid', start: 200, end: 500 },
  { name: 'Mid', start: 500, end: 1000 },
  { name: 'High-mid', start: 1000, end: 2000 },
  { name: 'High', start: 2000, end: 4000 },
  { name: 'Brilliance', start: 4000, end: 10000 },
  { name: 'Air', start: 10000, end: 20000 },
];

const step = Math.pow(2, 1 / 48);
let totalRewError = 0;
let totalOurError = 0;
let totalOrigError = 0;
let totalCount = 0;

for (const band of bands) {
  let rewSum = 0,
    ourSum = 0,
    origSum = 0;
  let targetSum = 0,
    rewCorrSum = 0,
    ourCorrSum = 0,
    origMeasSum = 0;
  let count = 0;

  let freq = band.start;
  while (freq <= band.end) {
    const tgt = getTarget(freq).spl;
    const orig = getOriginal(freq).spl;
    const rewCorr = getRewCorrected(freq).spl;
    const ourCorr = getOurCorrected(freq).spl;

    const origError = orig - tgt;
    const rewError = rewCorr - tgt;
    const ourError = ourCorr - tgt;

    origSum += origError * origError;
    rewSum += rewError * rewError;
    ourSum += ourError * ourError;

    targetSum += tgt;
    origMeasSum += orig;
    rewCorrSum += rewCorr;
    ourCorrSum += ourCorr;

    count++;
    freq *= step;
  }

  if (count === 0) continue;

  const rewRMS = Math.sqrt(rewSum / count);
  const ourRMS = Math.sqrt(ourSum / count);

  const avgTarget = targetSum / count;
  const avgOrig = origMeasSum / count;
  const avgRew = rewCorrSum / count;
  const avgOur = ourCorrSum / count;

  totalRewError += rewSum;
  totalOurError += ourSum;
  totalOrigError += origSum;
  totalCount += count;

  const rewBetter = getBandWinnerMark(rewRMS, ourRMS);
  const ourBetter = getBandWinnerMark(ourRMS, rewRMS);

  console.log(
    `   ${band.name.padEnd(14)} | ${avgOrig.toFixed(1).padStart(7)} | ` +
      `${avgRew.toFixed(1).padStart(7)} | ${avgOur.toFixed(1).padStart(7)} | ` +
      `${avgTarget.toFixed(1).padStart(7)} | ${rewRMS
        .toFixed(2)
        .padStart(4)} ${rewBetter} | ${ourRMS.toFixed(2).padStart(4)} ${ourBetter}`,
  );
}

console.log('   ' + '-'.repeat(75));

const totalRewRMS = Math.sqrt(totalRewError / totalCount);
const totalOurRMS = Math.sqrt(totalOurError / totalCount);
const totalOrigRMS = Math.sqrt(totalOrigError / totalCount);

console.log(`\n📊 Résumé global (20 Hz - 20 kHz):`);
console.log(`   Original (sans EQ): ${totalOrigRMS.toFixed(3)} dB RMS`);
console.log(
  `   REW Auto-EQ:        ${totalRewRMS.toFixed(3)} dB RMS (amélioration: ${(
    (1 - totalRewRMS / totalOrigRMS) *
    100
  ).toFixed(1)}%)`,
);
console.log(
  `   Notre Auto-EQ:      ${totalOurRMS.toFixed(3)} dB RMS (amélioration: ${(
    (1 - totalOurRMS / totalOrigRMS) *
    100
  ).toFixed(1)}%)`,
);

const diff = totalOurRMS - totalRewRMS;
if (Math.abs(diff) < 0.1) {
  console.log(`\n   ✅ Performance équivalente (Δ = ${diff.toFixed(3)} dB)`);
} else if (diff < 0) {
  console.log(`\n   🏆 Notre implémentation est meilleure de ${(-diff).toFixed(3)} dB`);
} else {
  console.log(`\n   ⚠️ REW est meilleur de ${diff.toFixed(3)} dB`);
}

// ============================================================================
// 4. ANALYSE DÉTAILLÉE DES ÉCARTS
// ============================================================================

console.log('\n📉 Écarts maximaux par rapport à la target:');
console.log('   ' + '-'.repeat(60));
console.log('   Freq (Hz)  | REW Δ (dB) | Notre Δ (dB) | Mieux');
console.log('   ' + '-'.repeat(60));

// Trouver les fréquences avec les plus grands écarts
const criticalFreqs = [
  30, 46, 70, 100, 145, 190, 265, 309, 500, 572, 713, 800, 1000, 1200, 1372, 1716, 2000,
  2144, 2283, 3000, 5000, 10000,
];

for (const freq of criticalFreqs) {
  const tgt = getTarget(freq).spl;
  const rewCorr = getRewCorrected(freq).spl;
  const ourCorr = getOurCorrected(freq).spl;

  const rewDelta = rewCorr - tgt;
  const ourDelta = ourCorr - tgt;

  const better = pickCloserToZeroWinner(rewDelta, ourDelta);

  console.log(
    `   ${freq.toString().padStart(8)} Hz | ${formatSigned(rewDelta, 6)} | ` +
      `${formatSigned(ourDelta, 8)} | ${better}`,
  );
}
console.log('   ' + '-'.repeat(60));

// ============================================================================
// 5. ANALYSE DE PHASE (GROUP DELAY)
// ============================================================================

console.log('\n🔄 Analyse de la phase (indicateur de group delay):');
console.log('   ' + '-'.repeat(50));

// Calculer la variation de phase (approximation du group delay)
function calculatePhaseVariation(getData, startFreq, endFreq) {
  let maxVariation = 0;
  let prevPhase = null;
  let freq = startFreq;

  while (freq <= endFreq) {
    const phase = getData(freq).phase;
    if (prevPhase !== null) {
      const variation = Math.abs(phase - prevPhase);
      if (variation < 180) {
        // Éviter les wraps de phase
        maxVariation = Math.max(maxVariation, variation);
      }
    }
    prevPhase = phase;
    freq *= step;
  }

  return maxVariation;
}

const phaseVariationBands = [
  { name: 'Basses (20-200 Hz)', start: 20, end: 200 },
  { name: 'Médiums (200-2000 Hz)', start: 200, end: 2000 },
  { name: 'Aigus (2000-20000 Hz)', start: 2000, end: 20000 },
];

for (const band of phaseVariationBands) {
  const rewVar = calculatePhaseVariation(getRewCorrected, band.start, band.end);
  const ourVar = calculatePhaseVariation(getOurCorrected, band.start, band.end);

  const better = pickLowerWinner(rewVar, ourVar);

  console.log(
    `   ${band.name.padEnd(25)} | REW: ${rewVar.toFixed(1)}° | Nous: ${ourVar.toFixed(
      1,
    )}° | ${better}`,
  );
}

console.log('\n' + '='.repeat(80));
console.log('🏁 Comparaison terminée');
