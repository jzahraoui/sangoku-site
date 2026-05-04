/**
 * AutoEQCalculator.js
 *
 * Orchestrateur principal du pipeline AutoEQ.
 * La validation de la configuration, la quantification, l'évaluation qualité,
 * la préparation de la grille et la détection de spans sont déléguées aux
 * modules dédiés dans `./autoeq/`.
 *
 * API publique :
 *   new AutoEQCalculator(config)
 *   await calculator.calculate(measuredSPL, targetCurve)
 *   calculator.exportFilters()
 */

import { FilterSet } from '../dsp/FilterSet.js';
import { validateFunction } from '../core/validators.js';
import { FilterParameterOptimizer } from '../optimization/FilterParameterOptimizer.js';
import { buildCalculationResult, logCalculationResult } from './resultSummary.js';
import { runBeatRewEnhancements } from './beatRewEnhancements.js';
import { runFinalOptimizationStages } from './finalOptimizationStages.js';
import { placeIterativeFilters } from './placementPipeline.js';
import { selectCandidatePlacementChallenger } from './candidatePlacementChallenger.js';
import { createAutoEQConfig } from './AutoEQConfig.js';
import { EqualizerAdapter } from './EqualizerAdapter.js';
import { FilterQualityEvaluator } from './FilterQualityEvaluator.js';
import { GridCalculationContext } from './GridCalculationContext.js';
import { SpanCandidateFinder } from './SpanCandidateFinder.js';
import { applyFiltersToFilterSet } from './filterSetAdapter.js';
import { removeFinalDeadFilters } from './filterCleanup.js';
import { createFilterOptimizerConfig } from './optimizerConfig.js';
import { createInitialMetrics } from './initialMetrics.js';

/**
 * Calculateur automatique de filtres d'égalisation
 */
export class AutoEQCalculator {
  /**
   * @param {Object} config - Configuration
   */
  constructor(config = {}) {
    const cfg = createAutoEQConfig(config);
    Object.assign(this, cfg);

    this.onProgress = validateFunction(config.onProgress, 'onProgress');
    this.onLog = validateFunction(config.onLog, 'onLog');

    this.cancelRequested = false;
    this.isCalculating = false;
    this.filterSet = new FilterSet(this.numFilters, this.sampleRate);
    this.lastQualityReport = null;

    this.equalizerAdapter = new EqualizerAdapter(cfg);
    this.qualityEvaluator = new FilterQualityEvaluator(cfg);
    this.spanFinder = new SpanCandidateFinder(cfg);
  }

