import { buildAudioSelectionReport } from './audio-selection.js';
import { calculateImplementationCost, calculateMetricDelta } from './report-metrics.js';

export {
  AUDIO_SELECTION,
  buildAudioSelectionReport,
  calculateAudioSelectionScore,
  compareAudioCandidates,
  evaluateAudioSelectionGuardrails,
  selectBestAudioCandidate,
} from './audio-selection.js';

export {
  calculateImplementationCost,
  calculateMagnitudeStats,
  calculateMetricDelta,
  calculateReportMetrics,
} from './report-metrics.js';

export function buildOptimizationReport({
  config,
  preparedSubs,
  result,
  baselineMetrics,
  preRefinementMetrics,
  globalTheoreticalMax,
  finalResponse,
  optimizedSubs,
  calculateReportMetrics,
  normalizeParam,
}) {
  const finalMetrics = calculateReportMetrics(finalResponse, globalTheoreticalMax);
  const improvement = calculateMetricDelta(baselineMetrics, finalMetrics);
  const refinementDelta = calculateMetricDelta(preRefinementMetrics, finalMetrics);
  const allPass = buildAllPassReport({
    config,
    optimizedSubs,
    comparativeAnalysis: result.comparativeAnalysis,
  });
  const implementationCost = calculateImplementationCost(preparedSubs, normalizeParam);
  const audioSelection = buildAudioSelectionReport({
    baselineMetrics,
    finalMetrics,
    improvement,
    allPass,
    implementationCost,
    objective: config.optimization.objective,
  });

  return {
    objective: config.optimization.objective,
    theoreticalWeight: config.optimization.theoreticalWeight,
    frequencyRange: { ...config.frequency },
    subwooferCount: preparedSubs.length,
    baseline: baselineMetrics,
    preRefinement: preRefinementMetrics,
    final: finalMetrics,
    improvement,
    globalRefinement: {
      enabled: config.optimization.globalRefinement.enabled,
      improvements: result.globalRefinement?.improvements ?? 0,
      delta: refinementDelta,
    },
    allPass,
    implementationCost,
    audioSelection,
    search: buildSearchReport(config, result.comparativeAnalysis),
    // legacyBestScore mirrors the user-facing objective score of the cumulative
    // optimized response (without the search-only delay regularizer), so it
    // matches `final.objectiveScore` and is comparable across runs.
    legacyBestScore: finalMetrics.objectiveScore,
  };
}

export function buildSearchReport(config, comparativeAnalysis = []) {
  const perSub = comparativeAnalysis.map(entry => entry.searchStats).filter(Boolean);
  const genetic = perSub.filter(entry => entry.method === 'genetic');
  const classic = perSub.filter(entry => entry.method !== 'genetic');

  return {
    multiStartEnabled: config.optimization.multiStart.enabled,
    configuredRuns: config.optimization.multiStart.enabled
      ? config.optimization.multiStart.runs
      : 1,
    configuredCoarseSeedCount: config.optimization.multiStart.coarseSeedCount,
    geneticSubCount: genetic.length,
    classicSubCount: classic.length,
    completedRuns: genetic.reduce((sum, entry) => sum + entry.runsCompleted, 0),
    savedRuns: genetic.reduce((sum, entry) => sum + entry.savedRuns, 0),
    perSub,
  };
}

export function buildAllPassReport({ config, optimizedSubs, comparativeAnalysis = [] }) {
  const perSub = optimizedSubs.map((sub, index) => ({
    name: sub.name,
    measurement: sub.measurement,
    used: sub.param?.allPass?.enabled === true,
    recommendation: comparativeAnalysis[index]?.recommended ?? 'not-evaluated',
    improvementPercentage: comparativeAnalysis[index]?.analysis ?? 'N/A',
  }));

  return {
    enabled: config.allPass.enabled,
    usedCount: perSub.filter(entry => entry.used).length,
    evaluatedCount: perSub.length,
    recommendedWithAllPassCount: perSub.filter(
      entry => entry.recommendation === 'with-allpass',
    ).length,
    perSub,
  };
}

export function logOptimizationReport(logger, report) {
  const format = value => (Number.isFinite(value) ? value.toFixed(2) : String(value));

  logger.info('Optimization report:');
  logger.info(
    ` - objective: ${report.objective}${
      report.objective === 'max-theoretical'
        ? ` (theoretical weight ${(report.theoreticalWeight * 100).toFixed(0)}%)`
        : ''
    }`,
  );
  logger.info(
    ` - baseline: quality ${format(report.baseline.qualityScore)}, efficiency ${format(
      report.baseline.efficiencyRatio,
    )}%, gap ${format(report.baseline.theoreticalGap)}%, P2P ${format(
      report.baseline.peakToPeakDb,
    )}dB`,
  );
  logger.info(
    ` - final: quality ${format(report.final.qualityScore)}, objective ${format(
      report.final.objectiveScore,
    )}, efficiency ${format(report.final.efficiencyRatio)}%, gap ${format(
      report.final.theoreticalGap,
    )}%, P2P ${format(report.final.peakToPeakDb)}dB`,
  );
  logger.info(
    ` - improvement: quality ${format(report.improvement.qualityScore)}, efficiency ${format(
      report.improvement.efficiencyRatio,
    )} pts, gap reduction ${format(
      report.improvement.theoreticalGapReduction,
    )} pts, P2P ${format(report.improvement.peakToPeakDb)}dB`,
  );
  logger.info(
    ` - global refinement: ${
      report.globalRefinement.enabled ? 'enabled' : 'disabled'
    }, improved ${report.globalRefinement.improvements} alignment(s), quality ${format(
      report.globalRefinement.delta.qualityScore,
    )}, efficiency ${format(report.globalRefinement.delta.efficiencyRatio)} pts`,
  );
  logger.info(
    ` - all-pass: ${report.allPass.usedCount}/${report.allPass.evaluatedCount} used`,
  );
  logger.info(
    ` - selection: ${report.audioSelection.decision}, score ${format(
      report.audioSelection.score,
    )}, implementation delay ${format(
      report.implementationCost.maxAbsDelayMs,
    )}ms max, gain ${format(report.implementationCost.maxAbsGainDb)}dB max`,
  );
  if (report.search.geneticSubCount > 0) {
    logger.info(
      ` - search: ${report.search.completedRuns} genetic run(s), ` +
        `${report.search.savedRuns} saved, ${report.search.configuredCoarseSeedCount} coarse seed(s)`,
    );
  } else {
    logger.info(' - search: classic exhaustive search');
  }
}
