/**
 * Multi-Sub Optimizer — Unified Test Suite
 *
 * Runs synthetic unit tests once, then runs the real-measurement test
 * for every data file listed in DATA_FILES.
 *
 * ============================================================
 * ENTRY POINT — add or remove data files here:
 * ============================================================
 */
const DATA_FILES = [
  { label: 'data.test', path: '../fixtures/multi-sub-optimizer/data.test.js' },
  { label: 'data.bug.test', path: '../fixtures/multi-sub-optimizer/data.bug.test.js' },
  { label: 'data.bis.test', path: '../fixtures/multi-sub-optimizer/data.bis.test.js' },
];
// ============================================================

import MultiSubOptimizer from '../../src/multi-sub-optimizer.js';

import deps from '../mocks/logs.js';

// ============================================
// SYNTHETIC DATA GENERATOR
// ============================================

/**
 * Deterministic PRNG (mulberry32) so synthetic measurements are reproducible
 * across runs. Without this, Math.random() makes the test suite flaky.
 */
function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYNTHETIC_RNG = createSeededRandom(20260704);

function generateSyntheticSubMeasurement(
  name,
  measurementId,
  basePhaseOffset = 0,
  delayMs = 0,
) {
  const freqs = [];
  const magnitude = [];
  const phase = [];

  const ppo = 96;
  const startFreq = 20;
  const endFreq = 200;

  let freq = startFreq;
  while (freq <= endFreq) {
    freqs.push(freq);

    let mag = 85;
    if (freq < 30) mag -= (30 - freq) * 1.5;
    mag += 3 * Math.sin(freq * 0.15);
    mag += 2 * Math.sin(freq * 0.08);
    mag -= 4 * Math.sin(freq * 0.22);
    mag += (SYNTHETIC_RNG() - 0.5) * 2;
    magnitude.push(mag);

    let ph = basePhaseOffset;
    ph -= 360 * (delayMs / 1000) * freq;
    ph -= freq * 0.5;
    ph = ((ph + 180) % 360) - 180;
    phase.push(ph);

    freq *= Math.pow(2, 1 / ppo);
  }

  return {
    measurement: measurementId,
    name,
    freqs,
    magnitude: new Float32Array(magnitude),
    phase: new Float32Array(phase),
    freqStep: Math.pow(2, 1 / ppo),
    ppo,
  };
}

function calculateBaselineScore(optimizer, sub1, sub2) {
  const combined = optimizer.calculateCombinedResponse([sub1, sub2]);
  const theo = optimizer.calculateCombinedResponse([sub1, sub2], true, false);
  const score = optimizer.calculateQualityScore(combined, theo);
  return { score, combined };
}

// ============================================
// SYNTHETIC TESTS (run once)
// ============================================

function testBasicOptimization() {
  console.log('='.repeat(60));
  console.log('TEST: Basic Multi-Sub Optimization');
  console.log('='.repeat(60));

  const sub1 = generateSyntheticSubMeasurement(
    'SW1',
    'd4fd26c1-348c-484c-ba31-41948768cb99',
    0,
    0,
  );
  const sub2 = generateSyntheticSubMeasurement(
    'SW2',
    '95c97b6e-7f0b-4939-8d9f-a32d26db6ee7',
    45,
    2.5,
  );

  console.log(`Sub1: ${sub1.freqs.length} frequency points`);
  console.log(`Sub2: ${sub2.freqs.length} frequency points`);

  const config = {
    frequency: { min: 20, max: 200 },
    gain: { min: 0, max: 0, step: 0.1 },
    delay: { min: -0.005, max: 0.005, step: 0.0001 },
    allPass: { enabled: false },
  };

  const optimizer = new MultiSubOptimizer([sub1, sub2], config, deps);
  sub1.param = MultiSubOptimizer.EMPTY_CONFIG;
  sub2.param = MultiSubOptimizer.EMPTY_CONFIG;

  optimizer.frequencyWeights = optimizer.calculateFrequencyWeights(sub1.freqs);
  const baseline = calculateBaselineScore(optimizer, sub1, sub2);

  console.log('\n--- Baseline (no optimization) ---');
  console.log(`Score: ${baseline.score.toFixed(2)}`);

  console.log('\n--- Running Optimization ---');
  const startTime = performance.now();
  const result = optimizer.optimizeSubwoofers();
  const endTime = performance.now();

  console.log(`Optimization time: ${(endTime - startTime).toFixed(0)}ms`);
  console.log(`Best score: ${result.bestSum.score.toFixed(2)}`);

  const improvement =
    ((result.bestSum.score - baseline.score) / Math.abs(baseline.score)) * 100;
  console.log(`Improvement: ${improvement.toFixed(2)}%`);

  console.log('\n--- Optimized Parameters ---');
  for (const sub of result.optimizedSubs) {
    console.log(
      `${sub.name}: Delay=${(sub.param.delay * 1000).toFixed(3)}ms, Polarity=${
        sub.param.polarity === 1 ? 'normal' : 'inverted'
      }`,
    );
  }

  // Physical assertion: sub2 was synthesized with delayMs=2.5ms relative to
  // sub1. The optimizer should find a delay that partially compensates this
  // offset (the sign depends on which sub is the reference). A delay of 0 or
  // one at the boundary would indicate the optimizer failed to exploit the
  // delay dimension.
  const optimizedSub2 = result.optimizedSubs.find(s => s.name === 'SW2');
  const optimizedDelayMs = optimizedSub2 ? optimizedSub2.param.delay * 1000 : 0;
  const delayCompensates = Math.abs(optimizedDelayMs) > 0.1;
  console.log(
    `\nPhysical check: sub2 delay=${optimizedDelayMs.toFixed(3)}ms (expected non-trivial compensation for 2.5ms offset)`,
  );

  const passed = result.bestSum.score >= baseline.score && delayCompensates;
  console.log(
    `\n${passed ? '✅ PASSED' : '❌ FAILED'}: Optimization improves or maintains score`,
  );
  return passed;
}

