export const AUDIO_SELECTION = Object.freeze({
  weights: Object.freeze({
    quality: 0.45,
    efficiency: 0.25,
    gapReduction: 0.15,
    peakToPeakPenalty: 1.2,
    maxDelayPenalty: 0.08,
    totalDelayPenalty: 0.02,
    maxGainPenalty: 0.2,
    totalGainPenalty: 0.03,
    polarityPenalty: 0.5,
    allPassPenalty: 0.8,
  }),
  thresholds: Object.freeze({
    maxQualityRegression: 3,
    maxPeakToPeakRegressionDb: 2,
    maxGapRegression: 0.5,
    marginalAllPassQualityGain: 2,
    marginalAllPassGapReduction: 2,
    ineffectiveAllPassQualityGain: 0.5,
    ineffectiveAllPassGapReduction: 0.5,
    maxTheoreticalQualityWarning: 1.5,
  }),
});

export function selectBestAudioCandidate(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('At least one candidate report is required');
  }

  const evaluated = candidates.map((candidate, index) => {
    const report = candidate?.optimizationReport ?? candidate?.report ?? candidate;
    if (!report?.audioSelection || !Number.isFinite(report.audioSelection.score)) {
      throw new Error('Candidate report is missing audioSelection score');
    }

    return {
      candidate,
      index,
      report,
      accepted: report.audioSelection.decision !== 'rejected',
      score: report.audioSelection.score,
    };
  });

  const recommended = evaluated.filter(
    entry => entry.report.audioSelection.decision === 'recommended',
  );
  const review = evaluated.filter(
    entry => entry.report.audioSelection.decision === 'review',
  );
  let pool = evaluated;
  if (recommended.length > 0) pool = recommended;
  else if (review.length > 0) pool = review;

  const sortedPool = [...pool];
  sortedPool.sort(compareAudioCandidates);
  return sortedPool[0];
}

export function compareAudioCandidates(a, b) {
  const compareDescending = (left, right) => (right ?? -Infinity) - (left ?? -Infinity);
  const compareAscending = (left, right) => (left ?? Infinity) - (right ?? Infinity);

  return (
    compareDescending(a.score, b.score) ||
    compareDescending(a.report.final?.qualityScore, b.report.final?.qualityScore) ||
    compareDescending(a.report.final?.efficiencyRatio, b.report.final?.efficiencyRatio) ||
    compareAscending(a.report.final?.peakToPeakDb, b.report.final?.peakToPeakDb) ||
    compareAscending(
      a.report.implementationCost?.allPassCount,
      b.report.implementationCost?.allPassCount,
    ) ||
    compareAscending(
      a.report.implementationCost?.totalAbsDelayMs,
      b.report.implementationCost?.totalAbsDelayMs,
    )
  );
}

function getAudioSelectionDecision(rejectionReasons, warnings) {
  if (rejectionReasons.length > 0) return 'rejected';
  if (warnings.length > 0) return 'review';
  return 'recommended';
}

export function buildAudioSelectionReport({
  baselineMetrics,
  finalMetrics,
  improvement,
  allPass,
  implementationCost,
  objective = 'balanced',
}) {
  const score = calculateAudioSelectionScore({
    finalMetrics,
    improvement,
    implementationCost,
  });
  const guardrails = evaluateAudioSelectionGuardrails({
    baselineMetrics,
    finalMetrics,
    improvement,
    allPass,
    objective,
  });
  const rejectionReasons = guardrails.filter(entry => entry.severity === 'reject');
  const warnings = guardrails.filter(entry => entry.severity === 'warn');

  return {
    score,
    decision: getAudioSelectionDecision(rejectionReasons, warnings),
    reasons: rejectionReasons.map(entry => entry.message),
    warnings: warnings.map(entry => entry.message),
    guardrails,
    weights: AUDIO_SELECTION.weights,
    thresholds: AUDIO_SELECTION.thresholds,
  };
}

export function calculateAudioSelectionScore({
  finalMetrics,
  improvement,
  implementationCost,
}) {
  const weights = AUDIO_SELECTION.weights;
  const gapReduction = Math.max(-20, Math.min(20, improvement.theoreticalGapReduction));
  const implementationPenalty =
    implementationCost.maxAbsDelayMs * weights.maxDelayPenalty +
    implementationCost.totalAbsDelayMs * weights.totalDelayPenalty +
    implementationCost.maxAbsGainDb * weights.maxGainPenalty +
    implementationCost.totalAbsGainDb * weights.totalGainPenalty +
    implementationCost.polarityFlipCount * weights.polarityPenalty +
    implementationCost.allPassCount * weights.allPassPenalty;

  return (
    finalMetrics.qualityScore * weights.quality +
    finalMetrics.efficiencyRatio * weights.efficiency +
    gapReduction * weights.gapReduction -
    finalMetrics.peakToPeakDb * weights.peakToPeakPenalty -
    implementationPenalty
  );
}

export function evaluateAudioSelectionGuardrails({
  baselineMetrics,
  finalMetrics,
  improvement,
  allPass,
  objective = 'balanced',
}) {
  const thresholds = AUDIO_SELECTION.thresholds;
  const guardrails = [];

  for (const [metricName, metricValue] of Object.entries(finalMetrics)) {
    if (!Number.isFinite(metricValue)) {
      guardrails.push({
        severity: 'reject',
        code: 'invalid-final-metric',
        message: `Final ${metricName} is not finite`,
      });
    }
  }

  if (
    finalMetrics.qualityScore <
    baselineMetrics.qualityScore - thresholds.maxQualityRegression
  ) {
    guardrails.push({
      severity: 'reject',
      code: 'quality-regression',
      message: 'Final quality regresses beyond the accepted audio threshold',
    });
  }

  if (improvement.theoreticalGapReduction < -thresholds.maxGapRegression) {
    guardrails.push({
      severity: 'reject',
      code: 'theoretical-gap-regression',
      message: 'Final response moves farther away from the theoretical maximum',
    });
  }

  if (improvement.peakToPeakDb > thresholds.maxPeakToPeakRegressionDb) {
    guardrails.push({
      severity: 'reject',
      code: 'peak-to-peak-regression',
      message: 'Final response is materially less even than baseline',
    });
  }

  if (
    allPass.usedCount > 0 &&
    improvement.qualityScore < thresholds.ineffectiveAllPassQualityGain &&
    improvement.theoreticalGapReduction < thresholds.ineffectiveAllPassGapReduction
  ) {
    guardrails.push({
      severity: 'reject',
      code: 'ineffective-all-pass',
      message: 'All-pass is used without meaningful audio improvement',
    });
  } else if (
    allPass.usedCount > 0 &&
    improvement.qualityScore < thresholds.marginalAllPassQualityGain &&
    improvement.theoreticalGapReduction < thresholds.marginalAllPassGapReduction
  ) {
    guardrails.push({
      severity: 'warn',
      code: 'marginal-all-pass',
      message: 'All-pass improvement is marginal and should be reviewed',
    });
  }

  if (
    objective === 'max-theoretical' &&
    improvement.qualityScore < -thresholds.maxTheoreticalQualityWarning
  ) {
    guardrails.push({
      severity: 'warn',
      code: 'max-theoretical-quality-tradeoff',
      message: 'Max-theoretical objective reduced audio quality and should be reviewed',
    });
  }

  return guardrails;
}
