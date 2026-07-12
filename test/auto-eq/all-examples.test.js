/**
 * test-all-examples.js
 * Test Auto-EQ sur tous les exemples et comparaison avec REW
 */

import { existsSync } from 'node:fs';
import { AutoEQCalculator } from '../../src/index.js';
import {
  parseREWFile,
  parseREWFilters,
  createNearestSampler,
  toFrequencyResponse,
  projectResponseToReferenceGrid,
  calculateRMSError,
  createConfig,
} from './test-config.js';

console.log('🎵 Test Auto-EQ sur tous les exemples\n');
console.log('='.repeat(80));

// ============================================================================
// FONCTIONS UTILITAIRES SPÉCIFIQUES
// ============================================================================

function countOvershoots(
  data,
  targetFn,
  startFreq = 20,
  endFreq = 20000,
  threshold = 0.5,
) {
  const inRange = data.filter(d => d.freq >= startFreq && d.freq <= endFreq);
  return inRange.filter(d => d.spl - targetFn(d.freq) > threshold).length;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const examples = [
  {
    name: 'Exemple 1 (FR)',
    dir: 'exemple1',
    measure: 'FRavg.txt',
    target: 'Target FRavg.txt',
    rewEQ: 'EQ FRavg.txt',
  },
  {
    name: 'Exemple 2 (C)',
    dir: 'exemple2',
    measure: 'Cavg.txt',
    target: 'Target Cavg.txt',
    rewEQ: 'EQ Cavg.txt',
  },
  {
    name: 'Exemple 3 (FL)',
    dir: 'exemple3',
    measure: 'FLavg.txt',
    target: 'Target FLavg.txt',
    rewEQ: 'EQ FLavg.txt',
  },
  {
    name: 'Exemple 4 (SBR)',
    dir: 'exemple4',
    measure: 'SBRavg.txt',
    target: 'Target SBRavg.txt',
    rewEQ: 'EQ SBRavg.txt',
  },
];

// Drapeaux qualité des défauts UI (MeasurementViewModel.autoEqConfig).
// Boosts et plage restent ceux de la référence REW (voir second passage).
const PROD_UI_OVERRIDES = {
  maxCutDb: 15,
  flatnessTarget: 0.3,
  numOptimizationPasses: 20,
  enableBeatRewOptimization: true,
  enableCandidatePlacement: true,
  enableReduceRepair: true,
  enableCriticalBandRefinement: true,
};

const results = [];

// ============================================================================
// TESTS
// ============================================================================

for (const example of examples) {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`📂 ${example.name}`);
  console.log(`${'─'.repeat(80)}`);

  const basePath = `./test/auto-eq/${example.dir}`;

  // Vérifier que les fichiers existent
  const measurePath = `${basePath}/${example.measure}`;
  const targetPath = `${basePath}/${example.target}`;
  const rewEQPath = `${basePath}/${example.rewEQ}`;
  const rewFiltersPath = `${basePath}/rew-auto-eq.txt`;

  if (!existsSync(measurePath) || !existsSync(targetPath)) {
    console.log(`   ⚠️ Fichiers manquants, skip...`);
    continue;
  }

  // Charger les données
  const measuredData = parseREWFile(measurePath);
  const targetData = parseREWFile(targetPath);
  const measuredResponse = toFrequencyResponse(measuredData);
  const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);
  const targetSampler = createNearestSampler(targetResponse);

  console.log(`   📈 Mesure: ${measuredData.length} points`);
  console.log(`   🎯 Target: ${targetData.length} points`);

  // Charger REW EQ si disponible
  let rewEQData = null;
  let rewFilters = [];
  if (existsSync(rewEQPath)) {
    rewEQData = parseREWFile(rewEQPath);
    console.log(`   📊 REW EQ: ${rewEQData.length} points`);
  }
  if (existsSync(rewFiltersPath)) {
    rewFilters = parseREWFilters(rewFiltersPath);
    console.log(`   🔧 REW Filtres: ${rewFilters.length}`);
  }

  // Calculer l'erreur initiale
  const initialRMS = calculateRMSError(measuredData, targetSampler, 20, 20000);
  const initialRMS_mid = calculateRMSError(measuredData, targetSampler, 40, 3000); // Plage médiums pour comparaison
  console.log(
    `\n   📉 Erreur initiale: ${initialRMS.toFixed(
      2,
    )} dB RMS (full), ${initialRMS_mid.toFixed(2)} dB RMS (40-3k)`,
  );

  // Calculer l'erreur REW si disponible
  let rewRMS = null;
  let rewRMS_mid = null;
  let rewOvershoots = null;
  if (rewEQData) {
    rewRMS = calculateRMSError(rewEQData, targetSampler, 20, 20000);
    rewRMS_mid = calculateRMSError(rewEQData, targetSampler, 40, 3000);
    rewOvershoots = countOvershoots(rewEQData, targetSampler, 40, 3000);
    console.log(
      `   📊 REW: ${rewRMS.toFixed(2)} dB RMS (full), ${rewRMS_mid.toFixed(
        2,
      )} dB RMS (40-3k), ${rewOvershoots} overshoots`,
    );
  }

  // Lancer notre Auto-EQ
  console.log(`\n   ⚙️ Calcul Auto-EQ...`);

  const calculator = new AutoEQCalculator(createConfig());

  const startTime = Date.now();
  await calculator.calculate(measuredResponse, targetResponse);
  const elapsed = Date.now() - startTime;

  // Calculer la réponse équalisée
  const equalizedData = measuredData.map(point => {
    const filterResponse = calculator.filterSet.getCumulativeComplexResponse(point.freq);
    return {
      freq: point.freq,
      spl: point.spl + filterResponse.magnitudeDB,
    };
  });

  const ourRMS = calculateRMSError(equalizedData, targetSampler, 20, 20000);
  const ourRMS_mid = calculateRMSError(equalizedData, targetSampler, 40, 3000);
  const ourOvershoots = countOvershoots(equalizedData, targetSampler, 40, 3000);
  const activeFilters = calculator.filterSet.getActiveFilters();

  console.log(`   ✅ Terminé en ${elapsed}ms`);
  console.log(`   🎚️ ${activeFilters.length} filtres actifs`);
  console.log(
    `   📈 Notre EQ: ${ourRMS.toFixed(2)} dB RMS (full), ${ourRMS_mid.toFixed(
      2,
    )} dB RMS (40-3k), ${ourOvershoots} overshoots`,
  );

  // Comparer avec REW
  if (rewRMS !== null) {
    const diffFull = ourRMS - rewRMS;
    const diffMid = ourRMS_mid - rewRMS_mid;
    let betterFull = '= Égal';
    let betterMid = '= Égal';
    if (diffFull < 0) {
      betterFull = '✅ Nous';
    } else if (diffFull > 0) {
      betterFull = '⚠️ REW';
    }
    if (diffMid < 0) {
      betterMid = '✅ Nous';
    } else if (diffMid > 0) {
      betterMid = '⚠️ REW';
    }
    console.log(`\n   📊 Comparaison vs REW:`);
    console.log(
      `      Full (20-20k): ${diffFull > 0 ? '+' : ''}${diffFull.toFixed(
        2,
      )} dB (${betterFull})`,
    );
    console.log(
      `      Mid (40-3k):   ${diffMid > 0 ? '+' : ''}${diffMid.toFixed(
        2,
      )} dB (${betterMid})`,
    );
    console.log(`      Overshoots:    ${ourOvershoots} vs ${rewOvershoots} REW`);
  }

  // Afficher les filtres
  console.log(`\n   🔧 Filtres générés:`);
  activeFilters.sort((a, b) => a.fc - b.fc);
  for (const f of activeFilters) {
    const gainStr = (f.gain >= 0 ? '+' : '') + f.gain.toFixed(1);
    console.log(
      `      ${f.fc.toFixed(0).padStart(6)} Hz  ${gainStr.padStart(
        6,
      )} dB  Q=${f.Q.toFixed(2)}`,
    );
  }

  // Second passage: drapeaux qualité de l'UI de production (Beat REW +
  // candidate placement). Plage et limites de boost gardées identiques à la
  // référence REW (6/6 dB, 20-20000 Hz) pour comparer à référence égale.
  console.log(`\n   ⚙️ Calcul Auto-EQ (config UI production)...`);
  const uiCalculator = new AutoEQCalculator(
    createConfig(PROD_UI_OVERRIDES, { silent: true }),
  );
  const uiStartTime = Date.now();
  await uiCalculator.calculate(measuredResponse, targetResponse);
  const uiElapsed = Date.now() - uiStartTime;

  const uiEqualizedData = measuredData.map(point => {
    const filterResponse = uiCalculator.filterSet.getCumulativeComplexResponse(
      point.freq,
    );
    return { freq: point.freq, spl: point.spl + filterResponse.magnitudeDB };
  });
  const uiRMS = calculateRMSError(uiEqualizedData, targetSampler, 20, 20000);
  const uiRMS_mid = calculateRMSError(uiEqualizedData, targetSampler, 40, 3000);
  const uiOvershoots = countOvershoots(uiEqualizedData, targetSampler, 40, 3000);
  console.log(
    `   📈 Config UI: ${uiRMS.toFixed(2)} dB RMS (full), ${uiRMS_mid.toFixed(
      2,
    )} dB RMS (40-3k), ${uiOvershoots} overshoots (${uiElapsed}ms)`,
  );

  // Sauvegarder les résultats
  results.push({
    name: example.name,
    initialRMS,
    initialRMS_mid,
    rewRMS,
    rewRMS_mid,
    rewOvershoots,
    rewFiltersCount: rewFilters.length,
    ourRMS,
    ourRMS_mid,
    ourOvershoots,
    ourFiltersCount: activeFilters.length,
    elapsed,
    uiRMS,
    uiRMS_mid,
    uiOvershoots,
    uiFiltersCount: uiCalculator.filterSet.getActiveFilters().length,
    uiElapsed,
  });
}