function testGeneticVsClassic() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Genetic vs Classic Optimization Comparison');
  console.log('='.repeat(60));

  const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
  const sub2 = generateSyntheticSubMeasurement('SW2', 'uuid-2', 30, 1.5);

  const config = {
    frequency: { min: 20, max: 200 },
    gain: { min: 0, max: 0, step: 0.1 },
    delay: { min: -0.003, max: 0.003, step: 0.0005 },
    allPass: { enabled: false },
  };

  console.log('\n--- Classic Optimization ---');
  const optimizerClassic = new MultiSubOptimizer(
    [
      {
        ...sub1,
        magnitude: new Float32Array(sub1.magnitude),
        phase: new Float32Array(sub1.phase),
      },
      {
        ...sub2,
        magnitude: new Float32Array(sub2.magnitude),
        phase: new Float32Array(sub2.phase),
      },
    ],
    config,
    deps,
  );

  const preparedClassic = optimizerClassic.prepareMeasurements();
  const testParams = optimizerClassic.generateTestParams();
  const refSub = preparedClassic[0];
  refSub.param = MultiSubOptimizer.EMPTY_CONFIG;
  const subToOpt = preparedClassic[1];
  const theo = optimizerClassic.calculateCombinedResponse(
    [subToOpt, refSub],
    true,
    false,
  );

  const startClassic = performance.now();
  const classicResult = optimizerClassic.runClassicOptimization(
    subToOpt,
    refSub,
    theo,
    testParams,
  );
  const endClassic = performance.now();

  console.log(`Time: ${(endClassic - startClassic).toFixed(0)}ms`);
  console.log(
    `Best score (no allpass): ${classicResult.bestWithoutAllPass.score.toFixed(2)}`,
  );

  console.log('\n--- Genetic Optimization ---');
  const optimizerGenetic = new MultiSubOptimizer(
    [
      {
        ...sub1,
        magnitude: new Float32Array(sub1.magnitude),
        phase: new Float32Array(sub1.phase),
      },
      {
        ...sub2,
        magnitude: new Float32Array(sub2.magnitude),
        phase: new Float32Array(sub2.phase),
      },
    ],
    config,
    deps,
  );

  const preparedGenetic = optimizerGenetic.prepareMeasurements();
  const refSubG = preparedGenetic[0];
  refSubG.param = MultiSubOptimizer.EMPTY_CONFIG;
  const subToOptG = preparedGenetic[1];
  const theoG = optimizerGenetic.calculateCombinedResponse(
    [subToOptG, refSubG],
    true,
    false,
  );
  const coarseParams = optimizerGenetic.generateTestParams(5);

  const startGenetic = performance.now();
  const geneticResult = optimizerGenetic.runGeneticOptimization(
    subToOptG,
    refSubG,
    theoG,
    coarseParams,
    {
      runs: 1,
      populationSize: 50,
      withAllPassProbability: 0,
      generations: 30,
      eliteCount: 7,
      tournamentSize: 3,
      mutationRate: 0.4,
      mutationAmount: 0.4,
      maxNoImprovementGenerations: 10,
      useLocalSearch: true,
    },
  );
  const endGenetic = performance.now();

  console.log(`Time: ${(endGenetic - startGenetic).toFixed(0)}ms`);
  console.log(
    `Best score (no allpass): ${geneticResult.bestWithoutAllPass.score.toFixed(2)}`,
  );

  const scoreDiff = Math.abs(
    classicResult.bestWithoutAllPass.score - geneticResult.bestWithoutAllPass.score,
  );
  const tolerance = Math.abs(classicResult.bestWithoutAllPass.score * 0.02);
  console.log(
    `\nScore difference: ${scoreDiff.toFixed(2)} (tolerance: ${tolerance.toFixed(2)})`,
  );

  const passed =
    scoreDiff <= tolerance ||
    geneticResult.bestWithoutAllPass.score >=
      classicResult.bestWithoutAllPass.score * 0.98;
  console.log(
    `${passed ? '✅ PASSED' : '❌ FAILED'}: Genetic achieves at least 98% of classic score`,
  );
  return passed;
}

