import { logComparisonResults } from './output.js';
import { calculateCombinedResponse } from './response.js';

// Minimum relative gain (over the magnitude of the baseline score) needed for
// the all-pass solution to be considered a meaningful improvement worth the
// added DSP complexity. Applied symmetrically to positive and negative
// baselines so degraded scenarios (score <= 0) keep the same gate.
const SIGNIFICANT_IMPROVEMENT_RATIO = 0.02;

// Minimum absolute score improvement required for adopting the all-pass when
// the baseline score is near zero (otherwise the relative threshold collapses
// to ~0 and any tiny gain would adopt the extra biquad). Tuned to align with
// the downstream `ineffective-all-pass` guardrail in audio-selection.js.
const SIGNIFICANT_IMPROVEMENT_ABSOLUTE = 0.5;

export function optimizeSingleSub(
  optimizer,
  subToOptimize,
  previousValidSum,
  options = {},
) {
  const {
    method = 'genetic',
    testParamsList = null,
    populationSize = 80,
    generations = 50,
    eliteCount = Math.max(2, Math.floor(0.15 * populationSize)),
    mutationRate = 0.25,
    mutationAmount = 0.2,
    tournamentSize = 5,
    withAllPassProbability = 0.7,
    seed = null,
    runs = 1,
    coarseSeedCount = 1,
    minRunImprovement = 0,
    maxNoImprovementGenerations = 15,
    useLocalSearch = true,
  } = options;

  if (!testParamsList) {
    throw new Error('testParamsList is required for genetic optimization');
  }

  if (seed !== null) {
    optimizer._random = optimizer._createSeededRandom(seed);
  }

  // Theoretical max for per-sub scoring: uses the GLOBAL theoretical max
  // (minimum phase of ALL prepared subs, computed once in flow.js) passed
  // via options, rather than a per-sub theo that changes at each step.
  // The per-sub theo ([sub + previousSum]) created a moving target: each
  // sub was optimized against a different reference, and a solution that
  // was good locally could degrade the global efficiency. Using the global
  // max ensures all subs are scored against the same stable reference,
  // which matches how the final result is evaluated.
  const theo =
    options.globalTheoreticalMax ??
    calculateCombinedResponse([subToOptimize, previousValidSum], false, true, {
      validate: false,
    });

  const result =
    method === 'genetic'
      ? optimizer.runGeneticOptimization(
          subToOptimize,
          previousValidSum,
          theo,
          testParamsList,
          {
            runs,
            populationSize,
            withAllPassProbability,
            generations,
            eliteCount,
            tournamentSize,
            mutationRate,
            mutationAmount,
            coarseSeedCount,
            minRunImprovement,
            maxNoImprovementGenerations,
            useLocalSearch,
          },
        )
      : optimizer.runClassicOptimization(
          subToOptimize,
          previousValidSum,
          theo,
          testParamsList,
        );

  const improvementPercentage = calculateImprovementPercentage(
    result.bestWithAllPass.score,
    result.bestWithoutAllPass.score,
  );

  logComparisonResults(
    optimizer,
    subToOptimize,
    result.bestWithAllPass,
    result.bestWithoutAllPass,
    improvementPercentage,
    method,
  );

  const finalResponse = chooseBestSolution(
    optimizer,
    result.bestWithAllPass,
    result.bestWithoutAllPass,
  );

  return {
    finalResponse,
    comparative: {
      improvementPercentage,
      searchStats: result.stats ?? {
        method,
        runsRequested: 0,
        runsCompleted: 0,
        savedRuns: 0,
        coarseSeedCount: 0,
        minRunImprovement: 0,
      },
    },
  };
}

export function chooseBestSolution(optimizer, bestWithAllPass, bestWithoutAllPass) {
  const allPassInvalid = bestWithAllPass.score === -Infinity;
  const noAllPassInvalid = bestWithoutAllPass.score === -Infinity;

  if (allPassInvalid && noAllPassInvalid) {
    throw new Error(
      'No valid solution found: both all-pass and non-all-pass scores are invalid',
    );
  }
  if (allPassInvalid) {
    return bestWithoutAllPass;
  }
  if (noAllPassInvalid) {
    optimizer.lm.info(`Using all-pass filter (only valid solution)`);
    return bestWithAllPass;
  }

  // Require a meaningful improvement before adopting the all-pass: the AP adds
  // a real DSP cost (extra biquad), so a marginal score gain is not enough.
  // The threshold is `max(|baseline| * RATIO, MIN_ABSOLUTE)` so it remains
  // active even when the baseline score is negative or near zero.
  const requiredImprovement = Math.max(
    Math.abs(bestWithoutAllPass.score) * SIGNIFICANT_IMPROVEMENT_RATIO,
    SIGNIFICANT_IMPROVEMENT_ABSOLUTE,
  );
  const improvement = bestWithAllPass.score - bestWithoutAllPass.score;
  const allPassIsSignificant = improvement > requiredImprovement;

  if (allPassIsSignificant) {
    optimizer.lm.info(`Using all-pass filter for significant improvement`);
    return bestWithAllPass;
  }

  return bestWithoutAllPass;
}

function calculateImprovementPercentage(scoreWithAllPass, scoreWithoutAllPass) {
  return scoreWithAllPass > 0 && scoreWithoutAllPass > 0
    ? (((scoreWithAllPass - scoreWithoutAllPass) / scoreWithoutAllPass) * 100).toFixed(2)
    : 'N/A';
}
