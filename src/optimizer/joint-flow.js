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
 * Three differential-evolution phases:
 *   1. alignment only (delay/polarity/gain — small space, fast), then
 *   2. the full space, seeded with the phase-1 winner carrying neutral
 *      filters, so the solver can never do worse than alignment alone, then
 *   3. re-alignment with the filter dimensions frozen at the winner (the
 *      filters changed each sub's phase, so the optimal delays/polarities
 *      may have moved).
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
import {
  clearFrozenFilters,
  createJointEvaluationContext,
  decimateArray,
  decimatePreparedSubs,
  evaluateCombinedResponse,
  setFrozenFilters,
} from './joint-evaluator.js';
import Scorer from './scoring.js';

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
  // Reproductibilité opt-in (joint.seed, entier positif) : toute la
  // randomness du flux passe par optimizer._random — la seeder ici rend les
  // trois phases déterministes. Sans seed : Math.random (historique).
  if (joint.seed !== null && joint.seed !== undefined) {
    optimizer._random = optimizer._createSeededRandom(joint.seed);
  }
  const layout = buildGenomeLayout(config, preparedSubs.length);

  const baselineParams = preparedSubs.map(() => cloneParam(EMPTY_CONFIG));
  const baselineScore = scoreParams(optimizer, preparedSubs, baselineParams);

  const random = () => optimizer._random();
  const { cost, evaluationContext } = createSolverCost(optimizer, preparedSubs, layout, joint);

  // --- Phase 1 : alignment only. The filter dimensions are frozen at
  // neutral by shrinking their bounds to a point, which keeps a single
  // genome layout (and a single cost function) across both phases.
  const alignmentBounds = layout.bounds.map((range, dim) =>
    dim < layout.alignmentDims ? range : [neutralFilterValue(layout, dim), neutralFilterValue(layout, dim)],
  );
  const neutralGenome = buildNeutralGenome(layout);

  // Budgets des phases d'alignement (1 et 3) : espace libre réduit (3 dims
  // par sub non-référence) — population et patience dédiées, bornées par le
  // budget principal pour ne jamais gonfler un budget de test réduit.
  const alignmentPopulationSize = Math.min(
    joint.alignmentPopulationSize,
    joint.populationSize,
  );
  const alignmentPatience = Math.min(joint.alignmentPatience, joint.patience);

  const phase1Start = performance.now();
  const phase1 = await runDifferentialEvolution({
    bounds: alignmentBounds,
    cost,
    seeds: [neutralGenome],
    populationSize: alignmentPopulationSize,
    generations: joint.alignmentGenerations,
    patience: alignmentPatience,
    patienceEpsilon: joint.patienceEpsilon,
    random,
    shouldCancel,
    onGeneration: progress =>
      reportProgress(optimizer, onProgress, 'alignment', progress, joint),
  });
  phase1.timeMs = performance.now() - phase1Start;

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
    const phase2Start = performance.now();
    phase2 = await runDifferentialEvolution({
      bounds: layout.bounds,
      cost,
      seeds: [phase1.best, neutralGenome, ...focusedSeeds],
      populationSize: joint.populationSize,
      generations: joint.generations,
      patience: joint.patience,
      patienceEpsilon: joint.patienceEpsilon,
      random,
      shouldCancel,
      onGeneration: progress =>
        reportProgress(optimizer, onProgress, 'filters', progress, joint),
    });
    phase2.timeMs = performance.now() - phase2Start;
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
    // Les dimensions filtres étant bornées au vainqueur, la contribution de
    // chaque filtre est constante sur toute la phase : précomputée une fois
    // (bit-identique à la cascade vivante), plus de biquads par évaluation.
    setFrozenFilters(evaluationContext, decodeGenome(layout, winnerSoFar.best));
    const phase3Start = performance.now();
    phase3 = await runDifferentialEvolution({
      bounds: realignBounds,
      cost,
      seeds: [winnerSoFar.best],
      populationSize: alignmentPopulationSize,
      generations: joint.alignmentGenerations,
      patience: alignmentPatience,
      patienceEpsilon: joint.patienceEpsilon,
      random,
      shouldCancel,
      onGeneration: progress =>
        reportProgress(optimizer, onProgress, 'realign', progress, joint),
    });
    phase3.timeMs = performance.now() - phase3Start;
    clearFrozenFilters(evaluationContext);
  }

  const candidates = [phase1, phase2, phase3].filter(Boolean);
  const winner = candidates.reduce(
    (best, candidate) => (candidate.bestCost <= best.bestCost ? candidate : best),
    candidates[0],
  );
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
        timeMs: phase1.timeMs,
      },
      filters: phase2
        ? {
            generations: phase2.generationsRun,
            score: -phase2.bestCost,
            timeMs: phase2.timeMs,
          }
        : null,
      realign: phase3
        ? {
            generations: phase3.generationsRun,
            score: -phase3.bestCost,
            timeMs: phase3.timeMs,
          }
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
 *                 (+ [apEnable, log10 apFc, log10 apQ] with allPassPerSub)
 *   subs 0..N-1 : filtersPerSub × [log10 fc, gain, log10 Q]
 * The reference sub keeps delay=0/polarity=1/gain=0 but gets filters like
 * every other sub (filters do not move the timing anchor). The all-pass is
 * an ALIGNMENT lever (phase-only): its dims live with the alignment block,
 * searched by phases 1 and 3. apEnable > 0 activates it — the neutral
 * genome (all zeros) therefore carries no all-pass.
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
    if (joint.allPassPerSub) {
      bounds.push(
        [-1, 1],
        [Math.log10(joint.allPassFrequency.min), Math.log10(joint.allPassFrequency.max)],
        [Math.log10(joint.allPassQ.min), Math.log10(joint.allPassQ.max)],
      );
    }
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
    allPassPerSub: joint.allPassPerSub,
  };
}