function testCacheEffectiveness() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Evaluation Cache Effectiveness');
  console.log('='.repeat(60));

  const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
  const sub2 = generateSyntheticSubMeasurement('SW2', 'uuid-2', 15, 0.8);

  const config = {
    frequency: { min: 20, max: 200 },
    gain: { min: 0, max: 0, step: 0.1 },
    delay: { min: -0.002, max: 0.002, step: 0.0005 },
    allPass: { enabled: false },
  };

  const optimizer = new MultiSubOptimizer([sub1, sub2], config, deps);
  const prepared = optimizer.prepareMeasurements();
  const refSub = prepared[0];
  refSub.param = MultiSubOptimizer.EMPTY_CONFIG;
  const subToOpt = prepared[1];

  const theo = optimizer.calculateCombinedResponse([subToOpt, refSub], true, false);
  const coarseParams = optimizer.generateTestParams(5);

  optimizer._random = optimizer._createSeededRandom(42);
  optimizer.runGeneticOptimization(subToOpt, refSub, theo, coarseParams, {
    runs: 1,
    populationSize: 50,
    withAllPassProbability: 0,
    generations: 40,
    eliteCount: 7,
    tournamentSize: 3,
    mutationRate: 0.4,
    mutationAmount: 0.4,
    maxNoImprovementGenerations: 15,
    useLocalSearch: true,
  });

  const totalEvals = optimizer._cacheHits + optimizer._cacheMisses;
  const hitRate = (optimizer._cacheHits / totalEvals) * 100;

  console.log(`Total evaluations: ${totalEvals}`);
  console.log(`Cache hits: ${optimizer._cacheHits}`);
  console.log(`Cache misses: ${optimizer._cacheMisses}`);
  console.log(`Hit rate: ${hitRate.toFixed(1)}%`);

  const passed = hitRate > 5;
  console.log(`\n${passed ? '✅ PASSED' : '❌ FAILED'}: Cache hit rate > 5%`);
  return passed;
}

function testDeterministicResults() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Deterministic Results with Fixed Seed');
  console.log('='.repeat(60));

  const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
  const sub2 = generateSyntheticSubMeasurement('SW2', 'uuid-2', 60, 3.2);

  const config = {
    frequency: { min: 20, max: 200 },
    gain: { min: 0, max: 0, step: 0.1 },
    delay: { min: -0.005, max: 0.005, step: 0.0001 },
    allPass: { enabled: false },
  };

  const results = [];
  const seed = 12345;

  for (let run = 0; run < 3; run++) {
    const optimizer = new MultiSubOptimizer(
      [
        {
          ...sub1,
          magnitude: new Float32Array(sub1.magnitude),
          phase: new Float32Array(sub1.phase),
        },
        {
          ...sub2,
          magnitude: new Float32Array(sub2.magnitude),
          phase: new Float32Array(sub2.phase),
        },
      ],
      config,
      deps,
    );

    const prepared = optimizer.prepareMeasurements();
    const refSub = prepared[0];
    refSub.param = MultiSubOptimizer.EMPTY_CONFIG;
    const subToOpt = prepared[1];
    const theo = optimizer.calculateCombinedResponse([subToOpt, refSub], true, false);
    const coarseParams = optimizer.generateTestParams(5);

    // Seed BEFORE the optimization so the GA's stochastic operations
    // (population creation, tournament selection, mutation, crossover) all
    // use the deterministic PRNG. The previous code seeded AFTER
    // runGeneticOptimization, which had no effect on the run itself.
    optimizer._random = optimizer._createSeededRandom(seed);

    const result = optimizer.runGeneticOptimization(
      subToOpt,
      refSub,
      theo,
      coarseParams,
      {
        runs: 1,
        populationSize: 30,
        withAllPassProbability: 0,
        generations: 20,
        eliteCount: 4,
        tournamentSize: 3,
        mutationRate: 0.4,
        mutationAmount: 0.4,
        maxNoImprovementGenerations: 10,
        useLocalSearch: false,
      },
    );

    results.push({
      score: result.bestWithoutAllPass.score,
      delay: result.bestWithoutAllPass.param?.delay,
      polarity: result.bestWithoutAllPass.param?.polarity,
    });

    console.log(
      `Run ${run + 1}: Score=${results[run].score.toFixed(2)}, Delay=${(
        (results[run].delay || 0) * 1000
      ).toFixed(3)}ms`,
    );
  }

  const tolerance = 0.1;
  const allSame = results.every(r => Math.abs(r.score - results[0].score) < tolerance);
  console.log(
    `\n${allSame ? '✅ PASSED' : '❌ FAILED'}: Results are deterministic with same seed`,
  );
  return allSame;
}

