export function calculateReportMetrics(
  response,
  theoreticalMax,
  { calculateOptimizationScoreDetails, calculateEfficiencyRatio },
) {
  const scoreDetails = calculateOptimizationScoreDetails(response, theoreticalMax);
  const efficiencyRatio = calculateEfficiencyRatio(response, theoreticalMax);
  const magnitudeStats = calculateMagnitudeStats(response.magnitude);

  return {
    objectiveScore: scoreDetails.score,
    qualityScore: scoreDetails.qualityScore,
    efficiencyRatio,
    theoreticalGap: Math.max(0, 100 - efficiencyRatio),
    ...magnitudeStats,
  };
}

export function calculateMetricDelta(before, after) {
  return {
    objectiveScore: after.objectiveScore - before.objectiveScore,
    qualityScore: after.qualityScore - before.qualityScore,
    efficiencyRatio: after.efficiencyRatio - before.efficiencyRatio,
    theoreticalGap: after.theoreticalGap - before.theoreticalGap,
    theoreticalGapReduction: before.theoreticalGap - after.theoreticalGap,
    peakToPeakDb: after.peakToPeakDb - before.peakToPeakDb,
  };
}

export function calculateMagnitudeStats(magnitude) {
  let minMagnitude = Infinity;
  let maxMagnitude = -Infinity;

  for (const value of magnitude) {
    minMagnitude = Math.min(minMagnitude, value);
    maxMagnitude = Math.max(maxMagnitude, value);
  }

  return {
    minMagnitude,
    maxMagnitude,
    peakToPeakDb: maxMagnitude - minMagnitude,
  };
}

export function calculateImplementationCost(preparedSubs, normalizeParam) {
  const perSub = preparedSubs.map(sub => {
    const param = normalizeParam(sub.param);
    const delayMs = param.delay * 1000;
    const allPassEnabled = param.allPass.enabled === true;
    const adjusted =
      Math.abs(delayMs) > 1e-6 ||
      Math.abs(param.gain) > 1e-6 ||
      param.polarity === -1 ||
      allPassEnabled;

    return {
      name: sub.name,
      measurement: sub.measurement,
      delayMs,
      absDelayMs: Math.abs(delayMs),
      gainDb: param.gain,
      absGainDb: Math.abs(param.gain),
      polarity: param.polarity,
      polarityFlipped: param.polarity === -1,
      allPassEnabled,
      allPassFrequency: allPassEnabled ? param.allPass.frequency : 0,
      allPassQ: allPassEnabled ? param.allPass.q : 0,
      adjusted,
    };
  });

  return {
    maxAbsDelayMs: Math.max(0, ...perSub.map(entry => entry.absDelayMs)),
    totalAbsDelayMs: perSub.reduce((sum, entry) => sum + entry.absDelayMs, 0),
    maxAbsGainDb: Math.max(0, ...perSub.map(entry => entry.absGainDb)),
    totalAbsGainDb: perSub.reduce((sum, entry) => sum + entry.absGainDb, 0),
    polarityFlipCount: perSub.filter(entry => entry.polarityFlipped).length,
    allPassCount: perSub.filter(entry => entry.allPassEnabled).length,
    adjustedSubCount: perSub.filter(entry => entry.adjusted).length,
    perSub,
  };
}