// ============================================================================
// RÉSUMÉ FINAL
// ============================================================================

console.log(`\n${'═'.repeat(80)}`);
console.log('📊 RÉSUMÉ FINAL');
console.log(`${'═'.repeat(80)}\n`);

// Tableau pour la plage complète (20-20000 Hz)
console.log('📊 Plage complète (20-20000 Hz):');
console.log(
  '┌─────────────────────┬───────────┬───────────┬───────────┬───────────┬──────────┐',
);
console.log(
  '│ Exemple             │ Initial   │ REW       │ Nous      │ Δ RMS     │ Verdict  │',
);
console.log(
  '├─────────────────────┼───────────┼───────────┼───────────┼───────────┼──────────┤',
);

for (const r of results) {
  const initial = r.initialRMS.toFixed(2).padStart(7);
  const rew = r.rewRMS ? r.rewRMS.toFixed(2).padStart(7) : '   N/A ';
  const our = r.ourRMS.toFixed(2).padStart(7);
  const diff = r.rewRMS ? (r.ourRMS - r.rewRMS).toFixed(2) : 'N/A';
  let diffStr = '   N/A ';
  let verdict = '   -   ';
  if (r.rewRMS) {
    diffStr = (diff > 0 ? `+${diff}` : diff).padStart(7);
    verdict = r.ourRMS <= r.rewRMS ? '  ✅   ' : '  ⚠️   ';
  }

  console.log(
    `│ ${r.name.padEnd(19)} │ ${initial} │ ${rew} │ ${our} │ ${diffStr} │${verdict}│`,
  );
}