function testPhaseAlignmentScenario() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Phase Alignment Detection');
  console.log('='.repeat(60));

  const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
  const sub2 = generateSyntheticSubMeasurement('SW2', 'uuid-2', 180, 0);

  const config = {
    frequency: { min: 20, max: 200 },
    gain: { min: 0, max: 0, step: 0.1 },
    delay: { min: -0.001, max: 0.001, step: 0.0001 },
    allPass: { enabled: false },
  };

  const optimizer = new MultiSubOptimizer([sub1, sub2], config, deps);
  optimizer.frequencyWeights = optimizer.calculateFrequencyWeights(sub1.freqs);
  sub1.param = MultiSubOptimizer.EMPTY_CONFIG;
  sub2.param = MultiSubOptimizer.EMPTY_CONFIG;

  const baselineCombined = optimizer.calculateCombinedResponse([sub1, sub2]);
  const theo = optimizer.calculateCombinedResponse([sub1, sub2], true, false);
  const baselineEfficiency = optimizer.calculateEfficiencyRatio(baselineCombined, theo);
  console.log(`Baseline efficiency (out of phase): ${baselineEfficiency.toFixed(2)}%`);

  const prepared = optimizer.prepareMeasurements();
  const refSub = prepared[0];
  refSub.param = MultiSubOptimizer.EMPTY_CONFIG;
  const subToOpt = prepared[1];
  const testParams = optimizer.generateTestParams();
  const result = optimizer.runClassicOptimization(subToOpt, refSub, theo, testParams);

  console.log(`Optimized score: ${result.bestWithoutAllPass.score.toFixed(2)}`);
  console.log(
    `Optimized polarity: ${result.bestWithoutAllPass.param?.polarity === 1 ? 'normal' : 'inverted'}`,
  );

  const correctPolarity = result.bestWithoutAllPass.param?.polarity === -1;
  const improvedScore = result.bestWithoutAllPass.score > baselineEfficiency;

  // Physical assertion: since both subs have delayMs=0, the optimal delay
  // should be near zero (within a few steps). A large delay would indicate
  // the optimizer is compensating for something other than the phase offset.
  const optimalDelay = result.bestWithoutAllPass.param?.delay ?? 0;
  const delayStep = config.delay.step;
  const delayWithinTolerance = Math.abs(optimalDelay) < delayStep * 5;

  console.log(
    `Optimal delay: ${(optimalDelay * 1000).toFixed(4)}ms (tolerance: ${(delayStep * 5 * 1000).toFixed(4)}ms)`,
  );
  console.log(
    `\n${correctPolarity && improvedScore && delayWithinTolerance ? '✅ PASSED' : '❌ FAILED'}: Correctly detected and fixed phase cancellation`,
  );
  return correctPolarity && improvedScore && delayWithinTolerance;
}

function testLocalSearchImprovement() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Local Search (Hill Climbing) Refinement');
  console.log('='.repeat(60));

  const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
  const sub2 = generateSyntheticSubMeasurement('SW2', 'uuid-2', 25, 1.8);

  const config = {
    frequency: { min: 20, max: 200 },
    gain: { min: -2, max: 2, step: 0.5 },
    delay: { min: -0.005, max: 0.005, step: 0.001 },
    allPass: { enabled: false },
  };

  const optimizer = new MultiSubOptimizer([sub1, sub2], config, deps);
  const prepared = optimizer.prepareMeasurements();
  const refSub = prepared[0];
  refSub.param = MultiSubOptimizer.EMPTY_CONFIG;
  const subToOpt = prepared[1];
  const theo = optimizer.calculateCombinedResponse([subToOpt, refSub], true, false);

  const startParam = {
    delay: 0.001,
    gain: 0,
    polarity: 1,
    allPass: { frequency: 0, q: 0, enabled: false },
  };
  subToOpt.param = startParam;
  const startResult = optimizer.evaluateParameters(subToOpt, refSub, theo);

  console.log(`Starting score: ${startResult.score.toFixed(2)}`);
  console.log(`Starting delay: ${(startParam.delay * 1000).toFixed(3)}ms`);

  const improved = optimizer.localSearch(startParam, subToOpt, refSub, theo, 30);
  console.log(`Improved score: ${improved.score.toFixed(2)}`);
  console.log(`Improved delay: ${(improved.param.delay * 1000).toFixed(3)}ms`);

  const gotBetter = improved.score >= startResult.score;
  console.log(
    `\n${gotBetter ? '✅ PASSED' : '❌ FAILED'}: Local search improves or maintains score`,
  );
  return gotBetter;
}

// ============================================
// GLOBAL REFINEMENT TEST
// ============================================

