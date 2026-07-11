/**
 * Joint (target-match) optimization flow — MSO-like.
 *
 * Optimizes ALL subs simultaneously — delay, polarity, broadband gain and
 * per-sub peaking filters — so the combined response reaches the target
 * curve. This replaces the historical two-stage logic (align first, then
 * copy one shared EQ onto every sub): a shared EQ preserves the alignment
 * but cannot touch the interference structure, whereas a per-sub filter can
 * remove a destructive interference at its source.
 *
 * Two differential-evolution phases:
 *   1. alignment only (delay/polarity/gain — small space, fast), then
 *   2. the full space, seeded with the phase-1 winner carrying neutral
 *      filters, so the solver can never do worse than alignment alone.
 *
 * The cost is the target-match score (asymmetric deviation from the target
 * + group-delay guard) minus the delay and filter-effort regularizers, all
 * shared with the standard evaluation path so single-candidate scores and
 * solver scores stay comparable.
 */
import { EMPTY_CONFIG, cloneParam } from './config.js';
import { runDifferentialEvolution } from './differential-evolution.js';
import {
  calculateDelayPenalty,
  calculateFilterEffortPenalty,
  calculateOptimizationScoreDetails,
} from './evaluation.js';
import { buildParameterizedSubResponses, calculateCombinedResponse } from './response.js';

const NEUTRAL_FILTER_GAIN = 0;

export async function runJointOptimization(optimizer, options = {}) {
  const { onProgress = null, shouldCancel = null } = options;
  const config = optimizer.config;

  if (config.optimization.objective !== 'target-match') {
    throw new Error('Joint optimization requires the target-match objective');
  }

  const start = performance.now();
  const preparedSubs = optimizer.preparedSubs;
  if (!preparedSubs || preparedSubs.length < 2) {
    throw new Error('At least 2 subwoofers are required for optimization');
  }

  const referenceSub = preparedSubs[0];
  referenceSub.param = EMPTY_CONFIG;

  const joint = config.optimization.joint;
  const layout = buildGenomeLayout(config, preparedSubs.length);

  const baselineParams = preparedSubs.map(() => cloneParam(EMPTY_CONFIG));
  const baselineScore = scoreParams(optimizer, preparedSubs, baselineParams);

  const random = () => optimizer._random();
  const cost = genome => {
    const params = decodeGenome(layout, genome);
    return -scoreParams(optimizer, preparedSubs, params);
  };

  // --- Phase 1 : alignment only. The filter dimensions are frozen at
  // neutral by shrinking their bounds to a point, which keeps a single
  // genome layout (and a single cost function) across both phases.
  const alignmentBounds = layout.bounds.map((range, dim) =>
    dim < layout.alignmentDims ? range : [neutralFilterValue(layout, dim), neutralFilterValue(layout, dim)],
  );
  const neutralGenome = buildNeutralGenome(layout);

  const phase1 = await runDifferentialEvolution({
    bounds: alignmentBounds,
    cost,
    seeds: [neutralGenome],
    populationSize: joint.populationSize,
    generations: joint.alignmentGenerations,
    patience: joint.patience,
    random,
    shouldCancel,
    onGeneration: progress =>
      reportProgress(optimizer, onProgress, 'alignment', progress, joint),
  });

  // --- Phase 2 : full space. Half the population starts as focused
  // perturbations of the alignment winner (plus the winner and the neutral
  // genome), the rest random. With a fully random population, DE/rand/1
  // builds nearly every trial from random members whose junk filter genes
  // mask small refinements — measured stall: when the clamped target is
  // almost reached by alignment alone, 400×80 trials produced zero
  // improvement on all fixtures.
  let phase2 = null;
  if (!phase1.cancelled && joint.filtersPerSub > 0) {
    const focusedSeeds = buildPerturbedSeeds(
      phase1.best,
      layout.bounds,
      Math.floor(joint.populationSize / 2),
      random,
    );
    phase2 = await runDifferentialEvolution({
      bounds: layout.bounds,
      cost,
      seeds: [phase1.best, neutralGenome, ...focusedSeeds],
      populationSize: joint.populationSize,
      generations: joint.generations,
      patience: joint.patience,
      random,
      shouldCancel,
      onGeneration: progress =>
        reportProgress(optimizer, onProgress, 'filters', progress, joint),
    });
  }

  // --- Phase 3 : re-alignment polish. Once the filters exist, the optimal
  // delays/polarities may differ from the phase-1 alignment (the filters
  // changed each sub's phase). Freezing the filter dimensions at the winner
  // and re-running the small alignment-only search gives the "use the other
  // subs first" lever a second chance against solutions where the filter
  // phase found easy (boost-shaped) minima.
  let phase3 = null;
  if (phase2 && !phase2.cancelled) {
    const winnerSoFar = phase2.bestCost <= phase1.bestCost ? phase2 : phase1;
    const realignBounds = layout.bounds.map((range, dim) =>
      dim < layout.alignmentDims ? range : [winnerSoFar.best[dim], winnerSoFar.best[dim]],
    );
    phase3 = await runDifferentialEvolution({
      bounds: realignBounds,
      cost,
      seeds: [winnerSoFar.best],
      populationSize: joint.populationSize,
      generations: joint.alignmentGenerations,
      patience: joint.patience,
      random,
      shouldCancel,
      onGeneration: progress =>
        reportProgress(optimizer, onProgress, 'realign', progress, joint),
    });
  }

  const winner = [phase1, phase2, phase3]
    .filter(Boolean)
    .reduce((best, candidate) => (candidate.bestCost <= best.bestCost ? candidate : best));
  const bestParams = decodeGenome(layout, winner.best);

  for (let subIndex = 0; subIndex < preparedSubs.length; subIndex++) {
    preparedSubs[subIndex].param = cloneParam(bestParams[subIndex]);
  }
  // Unlike the sequential flow, the reference sub IS part of the result: it
  // keeps the timing anchor (delay 0, polarity 1, gain 0) but carries its own
  // filters, which the caller must apply like any other sub's.
  optimizer.optimizedSubs = preparedSubs.slice();

  const bestSum = buildScoredSum(optimizer, preparedSubs);
  const executionTimeMs = performance.now() - start;
  const cancelled =
    phase1.cancelled || (phase2?.cancelled ?? false) || (phase3?.cancelled ?? false);

  const optimizationReport = {
    objective: 'target-match',
    subwooferCount: preparedSubs.length,
    executionTimeMs,
    cancelled,
    baseline: { score: baselineScore },
    final: { score: bestSum.score, targetRms: bestSum.targetRms },
    phases: {
      alignment: {
        generations: phase1.generationsRun,
        score: -phase1.bestCost,
      },
      filters: phase2
        ? { generations: phase2.generationsRun, score: -phase2.bestCost }
        : null,
      realign: phase3
        ? { generations: phase3.generationsRun, score: -phase3.bestCost }
        : null,
    },
  };

  optimizer.lm.info(
    `Joint optimization (${cancelled ? 'cancelled, best-so-far' : 'completed'}): ` +
      `score ${baselineScore.toFixed(2)} → ${bestSum.score.toFixed(2)}, ` +
      `target RMS ${bestSum.targetRms.toFixed(2)} dB, ` +
      `${executionTimeMs.toFixed(0)}ms`,
  );

  return {
    optimizedSubs: optimizer.optimizedSubs,
    bestSum,
    optimizationReport,
  };
}

