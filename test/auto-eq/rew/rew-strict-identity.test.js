/**
 * Test de parité stricte REW.
 *
 * Vérifie que notre implémentation, avec les mêmes paramètres d'entrée que REW,
 * produit des filtres **identiques** (même nombre, même fc, gain et Q après
 * quantification égaliseur).
 *
 * Les paramètres d'entrée sont dérivés du fichier rew-auto-eq.txt de chaque
 * exemple (equalizer model, freq/gain step, number of slots) pour reproduire
 * exactement la configuration que REW a utilisée.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { AutoEQCalculator } from '../../../src/index.js';
import {
  createConfig,
  parseREWFile,
  projectResponseToReferenceGrid,
  toFrequencyResponse,
} from '../test-config.js';

// ── Exemples de test ──

const examples = [
  {
    name: 'exemple1',
    measured: './test/auto-eq/exemple1/FRavg.txt',
    target: './test/auto-eq/exemple1/Target FRavg.txt',
    rewFilters: './test/auto-eq/exemple1/rew-auto-eq.txt',
    allowNarrowFiltersBelow200Hz: true,
    varyQAbove200Hz: false,
  },
  {
    name: 'exemple2',
    measured: './test/auto-eq/exemple2/Cavg.txt',
    target: './test/auto-eq/exemple2/Target Cavg.txt',
    rewFilters: './test/auto-eq/exemple2/rew-auto-eq.txt',
    allowNarrowFiltersBelow200Hz: true,
    varyQAbove200Hz: false,
  },
  {
    name: 'exemple3',
    measured: './test/auto-eq/exemple3/FLavg.txt',
    target: './test/auto-eq/exemple3/Target FLavg.txt',
    rewFilters: './test/auto-eq/exemple3/rew-auto-eq.txt',
    allowNarrowFiltersBelow200Hz: true,
    varyQAbove200Hz: true,
  },
  {
    name: 'exemple4',
    measured: './test/auto-eq/exemple4/SBRavg.txt',
    target: './test/auto-eq/exemple4/Target SBRavg.txt',
    rewFilters: './test/auto-eq/exemple4/rew-auto-eq.txt',
    allowNarrowFiltersBelow200Hz: true,
    varyQAbove200Hz: true,
  },
];

// ── Parsing des filtres REW ──

function parseRewAutoEqFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const filters = [];
  let inFilters = false;
  let totalSlots = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === 'Compound_filters') break;
    if (trimmed.startsWith('Number')) {
      inFilters = true;
      continue;
    }
    if (!inFilters) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 4) continue;
    if (parts[1] !== 'True') continue;

    totalSlots++;

    if (parts[3] !== 'PK') continue;

    filters.push({
      fc: Number.parseFloat(parts[4]),
      gain: Number.parseFloat(parts[5]),
      Q: Number.parseFloat(parts[6]),
    });
  }

  return {
    filters: filters.filter(
      f => Number.isFinite(f.fc) && Number.isFinite(f.gain) && Number.isFinite(f.Q),
    ),
    totalSlots,
  };
}

// ── Dérivation des paramètres à partir des filtres REW ──

function deriveMatchRangeEnd(rewFilters) {
  const maxFc = rewFilters.reduce((m, f) => Math.max(m, f.fc), 0);
  if (maxFc <= 0) return 20000;
  if (maxFc >= 10000) return 20000;
  return Math.max(3000, maxFc);
}

function maxDecimals(values) {
  return values.reduce((m, v) => {
    const s = v.toString();
    const d = s.indexOf('.');
    return d < 0 ? m : Math.max(m, s.length - d - 1);
  }, 0);
}

function deriveEqualizerFreqStep(rewFilters) {
  const d = maxDecimals(rewFilters.map(f => f.fc));

  if (d >= 2) {
    return 0.01;
  }

  if (d === 1) {
    return 0.1;
  }

  return 1;
}

function deriveEqualizerGainStep(rewFilters) {
  const d = maxDecimals(rewFilters.map(f => f.gain));
  return d >= 2 ? 0.01 : 0.1;
}

// ── Formatage des différences ──

function formatFilter(f) {
  return `fc=${f.fc} gain=${f.gain} Q=${f.Q}`;
}

// Complexité assumée : test d'identité stricte rouge de longue date
// (CLAUDE.md : « ne pas réparer ») — pas de refactor sans REW réel.
// eslint-disable-next-line sonarjs/cognitive-complexity
function compareFilters(ourFilters, rewFilters, freqStep, gainStep) {
  const diffs = [];
  const maxCount = Math.max(ourFilters.length, rewFilters.length);

  for (let i = 0; i < maxCount; i++) {
    const ours = ourFilters[i];
    const rew = rewFilters[i];

    if (!ours) {
      diffs.push(`  #${i + 1}: MANQUANT chez nous — REW: ${formatFilter(rew)}`);
      continue;
    }
    if (!rew) {
      diffs.push(`  #${i + 1}: EN TROP chez nous — Nous: ${formatFilter(ours)}`);
      continue;
    }

    const fcDiff = Math.abs(ours.fc - rew.fc);
    const gainDiff = Math.abs(ours.gain - rew.gain);
    const qDiff = Math.abs(ours.Q - rew.Q);

    // Tolérance = 1 pas de quantification pour fc et gain, 0.001 pour Q
    const fcTol = Math.max(freqStep, 1);
    const gainTol = gainStep + 1e-6;
    const qTol = 0.001;

    if (fcDiff > fcTol || gainDiff > gainTol || qDiff > qTol) {
      const parts = [];
      if (fcDiff > fcTol)
        parts.push(`fc: ${ours.fc} vs ${rew.fc} (Δ${fcDiff.toFixed(2)})`);
      if (gainDiff > gainTol)
        parts.push(`gain: ${ours.gain} vs ${rew.gain} (Δ${gainDiff.toFixed(2)})`);
      if (qDiff > qTol)
        parts.push(
          `Q: ${ours.Q.toFixed(3)} vs ${rew.Q.toFixed(3)} (Δ${qDiff.toFixed(3)})`,
        );
      diffs.push(`  #${i + 1}: ${parts.join(', ')}`);
    }
  }

  return diffs;
}

// ── Test principal ──

test('Strict identity: our filters must match REW exactly', async () => {
  const allDiffs = [];

  for (const example of examples) {
    if (
      !existsSync(example.measured) ||
      !existsSync(example.target) ||
      !existsSync(example.rewFilters)
    ) {
      continue;
    }

    // 1. Charger les données d'entrée
    const measuredData = parseREWFile(example.measured);
    const targetData = parseREWFile(example.target);
    const measuredResponse = toFrequencyResponse(measuredData);
    const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);

    // 2. Parser la référence REW et dériver les paramètres
    const { filters: rewFilters, totalSlots } = parseRewAutoEqFile(example.rewFilters);
    const matchRangeEnd = deriveMatchRangeEnd(rewFilters);
    const equalizerFreqStep = deriveEqualizerFreqStep(rewFilters);
    const equalizerGainStep = deriveEqualizerGainStep(rewFilters);

    // 3. Construire la config identique à REW
    const config = createConfig(
      {
        matchRangeEnd,
        numFilters: totalSlots,
        equalizerFreqStep,
        equalizerGainStep,
        allowNarrowFiltersBelow200Hz: example.allowNarrowFiltersBelow200Hz,
        varyQAbove200Hz: example.varyQAbove200Hz,
        equalizerManufacturer: 'Generic',
        equalizerModel: 'Generic',
      },
      { silent: true },
    );

    // 4. Exécuter notre algorithme
    const calculator = new AutoEQCalculator(config);
    await calculator.calculate(measuredResponse, targetResponse);

    // 5. Extraire les filtres actifs, triés par fréquence
    const ourFilters = calculator.filterSet
      .getActiveFilters()
      .sort((a, b) => a.fc - b.fc)
      .map(f => ({ fc: f.fc, gain: f.gain, Q: f.Q }));

    const rewSorted = [...rewFilters].sort((a, b) => a.fc - b.fc);

    // 6. Comparer le nombre de filtres
    const exDiffs = [];

    if (ourFilters.length !== rewSorted.length) {
      exDiffs.push(
        `  Nombre de filtres: nous=${ourFilters.length}, REW=${rewSorted.length}`,
      );
    }

    // 7. Comparer filtre par filtre
    const filterDiffs = compareFilters(
      ourFilters,
      rewSorted,
      equalizerFreqStep,
      equalizerGainStep,
    );
    exDiffs.push(...filterDiffs);

    if (exDiffs.length > 0) {
      allDiffs.push(
        `${example.name} (${ourFilters.length} vs ${rewSorted.length} filtres):\n${exDiffs.join('\n')}`,
      );
    }
  }

  if (allDiffs.length > 0) {
    assert.fail(`Parité stricte non atteinte:\n\n${allDiffs.join('\n\n')}`);
  }
});
