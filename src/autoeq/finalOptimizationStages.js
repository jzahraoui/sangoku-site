/**
 * finalOptimizationStages.js
 *
 * Runs the final AutoEQ optimization passes after initial filter placement:
 * weak filter cleanup, full-parameter optimization, pruning, overshoot reduction,
 * and optional Beat REW refinements.
 */

import { removeWeakFilters } from './filterUtils.js';
import { reduceTargetOvershoot } from './targetOvershoot.js';
import { initializeOptimizer, runAllIfNeeded } from './optimizerRunner.js';
import { runBeatRewEnhancements } from './beatRewEnhancements.js';

export async function runFinalOptimizationStages({
  filters,
  spanAnalyzer,
  finalOptimizer,
  calculationContext,
  config,
  qualityEvaluator,
  equalizerAdapter,
  onLog,
  onProgress,
  checkCancellation,
  options = {},
}) {
  filters.sort((a, b) => a.fc - b.fc);
  onLog('\n--- Phase 2: Optimisation finale ---');
  onProgress(55, 'Optimisation complète…');

  const removeThreshold = Math.max(
    config.equalizerGainStep ?? 0.5,
    config.flatnessTarget * 0.5,
  );

  // Boucle nettoyage + réoptimisation (parité REW C0417G.m1780A) : chaque passe
  // retire les filtres faibles puis réoptimise ; on s'arrête quand une passe
  // n'a plus rien retiré de significatif, dans la limite de
  // numOptimizationPasses. Avec 1 passe : comportement historique.
  const maxCleanupPasses = Math.max(1, Math.round(config.numOptimizationPasses ?? 1));
  for (let pass = 0; pass < maxCleanupPasses; pass++) {
    checkCancellation();
    const removal = removeWeakFilters(filters, removeThreshold);
    if (pass > 0 && (removal.removedCount === 0 || removal.maxRemovedGain <= 0.1)) {
      break;
    }
    if (pass > 0) {
      onLog(
        `  Nettoyage passe ${pass + 1}: ${removal.removedCount} filtre(s) faible(s) retiré(s)`,
      );
    }
    await runAllIfNeeded(filters, spanAnalyzer, finalOptimizer, calculationContext, {
      equalizerAdapter,
      maxIter: options.maxIter ?? 500,
      logOverride: onLog,
      runAllOptions: {
        useDecimated: true,
        ...options.runAllOptions,
      },
    });
  }

  onLog('\n--- Phase 4: Élagage post-optimisation ---');
  await pruneCounterproductiveFilters({
    filters,
    spanAnalyzer,
    finalOptimizer,
    calculationContext,
    equalizerAdapter,
    onLog,
    options: {
      maxIter: options.maxIter ?? 500,
      runAllOptions: {
        useDecimated: true,
        ...options.runAllOptions,
      },
    },
  });

  reduceTargetOvershoot(filters, calculationContext, {
    sampleRate: config.sampleRate,
    threshold: config.maxAllowedOvershoot,
    onLog,
  });

  if (options.runBeatEnhancements ?? true) {
    await runBeatRewEnhancements({
      filters,
      spanAnalyzer,
      finalOptimizer,
      calculationContext,
      config,
      qualityEvaluator,
      equalizerAdapter,
      onLog,
      checkCancellation,
    });
  }
}

export async function pruneCounterproductiveFilters({
  filters,
  spanAnalyzer,
  finalOptimizer,
  calculationContext,
  equalizerAdapter,
  onLog,
  options = {},
}) {
  if (filters.length <= 1) return;

  let pruned = 0;
  let improved = true;

  while (improved && filters.length > 1) {
    improved = false;

    const spans = spanAnalyzer.calcSpansExclNotches(filters);
    initializeOptimizer(finalOptimizer, calculationContext, spans);
    const baseMSE = finalOptimizer._computeMSE(filters);

    let bestIdx = -1;
    let bestMSEWithout = baseMSE;

    for (let i = 0; i < filters.length; i++) {
      const savedGain = filters[i].gain;
      filters[i].gain = 0;
      const mseWithout = finalOptimizer._computeMSE(filters);
      filters[i].gain = savedGain;

      if (mseWithout < bestMSEWithout) {
        bestMSEWithout = mseWithout;
        bestIdx = i;
      }
    }

    if (bestIdx !== -1) {
      const removed = filters.splice(bestIdx, 1)[0];
      pruned++;
      improved = true;
      onLog(
        `  Élagué: fc=${removed.fc.toFixed(1)} Hz gain=${removed.gain.toFixed(2)} dB (MSE ${Math.sqrt(baseMSE).toFixed(3)} → ${Math.sqrt(bestMSEWithout).toFixed(3)})`,
      );
    }
  }

  if (pruned > 0) {
    onLog(`  ${pruned} filtre(s) élagué(s)`);

    await runAllIfNeeded(filters, spanAnalyzer, finalOptimizer, calculationContext, {
      equalizerAdapter,
      maxIter: options.maxIter ?? 500,
      logOverride: onLog,
      runAllOptions: options.runAllOptions,
    });
  } else {
    onLog('  Aucun filtre contre-productif');
  }
}