/**
 * Genome layout:
 *   subs 1..N-1 : [delay, polaritySign, gain]           (alignmentDims)
 *   subs 0..N-1 : filtersPerSub × [log10 fc, gain, log10 Q]
 * The reference sub keeps delay=0/polarity=1/gain=0 but gets filters like
 * every other sub (filters do not move the timing anchor).
 */
export function buildGenomeLayout(config, subCount) {
  const joint = config.optimization.joint;
  const bounds = [];

  for (let k = 1; k < subCount; k++) {
    bounds.push(
      [config.delay.min, config.delay.max],
      [-1, 1],
      [joint.gain.min, joint.gain.max],
    );
  }
  const alignmentDims = bounds.length;

  const fcMin = Math.max(joint.filterFrequency.min, config.frequency.min);
  const fcMax = Math.min(joint.filterFrequency.max, config.frequency.max);
  if (joint.filtersPerSub > 0 && fcMin >= fcMax) {
    throw new Error(
      'Joint filter frequency window is empty (check filterFrequency vs the optimization band)',
    );
  }

  for (let k = 0; k < subCount; k++) {
    for (let f = 0; f < joint.filtersPerSub; f++) {
      bounds.push(
        [Math.log10(fcMin), Math.log10(fcMax)],
        [joint.filterGain.min, joint.filterGain.max],
        [Math.log10(joint.filterQ.min), Math.log10(joint.filterQ.max)],
      );
    }
  }

  return {
    bounds,
    alignmentDims,
    subCount,
    filtersPerSub: joint.filtersPerSub,
  };
}

