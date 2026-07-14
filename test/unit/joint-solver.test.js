import { describe, expect, it } from 'vitest';
import MultiSubOptimizer from '../../src/multi-sub-optimizer.js';
import { buildGenomeLayout, decodeGenome } from '../../src/optimizer/joint-flow.js';
import { runDifferentialEvolution } from '../../src/optimizer/differential-evolution.js';
import deps from '../mocks/logs.js';

function makeSub(name, id, { level = 80, delayMs = 0, points = 96 } = {}) {
  const freqs = [];
  const ppo = 24;
  let f = 20;
  while (freqs.length < points) {
    freqs.push(f);
    f *= Math.pow(2, 1 / ppo);
  }
  const phase = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const deg = -360 * freqs[i] * (delayMs / 1000);
    phase[i] = ((deg + 180) % 360 + 360) % 360 - 180;
  }
  return {
    measurement: id,
    name,
    freqs,
    magnitude: new Float32Array(points).fill(level),
    phase,
    freqStep: Math.pow(2, 1 / ppo),
    ppo,
  };
}

function makeJointOptimizer({
  filtersPerSub = 1,
  seed = 42,
  budget = {},
  jointExtras = {},
} = {}) {
  const sub1 = makeSub('SW1', 'uuid-1');
  const sub2 = makeSub('SW2', 'uuid-2', { delayMs: 2 });
  const optimizer = new MultiSubOptimizer(
    [sub1, sub2],
    {
      frequency: { min: 20, max: 200 },
      delay: { min: -0.005, max: 0.005, step: 0.0001 },
      optimization: {
        objective: 'target-match',
        // Two coherent 80 dB subs sum to 86 dB: the target is reachable.
        targetCurve: { freqs: [10, 400], magnitude: [86, 86] },
        joint: {
          filtersPerSub,
          populationSize: 16,
          alignmentGenerations: budget.alignmentGenerations ?? 40,
          generations: budget.generations ?? 60,
          patience: budget.patience ?? 50,
          ...jointExtras,
        },
      },
    },
    deps,
  );
  optimizer._random = optimizer._createSeededRandom(seed);
  return optimizer;
}

describe('differential evolution', () => {
  it('minimizes a convex function within bounds and stays deterministic', async () => {
    const run = () =>
      runDifferentialEvolution({
        bounds: [
          [-5, 5],
          [-5, 5],
        ],
        cost: g => (g[0] - 1) ** 2 + (g[1] + 2) ** 2,
        populationSize: 20,
        generations: 120,
        patience: 60,
        random: (() => {
          let state = 123;
          return () => {
            state = (state * 1664525 + 1013904223) >>> 0;
            return state / 4294967296;
          };
        })(),
      });

    const first = await run();
    const second = await run();
    expect(first.best[0]).toBeCloseTo(1, 1);
    expect(first.best[1]).toBeCloseTo(-2, 1);
    expect(first.bestCost).toBeCloseTo(second.bestCost, 12);
  });

  it('honours cooperative cancellation and returns the best so far', async () => {
    let calls = 0;
    const result = await runDifferentialEvolution({
      bounds: [[-5, 5]],
      cost: g => g[0] * g[0],
      populationSize: 8,
      generations: 500,
      patience: 500,
      random: Math.random,
      shouldCancel: () => ++calls >= 2,
    });
    expect(result.cancelled).toBe(true);
    expect(result.generationsRun).toBeLessThan(500);
    expect(Number.isFinite(result.bestCost)).toBe(true);
  });
});

describe('joint genome layout', () => {
  it('encodes alignment for subs 1..N-1 and filters for every sub', () => {
    const optimizer = makeJointOptimizer({ filtersPerSub: 2 });
    const layout = buildGenomeLayout(optimizer.config, 3);

    // 2 non-reference subs × 3 alignment dims + 3 subs × 2 filters × 3 dims
    expect(layout.alignmentDims).toBe(6);
    expect(layout.bounds).toHaveLength(6 + 18);

    const genome = new Float64Array(layout.bounds.length);
    genome[0] = 0.002; // delay sub1
    genome[1] = -0.5; // polarity sub1 → -1
    genome[2] = -3; // gain sub1
    genome[layout.alignmentDims] = Math.log10(50); // fc, premier filtre sub0
    genome[layout.alignmentDims + 1] = -6; // gain
    genome[layout.alignmentDims + 2] = Math.log10(2); // Q

    const params = decodeGenome(layout, genome);
    expect(params[0].delay).toBe(0);
    expect(params[0].polarity).toBe(1);
    expect(params[1]).toMatchObject({ delay: 0.002, polarity: -1, gain: -3 });
    expect(params[0].filters[0].frequency).toBeCloseTo(50, 6);
    expect(params[0].filters[0].gain).toBe(-6);
    expect(params[0].filters[0].q).toBeCloseTo(2, 6);
  });
});