  /**
   * Calcule les filtres d'égalisation.
   *
   * Algorithme:
   *   1. Grille scan 1/96 PPO
   *   2. Par slot: résiduel → spans candidats → initialisation fc/Q → optimisation gain+Q
   *   3. Tri fréquentiel → optimisation complète avec spans notch-exclus
   *   4. Élagage des filtres faibles puis réoptimisation
   *   5. Optimisation finale
   *
   * @param {{freqs:ArrayLike<number>, magnitude:ArrayLike<number>}} measuredSPL
   *   Réponse fréquentielle mesurée sur grille brute.
   * @param {{freqs:ArrayLike<number>, magnitude:ArrayLike<number>}} targetCurve
   *   Réponse fréquentielle cible sur la même grille brute.
   * @returns {Promise<Object>} { filters, initialMSE, finalMSE, improvement, elapsed }
   */
  async calculate(measuredSPL, targetCurve) {
    if (this.isCalculating) throw new Error('Calculation already in progress');
    this.isCalculating = true;
    this.cancelRequested = false;
    const startTime = performance.now();

    try {
      const calculationContext = GridCalculationContext.fromResponses(
        measuredSPL,
        targetCurve,
        this,
      );
      calculationContext.validate();

      this.onLog('=== AutoEQ Calculator ===\n');
      this.onLog(`Plage: ${this.matchRangeStart}–${this.matchRangeEnd} Hz`);
      this.onLog(
        `Filtres: ${this.numFilters}, Boost max: ${this.individualMaxBoostDb} dB, Cut max: ${this.maxCutDb} dB`,
      );

      const { scanFreqs, measuredArr, targetArr } = calculationContext;
      const numScan = scanFreqs.length;

      // MSE initial (FastMSE avec spans notch-exclus à t=0)
      const { spanAnalyzer, fastMSE, initialMSE } = createInitialMetrics(
        this,
        calculationContext,
      );
      this.onLog(
        `  Grille scan: ${numScan} points | MSE initial: ${initialMSE.toFixed(3)} dB RMS`,
      );

      this._checkCancellation();

      // ── 2. Placement per-slot
      this.onLog('\n--- Phase 1: Placement itératif ---');
      this.onProgress(10, 'Placement itératif…');

      const optimizerConfig = createFilterOptimizerConfig(this, this.equalizerAdapter);
      const placementOptimizer = new FilterParameterOptimizer(optimizerConfig);
      const finalOptimizer = new FilterParameterOptimizer(optimizerConfig);

      let filters = await placeIterativeFilters({
        scanFreqs,
        measuredArr,
        targetArr,
        calculationContext,
        placementOptimizer,
        useCandidatePlacement: false,
        config: this,
        spanFinder: this.spanFinder,
        qualityEvaluator: this.qualityEvaluator,
        equalizerAdapter: this.equalizerAdapter,
        onLog: this.onLog,
        onProgress: this.onProgress,
        checkCancellation: () => this._checkCancellation(),
      });

      this._checkCancellation();

      // ── 3. Tri fréquentiel + optimisation complète sur spans notch-exclus ──
      await runFinalOptimizationStages({
        filters,
        spanAnalyzer,
        finalOptimizer,
        calculationContext,
        config: this,
        qualityEvaluator: this.qualityEvaluator,
        equalizerAdapter: this.equalizerAdapter,
        onLog: this.onLog,
        onProgress: this.onProgress,
        checkCancellation: () => this._checkCancellation(),
        options: { runBeatEnhancements: false },
      });

      filters = await selectCandidatePlacementChallenger({
        baselineFilters: filters,
        scanFreqs,
        measuredArr,
        targetArr,
        calculationContext,
        spanAnalyzer,
        optimizerConfig,
        config: this,
        spanFinder: this.spanFinder,
        qualityEvaluator: this.qualityEvaluator,
        equalizerAdapter: this.equalizerAdapter,
        onLog: this.onLog,
        checkCancellation: () => this._checkCancellation(),
      });

      await runBeatRewEnhancements({
        filters,
        spanAnalyzer,
        finalOptimizer,
        calculationContext,
        config: this,
        qualityEvaluator: this.qualityEvaluator,
        equalizerAdapter: this.equalizerAdapter,
        onLog: this.onLog,
        checkCancellation: () => this._checkCancellation(),
      });

      // Post-optimization cleanup
      removeFinalDeadFilters(filters, {
        equalizerAdapter: this.equalizerAdapter,
        matchRangeEnd: this.matchRangeEnd,
      });

      this._checkCancellation();

      // ── Résultat ──────────────────────────────────────────────────────────
      this.onProgress(90, 'Finalisation…');

      const finalMSE =
        filters.length > 0 ? Math.sqrt(fastMSE.compute(filters)) : initialMSE;

      this.lastQualityReport = this.qualityEvaluator.evaluate(
        filters,
        calculationContext,
      );

      applyFiltersToFilterSet(this.filterSet, filters, {
        equalizerAdapter: this.equalizerAdapter,
        matchRangeStart: this.matchRangeStart,
        sampleRate: this.sampleRate,
      });

      const result = buildCalculationResult({
        filters,
        initialMSE,
        finalMSE,
        elapsed: performance.now() - startTime,
        quality: this.lastQualityReport,
      });

      this.onProgress(100, 'Terminé');
      logCalculationResult(result, this.onLog);

      return result;
    } finally {
      this.isCalculating = false;
    }
  }

  /**
   * Exporte les filtres en JSON
   */
  exportFilters() {
    return this.filterSet.toJSON();
  }

  // ==================== PRIVATE ====================

  _checkCancellation() {
    if (this.cancelRequested) {
      throw new Error('Calculation cancelled by user');
    }
  }
}

export default AutoEQCalculator;
