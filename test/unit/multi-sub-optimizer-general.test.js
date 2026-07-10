import { describe, it, expect, vi, beforeEach } from 'vitest';
import lm from '../mocks/logs.js';

vi.mock('../src/frequency-response-processor.js', () => ({
  default: {
    calculateMinimumPhase: response => {
      const magnitude = response?.magnitude ?? response;
      return new Float32Array(magnitude.length).fill(0);
    },
  },
}));

import MultiSubOptimizer from '../../src/multi-sub-optimizer.js';

// Helper: build a fake measurement object with the given frequency array
function makeMeasurement(freqs, { name = 'Sub', measurement = 'uuid-1' } = {}) {
  const len = freqs.length;
  return {
    freqs: Float32Array.from(freqs),
    magnitude: new Float32Array(len).fill(80), // flat 80 dB
    phase: new Float32Array(len).fill(0),
    name,
    measurement,
    freqStep: freqs.length > 1 ? freqs[1] - freqs[0] : 1,
    ppo: 48,
  };
}

/**
 * Directly exercise the binary search logic that lives inside prepareMeasurements()
 * by constructing a MultiSubOptimizer with controlled frequency arrays and checking
 * the resulting filtered frequency content.
 */
describe('prepareMeasurements – binary search for startIdx / endIdx', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Normal case: frequencies span outside the range on both sides ──
  it('filters to the correct inclusive range [min, max]', () => {
    // freqs: 5, 10, 15, 20, 25, ..., 195, 200, 205, 210
    const freqs = Array.from({ length: 42 }, (_, i) => 5 + i * 5);
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    const prepared = opt.preparedSubs[0];
    expect(prepared.freqs[0]).toBe(20);
    expect(prepared.freqs[prepared.freqs.length - 1]).toBe(200);
    // Every frequency should be within [20, 200]
    for (const f of prepared.freqs) {
      expect(f).toBeGreaterThanOrEqual(20);
      expect(f).toBeLessThanOrEqual(200);
    }
  });

  // ── All frequencies inside the range ──
  it('keeps all frequencies when all are inside the range', () => {
    const freqs = [30, 50, 80, 100, 150];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    expect(Array.from(opt.preparedSubs[0].freqs)).toEqual(freqs);
  });

  // ── No frequencies inside the range → empty after filter → should throw ──
  it('throws when no frequencies lie in the range', () => {
    const freqs = [5, 10, 15]; // all below min 20
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };

    expect(
      () =>
        new MultiSubOptimizer(
          [
            makeMeasurement(freqs, { measurement: 'a' }),
            makeMeasurement(freqs, { measurement: 'b' }),
          ],
          config,
          lm,
        ),
    ).toThrow(); // prepareMeasurements checks firstLen === 0
  });

  // ── All frequencies above the range → empty ──
  it('throws when all frequencies are above the range', () => {
    const freqs = [250, 300, 400];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };

    expect(
      () =>
        new MultiSubOptimizer(
          [
            makeMeasurement(freqs, { measurement: 'a' }),
            makeMeasurement(freqs, { measurement: 'b' }),
          ],
          config,
          lm,
        ),
    ).toThrow();
  });

  // ── Exact boundary values are included ──
  it('includes exact boundary frequencies (min and max)', () => {
    const freqs = [10, 20, 100, 200, 300];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    const filtered = Array.from(opt.preparedSubs[0].freqs);
    expect(filtered).toContain(20);
    expect(filtered).toContain(200);
    expect(filtered).not.toContain(10);
    expect(filtered).not.toContain(300);
  });

  // ── Single frequency equal to min ──
  it('handles single frequency equal to range min', () => {
    const freqs = [20];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    expect(Array.from(opt.preparedSubs[0].freqs)).toEqual([20]);
  });

  // ── Single frequency equal to max ──
  it('handles single frequency equal to range max', () => {
    const freqs = [200];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    expect(Array.from(opt.preparedSubs[0].freqs)).toEqual([200]);
  });

  // ── Single frequency outside the range ──
  it('throws for a single frequency outside the range', () => {
    const freqs = [10];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };

    expect(
      () =>
        new MultiSubOptimizer(
          [
            makeMeasurement(freqs, { measurement: 'a' }),
            makeMeasurement(freqs, { measurement: 'b' }),
          ],
          config,
          lm,
        ),
    ).toThrow();
  });

  // ── startIdx and endIdx correctness with dense data ──
  it('correctly identifies start and end indices with 1 Hz resolution', () => {
    // 1 Hz steps from 1 to 500
    const freqs = Array.from({ length: 500 }, (_, i) => i + 1);
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 50, max: 120 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    const filtered = Array.from(opt.preparedSubs[0].freqs);
    expect(filtered[0]).toBe(50);
    expect(filtered.at(-1)).toBe(120);
    expect(filtered.length).toBe(71); // 50..120 inclusive
  });

  // ── startFreq and endFreq properties ──
  it('sets startFreq and endFreq correctly on the prepared sub', () => {
    const freqs = [10, 20, 50, 100, 150, 200, 300];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    expect(opt.preparedSubs[0].startFreq).toBe(20);
    expect(opt.preparedSubs[0].endFreq).toBe(200);
  });

  // ── Magnitude and phase arrays sliced in sync with freqs ──
  it('slices magnitude and phase arrays consistently with freqs', () => {
    const freqs = [10, 30, 60, 100, 250];
    const magnitude = Float32Array.from([1, 2, 3, 4, 5]);
    const phase = Float32Array.from([10, 20, 30, 40, 50]);
    const sub = {
      freqs: Float32Array.from(freqs),
      magnitude,
      phase,
      name: 'Sub',
      measurement: 'a',
      freqStep: 1,
      ppo: 48,
    };
    const sub2 = { ...sub, measurement: 'b' };
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer([sub, sub2], config, lm);

    const p = opt.preparedSubs[0];
    // Expected filtered: indices 1,2,3 → freqs [30,60,100], mag [2,3,4], phase [20,30,40]
    expect(Array.from(p.freqs)).toEqual([30, 60, 100]);
    expect(Array.from(p.magnitude)).toEqual([2, 3, 4]);
    expect(Array.from(p.phase)).toEqual([20, 30, 40]);
  });

  // ── Narrow range containing a single frequency ──
  it('correctly filters a narrow range that matches one point', () => {
    const freqs = [10, 50, 100, 150, 200];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 100, max: 100 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    expect(Array.from(opt.preparedSubs[0].freqs)).toEqual([100]);
  });

  // ── Range sits between two consecutive frequency points ──
  it('returns empty (throws) when range falls between two frequency points', () => {
    const freqs = [10, 50, 200, 300];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 51, max: 199 },
    };

    expect(
      () =>
        new MultiSubOptimizer(
          [
            makeMeasurement(freqs, { measurement: 'a' }),
            makeMeasurement(freqs, { measurement: 'b' }),
          ],
          config,
          lm,
        ),
    ).toThrow();
  });

  // ── Floating-point frequencies ──
  it('handles floating-point frequencies correctly', () => {
    const freqs = [19.9, 20, 20.1, 99.9, 100, 100.1, 199.9, 200, 200.1];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    const filtered = Array.from(opt.preparedSubs[0].freqs);
    // 19.9 < 20 → excluded ; 200.1 > 200 → excluded
    expect(filtered[0]).toBeCloseTo(20);
    expect(filtered.at(-1)).toBeCloseTo(200);
    expect(filtered).not.toContain(19.9);
    expect(filtered.length).toBe(7); // 20, 20.1, 99.9, 100, 100.1, 199.9, 200
  });

  // ── Both subs get the same filtering ──
  it('applies the same binary search result to all subs', () => {
    const freqs = [5, 10, 20, 50, 100, 200, 300];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    const f0 = Array.from(opt.preparedSubs[0].freqs);
    const f1 = Array.from(opt.preparedSubs[1].freqs);
    expect(f0).toEqual(f1);
  });

  // ── Large array performance / correctness ──
  it('handles a large logarithmic frequency array', () => {
    // 1000 points logarithmically spaced from 1 Hz to 20 kHz
    const freqs = Array.from({ length: 1000 }, (_, i) =>
      Math.pow(10, 0 + (i / 999) * Math.log10(20000)),
    );
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    const filtered = opt.preparedSubs[0].freqs;
    expect(filtered[0]).toBeGreaterThanOrEqual(20);
    expect(filtered[filtered.length - 1]).toBeLessThanOrEqual(200);
    expect(filtered.length).toBeGreaterThan(0);
    // Check ordering preserved
    for (let i = 1; i < filtered.length; i++) {
      expect(filtered[i]).toBeGreaterThanOrEqual(filtered[i - 1]);
    }
  });

  // ── Param set to EMPTY_CONFIG ──
  it('assigns EMPTY_CONFIG param to each prepared sub', () => {
    const freqs = [20, 50, 100, 200];
    const config = {
      ...MultiSubOptimizer.DEFAULT_CONFIG,
      frequency: { min: 20, max: 200 },
    };
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a' }),
        makeMeasurement(freqs, { measurement: 'b' }),
      ],
      config,
      lm,
    );

    for (const sub of opt.preparedSubs) {
      expect(sub.param).toEqual(MultiSubOptimizer.EMPTY_CONFIG);
    }
  });
});