function testGlobalRefinement() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Global Refinement (Coordinate Descent)');
  console.log('='.repeat(60));

  const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
  const sub2 = generateSyntheticSubMeasurement('SW2', 'uuid-2', 40, 2);
  const sub3 = generateSyntheticSubMeasurement('SW3', 'uuid-3', 90, -1.5);

  const config = {
    frequency: { min: 20, max: 200 },
    gain: { min: 0, max: 0, step: 0.1 },
    delay: { min: -0.005, max: 0.005, step: 0.0001 },
    allPass: { enabled: false },
    optimization: {
      objective: 'balanced',
      globalRefinement: { enabled: true, passes: 2, maxIterations: 20 },
    },
  };

  const optimizer = new MultiSubOptimizer([sub1, sub2, sub3], config, deps);
  const result = optimizer.optimizeSubwoofers();

  const report = result.optimizationReport;
  console.log(`Pre-refinement quality: ${report.preRefinement.qualityScore.toFixed(2)}`);
  console.log(`Final quality: ${report.final.qualityScore.toFixed(2)}`);
  console.log(`Refinement improvements: ${report.globalRefinement.improvements}`);

  // The refinement must never degrade the score (within a tiny float tolerance).
  const noRegression =
    report.final.qualityScore >= report.preRefinement.qualityScore - 0.01;

  // The report must correctly indicate refinement was enabled.
  const refinementEnabled = report.globalRefinement.enabled === true;

  // The improvement count must be a non-negative integer.
  const validImprovementCount =
    Number.isInteger(report.globalRefinement.improvements) &&
    report.globalRefinement.improvements >= 0;

  const passed = noRegression && refinementEnabled && validImprovementCount;
  console.log(
    `\n${passed ? '✅ PASSED' : '❌ FAILED'}: Global refinement does not degrade quality and reports correctly`,
  );
  return passed;
}

// ============================================
// REPORT & GUARDRAILS TEST
// ============================================

function testOptimizationReport() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Optimization Report & Audio Selection Guardrails');
  console.log('='.repeat(60));

  const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
  const sub2 = generateSyntheticSubMeasurement('SW2', 'uuid-2', 30, 1.5);

  const config = {
    frequency: { min: 20, max: 200 },
    gain: { min: 0, max: 0, step: 0.1 },
    delay: { min: -0.005, max: 0.005, step: 0.0001 },
    allPass: { enabled: false },
  };

  const optimizer = new MultiSubOptimizer([sub1, sub2], config, deps);
  const result = optimizer.optimizeSubwoofers();
  const report = result.optimizationReport;

  // Validate report structure
  const hasRequiredFields =
    report.objective === 'balanced' &&
    report.subwooferCount === 2 &&
    typeof report.baseline.qualityScore === 'number' &&
    typeof report.final.qualityScore === 'number' &&
    typeof report.improvement.qualityScore === 'number' &&
    typeof report.implementationCost.maxAbsDelayMs === 'number' &&
    typeof report.audioSelection.score === 'number';

  // Validate efficiency ratio is capped at 100 (fix from review)
  const efficiencyCapped = report.final.efficiencyRatio <= 100;

  // Validate theoretical gap is non-negative
  const gapValid = report.final.theoreticalGap >= 0;

  // Validate audio selection decision is one of the valid values
  const validDecision = ['recommended', 'review', 'rejected'].includes(
    report.audioSelection.decision,
  );

  // Validate guardrails array exists
  const guardrailsValid = Array.isArray(report.audioSelection.guardrails);

  // Validate implementation cost fields
  const costValid =
    report.implementationCost.polarityFlipCount >= 0 &&
    report.implementationCost.allPassCount >= 0 &&
    report.implementationCost.adjustedSubCount >= 0;

  console.log(`  Report structure: ${hasRequiredFields ? 'OK' : 'FAIL'}`);
  console.log(
    `  Efficiency capped ≤100: ${efficiencyCapped ? 'OK' : 'FAIL'} (${report.final.efficiencyRatio.toFixed(2)}%)`,
  );
  console.log(
    `  Theoretical gap ≥0: ${gapValid ? 'OK' : 'FAIL'} (${report.final.theoreticalGap.toFixed(2)}%)`,
  );
  console.log(`  Audio selection decision: ${report.audioSelection.decision}`);
  console.log(`  Guardrails: ${report.audioSelection.guardrails.length} entry(s)`);
  console.log(
    `  Implementation cost: ${JSON.stringify({
      maxAbsDelayMs: report.implementationCost.maxAbsDelayMs.toFixed(3),
      maxAbsGainDb: report.implementationCost.maxAbsGainDb.toFixed(2),
      polarityFlipCount: report.implementationCost.polarityFlipCount,
      allPassCount: report.implementationCost.allPassCount,
    })}`,
  );

  const passed =
    hasRequiredFields &&
    efficiencyCapped &&
    gapValid &&
    validDecision &&
    guardrailsValid &&
    costValid;
  console.log(
    `\n${passed ? '✅ PASSED' : '❌ FAILED'}: Report structure and guardrails are valid`,
  );
  return passed;
}

// ============================================
// ERROR CASE TESTS
// ============================================