console.log(
  '└─────────────────────┴───────────┴───────────┴───────────┴───────────┴──────────┘',
);

// Tableau pour la plage médiums (40-3000 Hz) - la plus représentative visuellement
console.log('\n📊 Plage médiums (40-3000 Hz) - Comparaison principale:');
console.log(
  '┌─────────────────────┬───────────┬───────────┬───────────┬───────────┬──────────┐',
);
console.log(
  '│ Exemple             │ Initial   │ REW       │ Nous      │ Δ RMS     │ Verdict  │',
);
console.log(
  '├─────────────────────┼───────────┼───────────┼───────────┼───────────┼──────────┤',
);

for (const r of results) {
  const initial = r.initialRMS_mid.toFixed(2).padStart(7);
  const rew = r.rewRMS_mid ? r.rewRMS_mid.toFixed(2).padStart(7) : '   N/A ';
  const our = r.ourRMS_mid.toFixed(2).padStart(7);
  const diff = r.rewRMS_mid ? (r.ourRMS_mid - r.rewRMS_mid).toFixed(2) : 'N/A';
  let diffStr = '   N/A ';
  let verdict = '   -   ';
  if (r.rewRMS_mid) {
    diffStr = (diff > 0 ? `+${diff}` : diff).padStart(7);
    verdict = r.ourRMS_mid <= r.rewRMS_mid ? '  ✅   ' : '  ⚠️   ';
  }

  console.log(
    `│ ${r.name.padEnd(19)} │ ${initial} │ ${rew} │ ${our} │ ${diffStr} │${verdict}│`,
  );
}