describe('MultiSubOptimizer guards and parameter handling', () => {
  const config = {
    ...MultiSubOptimizer.DEFAULT_CONFIG,
    frequency: { min: 20, max: 200 },
    gain: { min: -6, max: 6, step: 1 },
    delay: { min: -0.005, max: 0.005, step: 0.001 },
    allPass: { enabled: false },
  };

  function makeOptimizer(freqs = [20, 50, 100, 200]) {
    return new MultiSubOptimizer(
      [
        makeMeasurement(freqs, { measurement: 'a', name: 'Sub A' }),
        makeMeasurement(freqs, { measurement: 'b', name: 'Sub B' }),
      ],
      config,
      lm,
    );
  }

  it('merges nested defaults when config is partial', () => {
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement([20, 50, 100, 200], { measurement: 'a' }),
        makeMeasurement([20, 50, 100, 200], { measurement: 'b' }),
      ],
      { allPass: { enabled: false } },
      lm,
    );

    expect(opt.config.frequency).toEqual(MultiSubOptimizer.DEFAULT_CONFIG.frequency);
    expect(opt.config.delay).toEqual(MultiSubOptimizer.DEFAULT_CONFIG.delay);
    expect(opt.config.allPass.frequency).toEqual(
      MultiSubOptimizer.DEFAULT_CONFIG.allPass.frequency,
    );
    expect(opt.config.allPass.q).toEqual(MultiSubOptimizer.DEFAULT_CONFIG.allPass.q);
    expect(opt.config.optimization).toEqual(
      MultiSubOptimizer.DEFAULT_CONFIG.optimization,
    );
  });

  it('rejects invalid optimization objectives', () => {
    expect(
      () =>
        new MultiSubOptimizer(
          [
            makeMeasurement([20, 50, 100, 200], { measurement: 'a' }),
            makeMeasurement([20, 50, 100, 200], { measurement: 'b' }),
          ],
          { ...config, optimization: { objective: 'loudest' } },
          lm,
        ),
    ).toThrow(/Invalid optimization objective/);
  });

  it('uses an efficiency-heavy blend for max-theoretical objective scoring', () => {
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement([20, 50, 100, 200], { measurement: 'a' }),
        makeMeasurement([20, 50, 100, 200], { measurement: 'b' }),
      ],
      {
        ...config,
        optimization: { objective: 'max-theoretical', theoreticalWeight: 0.75 },
      },
      lm,
    );
    vi.spyOn(opt, 'calculateQualityScore').mockReturnValue(40);
    vi.spyOn(opt, 'calculateEfficiencyRatio').mockReturnValue(80);

    expect(opt.calculateOptimizationScore({}, {})).toBeCloseTo(70, 5);
  });

  it('updates optimized sub parameters when global refinement finds an improvement', () => {
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement([20, 50, 100, 200], { measurement: 'a', name: 'Sub A' }),
        makeMeasurement([20, 50, 100, 200], { measurement: 'b', name: 'Sub B' }),
      ],
      {
        ...config,
        optimization: {
          globalRefinement: { enabled: true, passes: 1, maxIterations: 3 },
        },
      },
      lm,
    );
    const improvedParam = {
      delay: 0.001,
      gain: 0,
      polarity: -1,
      allPass: { frequency: 0, q: 0, enabled: false },
    };
    opt.optimizedSubs = [opt.preparedSubs[1]];
    opt.preparedSubs[1].param = MultiSubOptimizer.EMPTY_CONFIG;
    vi.spyOn(opt, 'localSearch').mockReturnValue({ score: 999, param: improvedParam });

    // The global refinement guard calls scoreOptimizedSubSum →
    // calculateOptimizationScoreDetails → calculateQualityScore to validate
    // that the global score actually improves. Mock calculateQualityScore so
    // the guard accepts the mocked localSearch improvement.
    let qualityScoreCallCount = 0;
    vi.spyOn(opt, 'calculateQualityScore').mockImplementation(() => {
      qualityScoreCallCount++;
      // First call is the baseline; subsequent calls return a higher score
      // so the guard accepts the refinement.
      return qualityScoreCallCount === 1 ? 50 : 100;
    });

    const refined = opt.refineOptimizedSubsGlobally(opt.preparedSubs, {
      optimizedSubs: opt.optimizedSubs,
      bestSum: opt.calculateCombinedResponse(opt.preparedSubs),
      comparativeAnalysis: [],
    });

    // Global refinement optimizes subs 1..N-1 (not sub 0, the reference).
    // With 2 subs, only Sub B is refined, so 1 improvement is expected.
    expect(opt.optimizedSubs[0].param).toEqual(improvedParam);
    expect(refined.globalRefinement).toEqual({ enabled: true, improvements: 1 });
  });

  it('returns a post-optimization report with global metrics', () => {
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement([20, 50, 100, 200], { measurement: 'a', name: 'Sub A' }),
        makeMeasurement([20, 50, 100, 200], { measurement: 'b', name: 'Sub B' }),
      ],
      {
        ...config,
        gain: { min: 0, max: 0, step: 1 },
        delay: { min: 0, max: 0, step: 0.001 },
      },
      lm,
    );

    const result = opt.optimizeSubwoofers();
    const report = result.optimizationReport;

    expect(report).toMatchObject({
      objective: 'balanced',
      subwooferCount: 2,
      globalRefinement: { enabled: false, improvements: 0 },
      allPass: { enabled: false, usedCount: 0, evaluatedCount: 1 },
      audioSelection: { decision: 'recommended' },
      search: { classicSubCount: 1, geneticSubCount: 0, completedRuns: 0, savedRuns: 0 },
    });
    expect(Number.isFinite(report.baseline.qualityScore)).toBe(true);
    expect(Number.isFinite(report.final.qualityScore)).toBe(true);
    expect(Number.isFinite(report.final.efficiencyRatio)).toBe(true);
    expect(report.final.theoreticalGap).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(report.improvement.theoreticalGapReduction)).toBe(true);
    expect(Number.isFinite(report.audioSelection.score)).toBe(true);
    expect(report.audioSelection.guardrails).toEqual([]);
    expect(report.implementationCost).toMatchObject({
      maxAbsDelayMs: 0,
      totalAbsDelayMs: 0,
      maxAbsGainDb: 0,
      totalAbsGainDb: 0,
      polarityFlipCount: 0,
      allPassCount: 0,
    });
    expect(report.implementationCost.perSub).toHaveLength(2);
    expect(report.search.perSub).toHaveLength(1);
    expect(report.search.perSub[0].method).toBe('classic');
  });

  it('prefers recommended audio candidates over review and rejected reports', () => {
    const rejectedHighScore = {
      optimizationReport: {
        audioSelection: { decision: 'rejected', score: 100 },
        final: { qualityScore: 95, efficiencyRatio: 98, peakToPeakDb: 4 },
        implementationCost: { allPassCount: 0, totalAbsDelayMs: 1 },
      },
    };
    const reviewCandidate = {
      optimizationReport: {
        audioSelection: { decision: 'review', score: 74 },
        final: { qualityScore: 77, efficiencyRatio: 90, peakToPeakDb: 7 },
        implementationCost: { allPassCount: 1, totalAbsDelayMs: 4 },
      },
    };
    const recommendedCandidate = {
      optimizationReport: {
        audioSelection: { decision: 'recommended', score: 72 },
        final: { qualityScore: 82, efficiencyRatio: 88, peakToPeakDb: 6 },
        implementationCost: { allPassCount: 0, totalAbsDelayMs: 2 },
      },
    };

    const selected = MultiSubOptimizer.selectBestAudioCandidate([
      rejectedHighScore,
      recommendedCandidate,
      reviewCandidate,
    ]);

    expect(selected.index).toBe(1);
    expect(selected.candidate).toBe(recommendedCandidate);
  });

  it('merges multi-start defaults and accepts boolean shorthand', () => {
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement([20, 50, 100, 200], { measurement: 'a' }),
        makeMeasurement([20, 50, 100, 200], { measurement: 'b' }),
      ],
      { optimization: { multiStart: true } },
      lm,
    );

    expect(opt.config.optimization.multiStart).toEqual({
      ...MultiSubOptimizer.DEFAULT_CONFIG.optimization.multiStart,
      enabled: true,
    });
  });

  it('stops genetic multi-start when an extra run does not improve enough', () => {
    const opt = makeOptimizer();
    const runResult = {
      bestWithAllPass: { score: -Infinity },
      bestWithoutAllPass: {
        score: 10,
        param: MultiSubOptimizer.EMPTY_CONFIG,
        hasAllPass: false,
      },
    };

    vi.spyOn(opt, 'findTopCoarseParams').mockReturnValue([
      MultiSubOptimizer.EMPTY_CONFIG,
      { delay: 0.001, gain: 0, polarity: 1, allPass: { enabled: false } },
    ]);
    const runSpy = vi.spyOn(opt, '_runSingleGeneticRun').mockReturnValue(runResult);

    const result = opt.runGeneticOptimization(
      opt.preparedSubs[1],
      opt.preparedSubs[0],
      {},
      [MultiSubOptimizer.EMPTY_CONFIG],
      {
        runs: 3,
        useLocalSearch: false,
        populationSize: 5,
        eliteCount: 1,
        tournamentSize: 1,
        generations: 1,
        maxNoImprovementGenerations: 1,
        mutationRate: 0,
        mutationAmount: 0,
        withAllPassProbability: 0,
        coarseSeedCount: 2,
        minRunImprovement: 0.5,
      },
    );

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(result.stats).toMatchObject({
      runsRequested: 3,
      runsCompleted: 2,
      savedRuns: 1,
      coarseSeedCount: 2,
      minRunImprovement: 0.5,
    });
  });

  it('keeps diverse coarse seeds instead of only adjacent top scores', () => {
    const opt = new MultiSubOptimizer(
      [
        makeMeasurement([20, 50, 100, 200], { measurement: 'a', name: 'Sub A' }),
        makeMeasurement([20, 50, 100, 200], { measurement: 'b', name: 'Sub B' }),
      ],
      {
        ...config,
        allPass: {
          enabled: true,
          frequency: { min: 20, max: 120, step: 10 },
          q: { min: 0.1, max: 0.5, step: 0.1 },
        },
      },
      lm,
    );
    const params = [
      { delay: 0, gain: 0, polarity: 1, allPass: { enabled: false } },
      { delay: 0.0001, gain: 0, polarity: 1, allPass: { enabled: false } },
      { delay: 0.0002, gain: 0, polarity: 1, allPass: { enabled: false } },
      {
        delay: -0.003,
        gain: 0,
        polarity: -1,
        allPass: { frequency: 80, q: 0.2, enabled: true },
      },
    ];

    vi.spyOn(opt, 'evaluateParameters').mockImplementation(sub => ({
      score: sub.param.allPass.enabled ? 80 : 100 - sub.param.delay * 1000,
      param: sub.param,
      hasAllPass: sub.param.allPass.enabled,
    }));

    const seeds = opt.findTopCoarseParams(
      opt.preparedSubs[1],
      opt.preparedSubs[0],
      {},
      params,
      3,
    );

    expect(seeds).toHaveLength(3);
    expect(seeds.some(param => param.allPass.enabled)).toBe(true);
    expect(seeds.some(param => !param.allPass.enabled)).toBe(true);
    expect(seeds[0]).toMatchObject({ delay: 0, allPass: { enabled: false } });
  });

  it('rejects unsorted frequency arrays before binary-search filtering', () => {
    const freqs = [20, 100, 50, 200];

    expect(
      () =>
        new MultiSubOptimizer(
          [
            makeMeasurement(freqs, { measurement: 'a' }),
            makeMeasurement(freqs, { measurement: 'b' }),
          ],
          config,
          lm,
        ),
    ).toThrow(/strictly increasing/);
  });

  it('calculates combined responses without freqStep or ppo metadata', () => {
    const subA = makeMeasurement([20, 50, 100, 200], { measurement: 'a' });
    const subB = makeMeasurement([20, 50, 100, 200], { measurement: 'b' });
    delete subA.freqStep;
    delete subA.ppo;
    delete subB.freqStep;
    delete subB.ppo;

    const opt = new MultiSubOptimizer([subA, subB], config, lm);
    const combined = opt.calculateCombinedResponse(opt.preparedSubs);

    expect(combined.magnitude).toHaveLength(4);
    expect(combined.freqStep).toBeUndefined();
    expect(combined.ppo).toBeUndefined();
  });

  it('rejects direct combined responses with mismatched frequencies', () => {
    const opt = makeOptimizer();
    const subA = makeMeasurement([20, 50, 100, 200], { measurement: 'x' });
    const subB = makeMeasurement([20, 50, 110, 200], { measurement: 'y' });

    expect(() => opt.calculateCombinedResponse([subA, subB])).toThrow(
      /different frequency point/,
    );
  });

  it('uses EMPTY_CONFIG defaults when response parameters are missing', () => {
    const opt = makeOptimizer();
    const sub = { ...opt.preparedSubs[0], param: undefined };
    const response = opt.calculateResponseWithParams(sub);

    for (let i = 0; i < sub.freqs.length; i++) {
      expect(response.magnitude[i]).toBeCloseTo(sub.magnitude[i], 5);
      expect(response.phase[i]).toBeCloseTo(sub.phase[i], 5);
      expect(Number.isFinite(response.magnitude[i])).toBe(true);
      expect(Number.isFinite(response.phase[i])).toBe(true);
    }
  });

  it('applies gain as a dB offset when calculating a parameterized response', () => {
    const opt = makeOptimizer();
    const sub = {
      ...opt.preparedSubs[0],
      param: {
        delay: 0,
        gain: 6,
        polarity: 1,
        allPass: { frequency: 0, q: 0, enabled: false },
      },
    };

    const response = opt.calculateResponseWithParams(sub);

    for (let i = 0; i < sub.freqs.length; i++) {
      expect(response.magnitude[i]).toBeCloseTo(sub.magnitude[i] + 6, 5);
    }
  });

  it('does not reuse cached evaluations across different response contexts', () => {
    const opt = makeOptimizer();
    const subToOptimize = opt.preparedSubs[1];
    const previousValidSum = opt.preparedSubs[0];
    const theoreticalMax = opt.calculateCombinedResponse(
      [subToOptimize, previousValidSum],
      false,
      true,
    );

    subToOptimize.param = MultiSubOptimizer.EMPTY_CONFIG;
    opt.evaluateParametersCached(subToOptimize, previousValidSum, theoreticalMax);

    const shiftedPreviousSum = {
      ...previousValidSum,
      magnitude: Float32Array.from(previousValidSum.magnitude, value => value + 3),
    };

    opt.evaluateParametersCached(subToOptimize, shiftedPreviousSum, theoreticalMax);

    expect(opt._cacheMisses).toBe(2);
  });

  it('does not reuse cached evaluations when only middle response samples differ', () => {
    const opt = makeOptimizer([20, 50, 100, 150, 200]);
    const subToOptimize = opt.preparedSubs[1];
    const previousValidSum = opt.preparedSubs[0];
    const theoreticalMax = opt.calculateCombinedResponse(
      [subToOptimize, previousValidSum],
      false,
      true,
    );

    subToOptimize.param = MultiSubOptimizer.EMPTY_CONFIG;
    opt.evaluateParametersCached(subToOptimize, previousValidSum, theoreticalMax);

    const middleShiftedPreviousSum = {
      ...previousValidSum,
      magnitude: Float32Array.from(previousValidSum.magnitude, (value, index) =>
        index === 2 ? value + 3 : value,
      ),
    };

    opt.evaluateParametersCached(subToOptimize, middleShiftedPreviousSum, theoreticalMax);

    expect(opt._cacheMisses).toBe(2);
  });

  it('reuses cached evaluations when only response score metadata changes', () => {
    const opt = makeOptimizer();
    const subToOptimize = opt.preparedSubs[1];
    const previousValidSum = opt.preparedSubs[0];
    const theoreticalMax = opt.calculateCombinedResponse(
      [subToOptimize, previousValidSum],
      false,
      true,
    );

    subToOptimize.param = MultiSubOptimizer.EMPTY_CONFIG;
    opt.evaluateParametersCached(
      subToOptimize,
      { ...previousValidSum, score: 1 },
      theoreticalMax,
    );
    opt.evaluateParametersCached(
      subToOptimize,
      { ...previousValidSum, score: 999 },
      theoreticalMax,
    );

    expect(opt._cacheMisses).toBe(1);
    expect(opt._cacheHits).toBe(1);
  });

  it('keeps the non-all-pass solution when a negative all-pass score is worse', () => {
    const opt = makeOptimizer();
    const bestWithAllPass = { score: -10.1, hasAllPass: true };
    const bestWithoutAllPass = { score: -10, hasAllPass: false };

    expect(opt.chooseBestSolution(bestWithAllPass, bestWithoutAllPass)).toBe(
      bestWithoutAllPass,
    );
  });
});