describe('joint genome layout — all-pass par sub (expérimental)', () => {
  it('adds [enable, fc, Q] to the alignment block of non-reference subs', () => {
    const optimizer = makeJointOptimizer({ filtersPerSub: 1 });
    optimizer.config.optimization.joint.allPassPerSub = true;
    const layout = buildGenomeLayout(optimizer.config, 3);

    // 2 non-reference subs × (3 alignment + 3 all-pass) dims
    expect(layout.alignmentDims).toBe(12);
    expect(layout.bounds).toHaveLength(12 + 9);

    const genome = new Float64Array(layout.bounds.length);
    genome[3] = 0.5; // enable sub1 → actif
    genome[4] = Math.log10(40); // fc
    genome[5] = Math.log10(0.7); // Q
    genome[9] = -0.2; // enable sub2 → inactif

    const params = decodeGenome(layout, genome);
    expect(params[1].allPass.enabled).toBe(true);
    expect(params[1].allPass.frequency).toBeCloseTo(40, 6);
    expect(params[1].allPass.q).toBeCloseTo(0.7, 6);
    expect(params[2].allPass.enabled).toBe(false);
    // Le sub de référence ne porte jamais d'all-pass.
    expect(params[0].allPass.enabled).toBe(false);
  });

  it('keeps the neutral genome all-pass free', () => {
    const optimizer = makeJointOptimizer({ filtersPerSub: 1 });
    optimizer.config.optimization.joint.allPassPerSub = true;
    const layout = buildGenomeLayout(optimizer.config, 2);

    // Génome neutre = zéros sur le bloc alignement : enable 0 → désactivé.
    const params = decodeGenome(layout, new Float64Array(layout.bounds.length));
    expect(params[1].allPass.enabled).toBe(false);
    expect(params[1]).toMatchObject({ delay: 0, polarity: 1, gain: 0 });
  });
});

describe('optimizeSubwoofersJoint', () => {
  it('improves the target-match score and respects the search bounds', async () => {
    const optimizer = makeJointOptimizer({ filtersPerSub: 1 });
    const result = await optimizer.optimizeSubwoofersJoint();
    const report = result.optimizationReport;

    expect(report.objective).toBe('target-match');
    expect(report.cancelled).toBe(false);
    expect(report.final.score).toBeGreaterThan(report.baseline.score);
    // The 2 ms inter-sub offset costs several dB against the coherent 86 dB
    // target; the solver must recover most of it.
    expect(result.bestSum.targetRms).toBeLessThan(1.5);

    for (const sub of result.optimizedSubs) {
      expect(sub.param.delay).toBeGreaterThanOrEqual(-0.005);
      expect(sub.param.delay).toBeLessThanOrEqual(0.005);
      expect(sub.param.gain).toBeGreaterThanOrEqual(-12);
      // Attenuation-only: a positive trim would cheat above the theoretical
      // ceiling the target is clamped to.
      expect(sub.param.gain).toBeLessThanOrEqual(0);
      for (const filter of sub.param.filters) {
        expect(filter.frequency).toBeGreaterThanOrEqual(20);
        expect(filter.frequency).toBeLessThanOrEqual(200);
        expect(filter.gain).toBeGreaterThanOrEqual(-12);
        expect(filter.gain).toBeLessThanOrEqual(6);
        expect(filter.q).toBeGreaterThanOrEqual(0.3);
        expect(filter.q).toBeLessThanOrEqual(8);
      }
    }
  });

  it('is deterministic for a fixed seed', async () => {
    const first = await makeJointOptimizer({ seed: 7 }).optimizeSubwoofersJoint();
    const second = await makeJointOptimizer({ seed: 7 }).optimizeSubwoofersJoint();
    expect(first.bestSum.score).toBeCloseTo(second.bestSum.score, 10);
  });

  it('is deterministic when seeded via joint config (jointOptimizerBudget path)', async () => {
    const run = () => {
      const optimizer = makeJointOptimizer({ jointExtras: { seed: 1234 } });
      // Le seed doit venir de la CONFIG (chemin du budget e2e), pas du
      // seeding manuel du harnais : on le neutralise explicitement.
      optimizer._random = Math.random;
      return optimizer.optimizeSubwoofersJoint();
    };
    const first = await run();
    const second = await run();
    expect(first.bestSum.score).toBeCloseTo(second.bestSum.score, 10);
    expect(first.optimizedSubs.map(s => s.param)).toEqual(
      second.optimizedSubs.map(s => s.param),
    );
  });

  it('rejects a non-integer joint seed', () => {
    expect(() => makeJointOptimizer({ jointExtras: { seed: 1.5 } })).toThrow(
      /joint\.seed/,
    );
  });

  it('reports progress for both phases', async () => {
    const phases = new Set();
    const optimizer = makeJointOptimizer({ filtersPerSub: 1 });
    await optimizer.optimizeSubwoofersJoint({
      onProgress: p => {
        phases.add(p.phase);
        expect(p.generations).toBeGreaterThan(0);
        expect(Number.isFinite(p.bestScore)).toBe(true);
      },
    });
    expect(phases.has('alignment')).toBe(true);
    expect(phases.has('filters')).toBe(true);
  });

  it('stops on cancellation and flags the report', async () => {
    const optimizer = makeJointOptimizer({
      budget: { alignmentGenerations: 400, generations: 400, patience: 400 },
    });
    let progressCalls = 0;
    const result = await optimizer.optimizeSubwoofersJoint({
      onProgress: () => progressCalls++,
      shouldCancel: () => progressCalls >= 2,
    });
    expect(result.optimizationReport.cancelled).toBe(true);
    expect(result.bestSum).toBeDefined();
    expect(Number.isFinite(result.bestSum.score)).toBe(true);
  });

  it('rejects running the joint flow under another objective', async () => {
    const sub1 = makeSub('SW1', 'uuid-1');
    const sub2 = makeSub('SW2', 'uuid-2');
    const optimizer = new MultiSubOptimizer(
      [sub1, sub2],
      { frequency: { min: 20, max: 200 } },
      deps,
    );
    await expect(optimizer.optimizeSubwoofersJoint()).rejects.toThrow(/target-match/);
  });
});