console.log(
  '└─────────────────────┴───────────┴───────────┴───────────┴───────────┴──────────┘',
);

// Statistiques globales
const withREW = results.filter(r => r.rewRMS !== null);
if (withREW.length > 0) {
  const avgOurRMS = withREW.reduce((s, r) => s + r.ourRMS, 0) / withREW.length;
  const avgREWRMS = withREW.reduce((s, r) => s + r.rewRMS, 0) / withREW.length;
  const avgOurRMS_mid = withREW.reduce((s, r) => s + r.ourRMS_mid, 0) / withREW.length;
  const avgREWRMS_mid = withREW.reduce((s, r) => s + r.rewRMS_mid, 0) / withREW.length;
  const winsFull = withREW.filter(r => r.ourRMS <= r.rewRMS).length;
  const winsMid = withREW.filter(r => r.ourRMS_mid <= r.rewRMS_mid).length;

  console.log(`\n📈 Statistiques globales:`);
  console.log(
    `   Full (20-20k): REW=${avgREWRMS.toFixed(2)} dB, Nous=${avgOurRMS.toFixed(
      2,
    )} dB, Victoires=${winsFull}/${withREW.length}`,
  );
  console.log(
    `   Mid (40-3k):   REW=${avgREWRMS_mid.toFixed(2)} dB, Nous=${avgOurRMS_mid.toFixed(
      2,
    )} dB, Victoires=${winsMid}/${withREW.length}`,
  );
}

// Tableau config UI de production
console.log(`\n📊 Config UI production (Beat REW + candidate placement):`);
console.log(
  '┌─────────────────────┬───────────┬───────────┬───────────┬────────────────────┐',
);
console.log(
  '│ Exemple             │ REW mid   │ UI mid    │ UI full   │ Overshoots UI/REW  │',
);
console.log(
  '├─────────────────────┼───────────┼───────────┼───────────┼────────────────────┤',
);
for (const r of results) {
  const rew = r.rewRMS_mid ? r.rewRMS_mid.toFixed(2).padStart(7) : '   N/A ';
  const uiMid = r.uiRMS_mid.toFixed(2).padStart(7);
  const uiFull = r.uiRMS.toFixed(2).padStart(7);
  const os = `${r.uiOvershoots} / ${r.rewOvershoots ?? 'N/A'}`.padStart(16);
  console.log(
    `│ ${r.name.padEnd(19)} │ ${rew} │ ${uiMid} │ ${uiFull} │ ${os}   │`,
  );
}
console.log(
  '└─────────────────────┴───────────┴───────────┴───────────┴────────────────────┘',
);

// ============================================================================
// ASSERTIONS NORMATIVES (spec.md)
// ============================================================================
// SC-008 : overshoots ≤ 2× REW sur chaque exemple.
// SC-010 : RMS 40-3k ≤ 1.5× REW sur chaque exemple.
// Appliquées aux deux configurations (golden baseline et UI production).
const violations = [];
for (const r of results) {
  const runs = [
    { label: '', overshoots: r.ourOvershoots, rmsMid: r.ourRMS_mid },
    { label: ' (config UI)', overshoots: r.uiOvershoots, rmsMid: r.uiRMS_mid },
  ];
  for (const run of runs) {
    if (r.rewOvershoots !== null && run.overshoots > 2 * r.rewOvershoots) {
      violations.push(
        `SC-008 ${r.name}${run.label}: overshoots ${run.overshoots} > 2× REW (${r.rewOvershoots})`,
      );
    }
    if (r.rewRMS_mid !== null && run.rmsMid > 1.5 * r.rewRMS_mid) {
      violations.push(
        `SC-010 ${r.name}${run.label}: RMS mid ${run.rmsMid.toFixed(2)} > 1.5× REW (${r.rewRMS_mid.toFixed(2)})`,
      );
    }
  }
}

console.log(`\n${'═'.repeat(80)}`);
if (violations.length > 0) {
  for (const v of violations) {
    console.log(`❌ ${v}`);
  }
  console.log(`${'═'.repeat(80)}`);
  process.exit(1);
}
console.log('✅ Tous les tests terminés (SC-008 et SC-010 respectés)');
console.log(`${'═'.repeat(80)}`);