export function decodeGenome(layout, genome) {
  const { alignmentDims, subCount, filtersPerSub, allPassPerSub } = layout;
  const params = [];
  let index = 0;

  params.push({ ...cloneParam(EMPTY_CONFIG) });
  for (let k = 1; k < subCount; k++) {
    const param = {
      delay: genome[index++],
      polarity: genome[index++] >= 0 ? 1 : -1,
      gain: genome[index++],
      allPass: { frequency: 0, q: 0, enabled: false },
      filters: [],
    };
    if (allPassPerSub) {
      const enabled = genome[index++] > 0;
      const frequency = Math.pow(10, genome[index++]);
      const q = Math.pow(10, genome[index++]);
      if (enabled) {
        param.allPass = { frequency, q, enabled: true };
      }
    }
    params.push(param);
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
 * Fonction de coût du solveur : évaluateur fusionné lin/rad sur buffers
 * réutilisés (joint-evaluator.js), sur une grille éventuellement décimée
 * (joint.solverGridStride) — cible et poids décimés par LES MÊMES indices,
 * donc cohérents bin à bin ; le scorer solveur applique exactement le calcul
 * target-match de calculateOptimizationScoreDetails. Le score de baseline,
 * le bestSum final (buildScoredSum), le rapport et le targetRms restent sur
 * le chemin classique PLEINE grille.
 */
function createSolverCost(optimizer, preparedSubs, layout, joint) {
  const solverStride = joint.solverGridStride;
  const solverSubs = decimatePreparedSubs(preparedSubs, solverStride);
  const evaluationContext = createJointEvaluationContext(solverSubs);
  const solverTarget =
    solverStride > 1
      ? decimateArray(optimizer.targetMagnitude, solverStride)
      : optimizer.targetMagnitude;
  const solverScorer =
    solverStride > 1
      ? new Scorer(Scorer.buildWeights(solverSubs[0].freqs))
      : optimizer._scorer;
  const scratchParams = createScratchParams(layout);

  const cost = genome => {
    const params = decodeGenomeInto(layout, genome, scratchParams);
    const response = evaluateCombinedResponse(evaluationContext, params);
    let score = solverScorer.calculateTargetMatchScore(response, solverTarget);
    for (let subIndex = 0; subIndex < params.length; subIndex++) {
      score -= calculateDelayPenalty(optimizer, params[subIndex]);
      score -= calculateFilterEffortPenalty(optimizer, params[subIndex]);
    }
    return -score;
  };

  return { cost, evaluationContext };
}

/**
 * Params scratch pour decodeGenomeInto : la structure complète (référence
 * incluse) est allouée une fois, les évaluations du solveur ne font plus que
 * muter les valeurs. Le sub de référence garde delay 0 / polarity 1 / gain 0
 * (jamais réécrits) mais porte ses filtres comme les autres.
 */
function createScratchParams(layout) {
  const params = [];
  for (let k = 0; k < layout.subCount; k++) {
    params.push({
      delay: 0,
      polarity: 1,
      gain: 0,
      allPass: { frequency: 0, q: 0, enabled: false },
      filters: Array.from({ length: layout.filtersPerSub }, () => ({
        frequency: 0,
        gain: 0,
        q: 0,
      })),
    });
  }
  return params;
}

/**
 * Variante mutation-en-place de decodeGenome pour le chemin chaud du
 * solveur : mêmes règles de décodage, zéro allocation. `decodeGenome` reste
 * la voie du résultat final (objets frais, clonés vers preparedSubs).
 */
export function decodeGenomeInto(layout, genome, params) {
  decodeAlignmentInto(layout, genome, params);
  decodeFiltersInto(layout, genome, params);
  return params;
}

function decodeAlignmentInto(layout, genome, params) {
  const { subCount, allPassPerSub } = layout;
  let index = 0;

  for (let k = 1; k < subCount; k++) {
    const param = params[k];
    param.delay = genome[index++];
    param.polarity = genome[index++] >= 0 ? 1 : -1;
    param.gain = genome[index++];
    if (allPassPerSub) {
      const enabled = genome[index++] > 0;
      const frequency = Math.pow(10, genome[index++]);
      const q = Math.pow(10, genome[index++]);
      param.allPass.enabled = enabled;
      param.allPass.frequency = enabled ? frequency : 0;
      param.allPass.q = enabled ? q : 0;
    }
  }
}

function decodeFiltersInto(layout, genome, params) {
  const { alignmentDims, subCount, filtersPerSub } = layout;
  if (filtersPerSub === 0) return;

  let index = alignmentDims;
  for (let k = 0; k < subCount; k++) {
    const filters = params[k].filters;
    for (let f = 0; f < filtersPerSub; f++) {
      const filter = filters[f];
      filter.frequency = Math.pow(10, genome[index++]);
      filter.gain = genome[index++];
      filter.q = Math.pow(10, genome[index++]);
    }
  }
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