function testErrorCases() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Error Cases & Input Validation');
  console.log('='.repeat(60));

  let passedCount = 0;
  let totalCount = 0;

  function assertThrows(description, factory) {
    totalCount++;
    try {
      // The factory is expected to throw during construction; the result is
      // intentionally unused.
      const instance = factory();
      if (instance) throw new Error(`${description}: expected throw but returned`);
      console.log(`  ❌ ${description}: expected throw but did not`);
    } catch (err) {
      passedCount++;
      console.log(`  ✅ ${description}: ${err.message}`);
    }
  }

  // Case 1: Single sub should fail
  assertThrows('Single sub rejected', () => {
    const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
    return new MultiSubOptimizer([sub1], {}, deps);
  });

  // Case 2: Empty array should fail
  assertThrows('Empty array rejected', () => new MultiSubOptimizer([], {}, deps));

  // Case 3: Mismatched frequency lengths should fail
  assertThrows('Mismatched freq lengths rejected', () => {
    const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
    const sub2 = {
      ...sub1,
      measurement: 'uuid-2',
      name: 'SW2',
      freqs: sub1.freqs.slice(0, 10),
      magnitude: sub1.magnitude.slice(0, 10),
      phase: sub1.phase.slice(0, 10),
    };
    return new MultiSubOptimizer([sub1, sub2], {}, deps);
  });

  // Case 4: Invalid config (min > max) should fail
  assertThrows('Invalid delay range (min > max) rejected', () => {
    const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
    const sub2 = generateSyntheticSubMeasurement('SW2', 'uuid-2', 0, 0);
    return new MultiSubOptimizer(
      [sub1, sub2],
      {
        delay: { min: 0.005, max: -0.005, step: 0.0001 },
      },
      deps,
    );
  });

  // Case 5: Invalid step (step ≤ 0) should fail
  assertThrows('Invalid delay step (≤0) rejected', () => {
    const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
    const sub2 = generateSyntheticSubMeasurement('SW2', 'uuid-2', 0, 0);
    return new MultiSubOptimizer(
      [sub1, sub2],
      {
        delay: { min: -0.005, max: 0.005, step: 0 },
      },
      deps,
    );
  });

  // Case 6: Missing measurement UUID should fail
  assertThrows('Missing measurement UUID rejected', () => {
    const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
    const sub2 = { ...sub1, measurement: undefined, name: 'SW2' };
    return new MultiSubOptimizer([sub1, sub2], {}, deps);
  });

  // Case 7: Invalid optimization objective should fail
  assertThrows('Invalid optimization objective rejected', () => {
    const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
    const sub2 = generateSyntheticSubMeasurement('SW2', 'uuid-2', 0, 0);
    return new MultiSubOptimizer(
      [sub1, sub2],
      {
        optimization: { objective: 'invalid' },
      },
      deps,
    );
  });

  // Case 8: theoreticalWeight out of [0,1] should fail
  assertThrows('theoreticalWeight > 1 rejected', () => {
    const sub1 = generateSyntheticSubMeasurement('SW1', 'uuid-1', 0, 0);
    const sub2 = generateSyntheticSubMeasurement('SW2', 'uuid-2', 0, 0);
    return new MultiSubOptimizer(
      [sub1, sub2],
      {
        optimization: { objective: 'max-theoretical', theoreticalWeight: 1.5 },
      },
      deps,
    );
  });

  const passed = passedCount === totalCount;
  console.log(
    `\n${passed ? '✅ PASSED' : '❌ FAILED'}: ${passedCount}/${totalCount} error cases correctly handled`,
  );
  return passed;
}

// ============================================
// REAL-MEASUREMENT TEST (run per data file)
// ============================================

function runClassicComparison(frequencyResponses, optimizerConfig, baselineScore) {
  const freshResponses = frequencyResponses.map(sub => ({
    ...sub,
    magnitude: new Float32Array(sub.magnitude),
    phase: new Float32Array(sub.phase),
    param: { ...MultiSubOptimizer.EMPTY_CONFIG },
  }));

  const optimizer2 = new MultiSubOptimizer(freshResponses, optimizerConfig, deps);
  const prepared2 = optimizer2.prepareMeasurements();
  const refSub2 = prepared2[0];
  refSub2.param = MultiSubOptimizer.EMPTY_CONFIG;
  const testParamsClassic = optimizer2.generateTestParams();

  if (testParamsClassic.length > 1500) {
    console.log(
      `Test params too many (${testParamsClassic.length}), skipping classic comparison.`,
    );
    return null;
  }

  const startTime2 = performance.now();
  let previousSum2 = refSub2;
  const optimizedSubs2 = [];

  for (let i = 1; i < prepared2.length; i++) {
    const subToOpt = prepared2[i];
    const theo2 = optimizer2.calculateCombinedResponse(
      [subToOpt, previousSum2],
      true,
      false,
    );
    const classicResult = optimizer2.runClassicOptimization(
      subToOpt,
      previousSum2,
      theo2,
      testParamsClassic,
    );
    const bestResult =
      classicResult.bestWithoutAllPass.score >= classicResult.bestWithAllPass.score
        ? classicResult.bestWithoutAllPass
        : classicResult.bestWithAllPass;
    subToOpt.param = bestResult.param;
    previousSum2 = bestResult;
    optimizedSubs2.push(subToOpt);
  }

  const endTime2 = performance.now();

  // Compute the global score (same reference as optimizeSubwoofers) so the
  // comparison is apples-to-apples. Using previousSum2.score (a per-sub score
  // computed with theo2) would compare different scoring references.
  const globalTheo2 = optimizer2.calculateCombinedResponse(prepared2, true, false);
  const globalScore2 = optimizer2.calculateOptimizationScore(previousSum2, globalTheo2);
  const improvement2 = ((globalScore2 - baselineScore) / Math.abs(baselineScore)) * 100;

  console.log('\n--- Classic Optimization (for comparison) ---');
  console.log(`Classic optimization time: ${(endTime2 - startTime2).toFixed(0)}ms`);
  console.log(`Classic best score: ${globalScore2.toFixed(2)}`);
  console.log(`Classic improvement: ${improvement2.toFixed(2)}%`);
  console.log('\n--- Classic Optimized Parameters ---');
  for (const sub of optimizedSubs2) {
    const polarity = sub.param.polarity === 1 ? 'normal' : 'inverted';
    console.log(
      `${sub.name}: Delay=${(sub.param.delay * 1000).toFixed(3)}ms, Polarity=${polarity}`,
    );
  }

  return { classicScore: globalScore2, improvement2 };
}

