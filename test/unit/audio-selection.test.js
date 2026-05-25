import { describe, expect, it } from 'vitest';
import { buildAudioSelectionReport } from '../../src/optimizer/audio-selection.js';

const baselineMetrics = {
  objectiveScore: 80,
  qualityScore: 80,
  efficiencyRatio: 80,
  theoreticalGap: 20,
  minMagnitude: 76,
  maxMagnitude: 84,
  peakToPeakDb: 8,
};

const finalMetricsWithQualityTradeoff = {
  objectiveScore: 88,
  qualityScore: 78,
  efficiencyRatio: 90,
  theoreticalGap: 10,
  minMagnitude: 76,
  maxMagnitude: 84.5,
  peakToPeakDb: 8.5,
};

const improvementWithQualityTradeoff = {
  objectiveScore: 8,
  qualityScore: -2,
  efficiencyRatio: 10,
  theoreticalGap: -10,
  theoreticalGapReduction: 10,
  peakToPeakDb: 0.5,
};

const noAllPass = {
  usedCount: 0,
  evaluatedCount: 2,
  recommendedWithAllPassCount: 0,
  perSub: [],
};

const simpleImplementationCost = {
  maxAbsDelayMs: 0,
  totalAbsDelayMs: 0,
  maxAbsGainDb: 0,
  totalAbsGainDb: 0,
  polarityFlipCount: 0,
  allPassCount: 0,
  adjustedSubCount: 0,
  perSub: [],
};

describe('audio selection guardrails', () => {
  it('flags max-theoretical results that trade away quality for efficiency', () => {
    const report = buildAudioSelectionReport({
      baselineMetrics,
      finalMetrics: finalMetricsWithQualityTradeoff,
      improvement: improvementWithQualityTradeoff,
      allPass: noAllPass,
      implementationCost: simpleImplementationCost,
      objective: 'max-theoretical',
    });

    expect(report.decision).toBe('review');
    expect(report.reasons).toEqual([]);
    expect(report.warnings).toContain(
      'Max-theoretical objective reduced audio quality and should be reviewed',
    );
    expect(report.guardrails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warn',
          code: 'max-theoretical-quality-tradeoff',
        }),
      ]),
    );
  });

  it('does not warn about the same quality trade-off in balanced mode', () => {
    const report = buildAudioSelectionReport({
      baselineMetrics,
      finalMetrics: finalMetricsWithQualityTradeoff,
      improvement: improvementWithQualityTradeoff,
      allPass: noAllPass,
      implementationCost: simpleImplementationCost,
      objective: 'balanced',
    });

    expect(report.decision).toBe('recommended');
    expect(report.guardrails).toEqual([]);
  });
});
