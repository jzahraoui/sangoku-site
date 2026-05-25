/**
 * analyze-overshoots.js
 * Analyse détaillée des overshoots et de la qualité du tracking
 */

import process from 'node:process';

import { createNearestSampler, parseREWFile } from './test-config.js';

console.log('📊 Analyse détaillée des Overshoots et du Tracking\n');
console.log('='.repeat(80));

// Charger les fichiers
console.log('\n📂 Chargement des fichiers...');

const rewCorrected = parseREWFile('./test/auto-eq/exemple1/EQ FRavg.txt');
const ourCorrected = parseREWFile('./test-results/FRavg_Equalized.txt');
const target = parseREWFile('./test/auto-eq/exemple1/Target FRavg.txt');

console.log(`   REW corrigé:    ${rewCorrected.length} points`);
console.log(`   Notre corrigé:  ${ourCorrected.length} points`);
console.log(`   Target:         ${target.length} points`);

if (rewCorrected.length === 0 || ourCorrected.length === 0 || target.length === 0) {
  console.error('❌ Erreur: fichiers vides ou mal parsés');
  process.exit(1);
}

const T = createNearestSampler(target);
const R = createNearestSampler(rewCorrected);
const O = createNearestSampler(ourCorrected);

function pickLowerWinner(leftValue, rightValue, leftLabel = 'REW', rightLabel = 'Nous') {
  if (leftValue < rightValue) {
    return leftLabel;
  }
  if (rightValue < leftValue) {
    return rightLabel;
  }
  return '=';
}

function pickHigherWinner(leftValue, rightValue, leftLabel = 'REW', rightLabel = 'Nous') {
  if (leftValue > rightValue) {
    return leftLabel;
  }
  if (rightValue > leftValue) {
    return rightLabel;
  }
  return '=';
}

function pickLowerWinnerWithMargin(leftValue, rightValue, margin = 0.1) {
  if (leftValue < rightValue - margin) {
    return 'REW';
  }
  if (rightValue < leftValue - margin) {
    return 'Nous';
  }
  return '=';
}

function getProblemLabel(ourDelta, rewDelta) {
  if (ourDelta > 1.5) {
    return '⚠️ OVERSHOOT';
  }
  if (ourDelta < -2) {
    return '⚠️ UNDERSHOOT';
  }
  if (Math.abs(ourDelta) > Math.abs(rewDelta) + 0.5) {
    return '⚠️ pire';
  }
  return '';
}

// Analyse
console.log('\n📈 Fréquences avec gros écarts (|Δ| > 1.5 dB):');
console.log('   ' + '-'.repeat(75));
console.log('   Freq (Hz) | Target | REW EQ | Δ REW  | Notre EQ | Δ Nous | Problème');
console.log('   ' + '-'.repeat(75));

let rewOver = 0,
  ourOver = 0;
let rewUnder = 0,
  ourUnder = 0;
let rewMaxOver = 0,
  ourMaxOver = 0;
let rewMaxUnder = 0,
  ourMaxUnder = 0;
let rewSumSq = 0,
  ourSumSq = 0;
let count = 0;

const step = Math.pow(2, 1 / 48);
let freq = 20;

while (freq <= 10000) {
  const tgt = T(freq);
  const rewVal = R(freq);
  const ourVal = O(freq);

  const rewDelta = rewVal - tgt;
  const ourDelta = ourVal - tgt;

  rewSumSq += rewDelta * rewDelta;
  ourSumSq += ourDelta * ourDelta;
  count++;

  // Compter les overshoots/undershoots
  if (rewDelta > 0.5) {
    rewOver++;
    rewMaxOver = Math.max(rewMaxOver, rewDelta);
  }
  if (ourDelta > 0.5) {
    ourOver++;
    ourMaxOver = Math.max(ourMaxOver, ourDelta);
  }
  if (rewDelta < -0.5) {
    rewUnder++;
    rewMaxUnder = Math.min(rewMaxUnder, rewDelta);
  }
  if (ourDelta < -0.5) {
    ourUnder++;
    ourMaxUnder = Math.min(ourMaxUnder, ourDelta);
  }

  // Afficher les gros écarts
  if (Math.abs(rewDelta) > 1.5 || Math.abs(ourDelta) > 1.5) {
    const problem = getProblemLabel(ourDelta, rewDelta);

    console.log(
      `   ${freq.toFixed(0).padStart(8)} | ${tgt.toFixed(1).padStart(5)} | ` +
        `${rewVal.toFixed(1).padStart(5)} | ${
          (rewDelta >= 0 ? '+' : '') + rewDelta.toFixed(1).padStart(5)
        } | ` +
        `${ourVal.toFixed(1).padStart(7)} | ${
          (ourDelta >= 0 ? '+' : '') + ourDelta.toFixed(1).padStart(5)
        } | ${problem}`,
    );
  }

  freq *= step;
}