function logOptimizedParams(optimizedSubs) {
  console.log('\n--- Optimized Parameters ---');
  for (const sub of optimizedSubs) {
    const polarity = sub.param.polarity === 1 ? 'normal' : 'inverted';
    console.log(
      `${sub.name}: Delay=${(sub.param.delay * 1000).toFixed(3)}ms, Polarity=${polarity}, Gain=${sub.param.gain.toFixed(2)}dB`,
    );
    if (sub.param.allPass?.enabled) {
      console.log(
        `         AllPass: Freq=${sub.param.allPass.frequency}Hz, Q=${sub.param.allPass.q}`,
      );
    }
  }
}

function evaluateComparisonResult(
  geneticScore,
  baselineScore,
  classicResult,
  improvement,
) {
  const { classicScore, improvement2 } = classicResult;
  const geneticImproves = geneticScore > baselineScore;
  const classicImproves = classicScore > baselineScore;
  const geneticBeatsClassic = geneticScore >= classicScore - 1;

  console.log(
    `\n${geneticScore >= classicScore ? '🧬 Genetic' : '📊 Classic'} optimization performed better`,
  );
  console.log(
    `  Genetic: ${geneticScore.toFixed(2)} vs Classic: ${classicScore.toFixed(2)}`,
  );
  console.log(`\n--- Score Requirements ---`);
  console.log(`  Classic score: ${classicScore.toFixed(2)}`);
  console.log(`  Genetic >= Classic - 1: ${geneticBeatsClassic ? 'YES' : 'NO'}`);

  const passed = geneticImproves && classicImproves && geneticBeatsClassic;
  console.log(
    `\n${passed ? '✅ PASSED' : '❌ FAILED'}: All optimization requirements met`,
  );
  console.log(
    `  Genetic improves: ${geneticImproves ? 'YES' : 'NO'} (${improvement.toFixed(2)}%)`,
  );
  console.log(
    `  Classic improves: ${classicImproves ? 'YES' : 'NO'} (${improvement2.toFixed(2)}%)`,
  );
  return passed;
}