export function decodeGenome(layout, genome) {
  const { alignmentDims, subCount, filtersPerSub } = layout;
  const params = [];
  let index = 0;

  params.push({ ...cloneParam(EMPTY_CONFIG) });
  for (let k = 1; k < subCount; k++) {
    params.push({
      delay: genome[index++],
      polarity: genome[index++] >= 0 ? 1 : -1,
      gain: genome[index++],
      allPass: { frequency: 0, q: 0, enabled: false },
      filters: [],
    });
  }

  if (filtersPerSub > 0) {
    index = alignmentDims;
    for (let k = 0; k < subCount; k++) {
      const filters = [];
      for (let f = 0; f < filtersPerSub; f++) {
        filters.push({
          frequency: Math.pow(10, genome[index++]),
          gain: genome[index++],
          q: Math.pow(10, genome[index++]),
        });
      }
      params[k].filters = filters;
    }
  }

  return params;
}

/**
 * Focused seeds around a base genome: each dimension is jittered by ±scale
 * of its range (bounds clamping happens in the solver). Gives the DE an
 * exploitation nucleus around the previous phase's winner while the random
 * remainder of the population keeps exploring.
 */
function buildPerturbedSeeds(base, bounds, count, random, scale = 0.05) {
  const seeds = [];
  for (let i = 0; i < count; i++) {
    const seed = new Float64Array(base.length);
    for (let dim = 0; dim < base.length; dim++) {
      const span = bounds[dim][1] - bounds[dim][0];
      seed[dim] = base[dim] + (random() * 2 - 1) * scale * span;
    }
    seeds.push(seed);
  }
  return seeds;
}

function neutralFilterValue(layout, dim) {
  // Filter dims cycle as [fcLog, gain, qLog]; freeze fc/Q mid-range and the
  // gain at 0 (a zero-gain peaking filter is acoustically transparent).
  const offset = (dim - layout.alignmentDims) % 3;
  const [min, max] = layout.bounds[dim];
  return offset === 1 ? NEUTRAL_FILTER_GAIN : (min + max) / 2;
}

function buildNeutralGenome(layout) {
  const genome = new Float64Array(layout.bounds.length);
  for (let dim = 0; dim < layout.bounds.length; dim++) {
    if (dim < layout.alignmentDims) {
      // [delay, polarity, gain] all neutral at 0 (polarity 0 decodes to +1).
      genome[dim] = 0;
    } else {
      genome[dim] = neutralFilterValue(layout, dim);
    }
  }
  return genome;
}

function scoreParams(optimizer, preparedSubs, params) {
  const previousParams = preparedSubs.map(sub => sub.param);
  for (let subIndex = 0; subIndex < preparedSubs.length; subIndex++) {
    preparedSubs[subIndex].param = params[subIndex];
  }

  try {
    const response = calculateCombinedResponse(
      buildParameterizedSubResponses(preparedSubs, -1, { validate: false }),
      false,
      false,
      { validate: false },
    );
    let score = calculateOptimizationScoreDetails(optimizer, response, null).score;
    for (let subIndex = 0; subIndex < preparedSubs.length; subIndex++) {
      score -= calculateDelayPenalty(optimizer, params[subIndex]);
      score -= calculateFilterEffortPenalty(optimizer, params[subIndex]);
    }
    return score;
  } finally {
    for (let subIndex = 0; subIndex < preparedSubs.length; subIndex++) {
      preparedSubs[subIndex].param = previousParams[subIndex];
    }
  }
}

function buildScoredSum(optimizer, preparedSubs) {
  const response = calculateCombinedResponse(
    buildParameterizedSubResponses(preparedSubs, -1, { validate: false }),
    false,
    false,
    { validate: false },
  );
  const details = calculateOptimizationScoreDetails(optimizer, response, null);
  response.score = details.score;
  response.qualityScore = details.qualityScore;
  response.objective = optimizer.config.optimization.objective;
  response.targetRms = calculateTargetRms(optimizer, response);
  return response;
}

function calculateTargetRms(optimizer, response) {
  const target = optimizer.targetMagnitude;
  const weights = optimizer.frequencyWeights;
  let weightSum = 0;
  let sum = 0;
  for (let i = 0; i < response.magnitude.length; i++) {
    const deviation = response.magnitude[i] - target[i];
    weightSum += weights[i];
    sum += deviation * deviation * weights[i];
  }
  return weightSum > 0 ? Math.sqrt(sum / weightSum) : 0;
}

function reportProgress(optimizer, onProgress, phase, progress, joint) {
  const phaseBudget =
    phase === 'filters' ? joint.generations : joint.alignmentGenerations;
  onProgress?.({
    phase,
    generation: progress.generation,
    generations: phaseBudget,
    bestScore: -progress.bestCost,
  });
}