console.log('   ' + '-'.repeat(75));

console.log('\n📊 Statistiques des dépassements (|Δ| > 0.5 dB):');
console.log('   ' + '-'.repeat(55));
console.log('   Métrique              | REW        | Nous       | Meilleur');
console.log('   ' + '-'.repeat(55));
console.log(
  `   Overshoots (>target)  | ${rewOver.toString().padStart(5)}      | ${ourOver
    .toString()
    .padStart(5)}      | ${pickLowerWinner(rewOver, ourOver)}`,
);
console.log(
  `   Max overshoot         | +${rewMaxOver.toFixed(1).padStart(4)} dB   | +${ourMaxOver
    .toFixed(1)
    .padStart(4)} dB   | ${pickLowerWinner(rewMaxOver, ourMaxOver)}`,
);
console.log(
  `   Undershoots (<target) | ${rewUnder.toString().padStart(5)}      | ${ourUnder
    .toString()
    .padStart(5)}      | ${pickLowerWinner(rewUnder, ourUnder)}`,
);
console.log(
  `   Max undershoot        | ${rewMaxUnder.toFixed(1).padStart(5)} dB   | ${ourMaxUnder
    .toFixed(1)
    .padStart(5)} dB   | ${pickHigherWinner(rewMaxUnder, ourMaxUnder)}`,
);
console.log(
  `   RMS erreur (20-10k)   | ${Math.sqrt(rewSumSq / count)
    .toFixed(3)
    .padStart(5)} dB   | ${Math.sqrt(ourSumSq / count)
    .toFixed(3)
    .padStart(5)} dB   | ${pickLowerWinner(
    Math.sqrt(rewSumSq / count),
    Math.sqrt(ourSumSq / count),
  )}`,
);
console.log('   ' + '-'.repeat(55));

// Analyse des variations (smoothness)
console.log('\n📉 Analyse de la régularité (variations point à point):');

let rewVariations = 0,
  ourVariations = 0;
let prevRew = null,
  prevOur = null;
freq = 20;

while (freq <= 10000) {
  const rewVal = R(freq);
  const ourVal = O(freq);

  if (prevRew !== null) {
    rewVariations += Math.abs(rewVal - prevRew);
    ourVariations += Math.abs(ourVal - prevOur);
  }

  prevRew = rewVal;
  prevOur = ourVal;
  freq *= step;
}

console.log(`   Somme des variations REW:   ${rewVariations.toFixed(1)} dB`);
console.log(`   Somme des variations Nous:  ${ourVariations.toFixed(1)} dB`);
console.log(
  `   → ${
    rewVariations < ourVariations ? 'REW plus lisse' : 'Nous plus lisses'
  } (ratio: ${(ourVariations / rewVariations).toFixed(2)}x)`,
);

// Analyse par zone
console.log('\n📊 Analyse par zone fréquentielle:');
console.log('   ' + '-'.repeat(65));
console.log('   Zone           | REW RMS | Nous RMS | REW over | Nous over | Mieux');
console.log('   ' + '-'.repeat(65));

const zones = [
  { name: 'Sub (20-60)', start: 20, end: 60 },
  { name: 'Bass (60-200)', start: 60, end: 200 },
  { name: 'LowMid (200-500)', start: 200, end: 500 },
  { name: 'Mid (500-1k)', start: 500, end: 1000 },
  { name: 'HighMid (1k-3k)', start: 1000, end: 3000 },
  { name: 'High (3k-10k)', start: 3000, end: 10000 },
];

for (const zone of zones) {
  let rewSum = 0,
    ourSum = 0,
    rewO = 0,
    ourO = 0,
    cnt = 0;
  freq = zone.start;

  while (freq <= zone.end) {
    const tgt = T(freq);
    const rewDelta = R(freq) - tgt;
    const ourDelta = O(freq) - tgt;

    rewSum += rewDelta * rewDelta;
    ourSum += ourDelta * ourDelta;
    if (rewDelta > 0.5) rewO++;
    if (ourDelta > 0.5) ourO++;
    cnt++;
    freq *= step;
  }

  const rewRMS = Math.sqrt(rewSum / cnt);
  const ourRMS = Math.sqrt(ourSum / cnt);
  const better = pickLowerWinnerWithMargin(rewRMS, ourRMS);

  console.log(
    `   ${zone.name.padEnd(17)} | ${rewRMS.toFixed(2).padStart(6)} | ${ourRMS
      .toFixed(2)
      .padStart(7)} | ` +
      `${rewO.toString().padStart(8)} | ${ourO.toString().padStart(9)} | ${better}`,
  );
}

console.log('   ' + '-'.repeat(65));

console.log('\n' + '='.repeat(80));
console.log('🏁 Analyse terminée');