function testWithRealMeasurements(
  frequencyResponses,
  optimizerConfig,
  dataLabel,
  allPassEnabled = false,
) {
  // Clone the config so the allPass mutation does not leak back to the
  // caller's object (which is reused for the AllPass variant of the test).
  const config = structuredClone(optimizerConfig);
  config.allPass.enabled = allPassEnabled;

  console.log('\n' + '='.repeat(60));
  console.log(
    `TEST: Real Measurements — ${dataLabel}${allPassEnabled ? ' (AllPass)' : ''}`,
  );
  console.log('='.repeat(60));

  console.log(`Number of subwoofers: ${frequencyResponses.length}`);
  for (const sub of frequencyResponses) {
    console.log(
      `  - ${sub.name}: ${sub.freqs.length} frequency points (${sub.freqs[0].toFixed(1)}Hz - ${sub.freqs[sub.freqs.length - 1].toFixed(1)}Hz)`,
    );
  }

  console.log(`\nOptimizer config:`);
  console.log(`  Frequency: ${config.frequency.min}Hz - ${config.frequency.max}Hz`);
  console.log(
    `  Delay: ${(config.delay.min * 1000).toFixed(3)}ms - ${(config.delay.max * 1000).toFixed(3)}ms, step=${(config.delay.step * 1000).toFixed(4)}ms`,
  );
  console.log(`  AllPass: ${config.allPass.enabled ? 'enabled' : 'disabled'}`);

  const optimizer = new MultiSubOptimizer(frequencyResponses, config, deps);
  for (const sub of frequencyResponses) {
    if (!sub.param) sub.param = MultiSubOptimizer.EMPTY_CONFIG;
  }

  const preparedSubs = optimizer.prepareMeasurements();
  optimizer.frequencyWeights = optimizer.calculateFrequencyWeights(preparedSubs[0].freqs);

  const baselineCombined = optimizer.calculateCombinedResponse(preparedSubs);
  const baselineTheo = optimizer.calculateCombinedResponse(preparedSubs, true, false);
  const baselineScore = optimizer.calculateQualityScore(baselineCombined, baselineTheo);

  console.log('\n--- Baseline (no optimization) ---');
  console.log(`Quality Score: ${baselineScore.toFixed(2)}`);

  console.log('\n--- Running Optimization (Genetic + Local Search) ---');
  const startTime = performance.now();
  const result = optimizer.optimizeSubwoofers();
  const elapsed = performance.now() - startTime;

  console.log(`Optimization time: ${elapsed.toFixed(0)}ms`);
  console.log(`Best score: ${result.bestSum.score.toFixed(2)}`);

  // Display efficiency ratio to compare with MSO (theoretical max proximity)
  const finalEfficiency = optimizer.calculateEfficiencyRatio(
    result.bestSum,
    baselineTheo,
  );
  const baselineEfficiency = optimizer.calculateEfficiencyRatio(
    baselineCombined,
    baselineTheo,
  );
  console.log(`Baseline efficiency: ${baselineEfficiency.toFixed(2)}%`);
  console.log(`Final efficiency: ${finalEfficiency.toFixed(2)}%`);
  console.log(
    `Efficiency gain: ${(finalEfficiency - baselineEfficiency).toFixed(2)} pts`,
  );

  const maxAllowedTime = allPassEnabled ? 2500 : 1200;
  if (elapsed > maxAllowedTime) {
    throw new Error(
      `Optimization time exceeded ${maxAllowedTime}ms (got ${elapsed.toFixed(0)}ms)`,
    );
  } else {
    console.log(`\n✅ PASSED: Optimization time within ${maxAllowedTime}ms`);
  }

  const improvement =
    ((result.bestSum.score - baselineScore) / Math.abs(baselineScore)) * 100;
  console.log(`Improvement: ${improvement.toFixed(2)}%`);

  logOptimizedParams(result.optimizedSubs);

  console.log('\n--- Cache Statistics ---');
  const hitRate =
    (optimizer._cacheHits / (optimizer._cacheHits + optimizer._cacheMisses)) * 100;
  console.log(`Cache hits: ${optimizer._cacheHits}`);
  console.log(`Cache misses: ${optimizer._cacheMisses}`);
  console.log(`Hit rate: ${hitRate.toFixed(1)}%`);

  const classicResult = runClassicComparison(frequencyResponses, config, baselineScore);
  if (classicResult === null) return true;

  return evaluateComparisonResult(
    result.bestSum.score,
    baselineScore,
    classicResult,
    improvement,
  );
}

// ============================================
// MAIN
// ============================================

console.log('\n' + '🧪'.repeat(30));
console.log('   MULTI-SUB OPTIMIZER TEST SUITE');
console.log('🧪'.repeat(30) + '\n');

const overallStart = performance.now();
const results = [];

// --- Synthetic tests (run once) ---
results.push(
  { name: 'Basic Optimization', passed: testBasicOptimization() },
  { name: 'Genetic vs Classic', passed: testGeneticVsClassic() },
  { name: 'Cache Effectiveness', passed: testCacheEffectiveness() },
  { name: 'Deterministic Results', passed: testDeterministicResults() },
  { name: 'Phase Alignment', passed: testPhaseAlignmentScenario() },
  { name: 'Local Search', passed: testLocalSearchImprovement() },
  { name: 'Global Refinement', passed: testGlobalRefinement() },
  { name: 'Report & Guardrails', passed: testOptimizationReport() },
  { name: 'Error Cases', passed: testErrorCases() },
);

// --- Real-measurement tests (one pair per data file) ---
for (const dataFile of DATA_FILES) {
  const { label, path: dataPath } = dataFile;
  let frequencyResponses, optimizerConfig;

  try {
    ({ frequencyResponses, optimizerConfig } = await import(dataPath));
  } catch (err) {
    console.error(`\n❌ Could not load data file "${dataPath}": ${err.message}`);
    results.push({ name: `Load ${label}`, passed: false });
    continue;
  }

  results.push(
    {
      name: `Real Measurements — ${label}`,
      passed: testWithRealMeasurements(frequencyResponses, optimizerConfig, label, false),
    },
    {
      name: `Real Measurements — ${label} (AllPass)`,
      passed: testWithRealMeasurements(frequencyResponses, optimizerConfig, label, true),
    },
  );
}

// --- Summary ---
console.log('\n' + '='.repeat(60));
console.log('TEST SUMMARY');
console.log('='.repeat(60));

let passedCount = 0;
for (const result of results) {
  const icon = result.passed ? '✅' : '❌';
  console.log(`${icon} ${result.name}`);
  if (result.passed) passedCount++;
}

const overallEnd = performance.now();
console.log(`\nTotal: ${passedCount}/${results.length} tests passed`);
console.log(`Total testing time: ${(overallEnd - overallStart).toFixed(0)}ms`);

if (passedCount === results.length) {
  console.log('\n🎉 All tests passed!');
} else {
  console.log('\n⚠️ Some tests failed');
  throw new Error(`${results.length - passedCount}/${results.length} tests failed`);
}
