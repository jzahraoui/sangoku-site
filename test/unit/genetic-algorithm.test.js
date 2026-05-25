import { describe, expect, it } from 'vitest';
import GeneticAlgorithm from '../../src/optimizer/genetic-algorithm.js';

const baseConfig = {
  delay: { min: -0.005, max: 0.005, step: 0.001 },
  gain: { min: -6, max: 6, step: 1 },
  allPass: {
    enabled: false,
    frequency: { min: 10, max: 100, step: 10 },
    q: { min: 0.1, max: 0.5, step: 0.1 },
  },
};

function randomSequence(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

describe('GeneticAlgorithm', () => {
  it('accepts the partial allPass config shape used by optimizer tests', () => {
    const ga = new GeneticAlgorithm({
      delay: baseConfig.delay,
      gain: baseConfig.gain,
      allPass: { enabled: false },
    });

    expect(ga.config.allPass.enabled).toBe(false);
  });

  it('rounds generated values on the configured min-relative step grid', () => {
    const ga = new GeneticAlgorithm({
      delay: { min: 0.15, max: 0.45, step: 0.1 },
      gain: { min: 0, max: 0, step: 1 },
      allPass: { enabled: false },
    });
    ga._random = randomSequence([0, 0, 0.75]);

    const [individual] = ga.createInitialPopulation(1, 0);

    expect(individual.delay).toBe(0.15);
    expect(individual.gain).toBe(0);
    expect(individual.polarity).toBe(-1);
  });

  it('normalizes incomplete individuals before all-pass mutation', () => {
    const ga = new GeneticAlgorithm({
      ...baseConfig,
      allPass: { ...baseConfig.allPass, enabled: true },
    });
    ga._random = randomSequence([0.9, 0.9, 0.9, 0.05, 0, 0, 0.9, 0.9]);

    const individual = { delay: 0, gain: 0, polarity: 1 };
    ga.mutate(individual, 0.2);

    expect(individual.allPass).toEqual({ frequency: 10, q: 0.1, enabled: true });
  });

  it('keeps next generations at the requested population size', () => {
    const ga = new GeneticAlgorithm(baseConfig);
    const evaluated = [
      {
        score: 2,
        param: { delay: 0.001, gain: 0, polarity: 1, allPass: { enabled: false } },
      },
      {
        score: 1,
        param: { delay: 0.002, gain: 0, polarity: -1, allPass: { enabled: false } },
      },
    ];

    const nextGeneration = ga.createNextGeneration(evaluated, 1, 5, 1, 0, 0);

    expect(nextGeneration).toHaveLength(1);
    expect(nextGeneration[0].delay).toBe(0.001);
  });

  it('selects a valid tournament candidate when the random source returns 1', () => {
    const ga = new GeneticAlgorithm(baseConfig);
    ga._random = () => 1;
    const evaluated = [
      { score: 1, param: { delay: 0, gain: 0, polarity: 1 } },
      { score: 2, param: { delay: 0, gain: 0, polarity: -1 } },
    ];

    expect(ga.tournamentSelection(evaluated, 1)).toBe(evaluated[1]);
  });

  it('does not dilute diversity with all-pass when all-pass is disabled', () => {
    const ga = new GeneticAlgorithm({
      delay: { min: -1, max: 1, step: 1 },
      gain: { min: 0, max: 0, step: 1 },
      allPass: { enabled: false },
    });
    const evaluated = [
      { score: 1, param: { delay: -1, gain: 0, polarity: 1 } },
      { score: 1, param: { delay: 1, gain: 0, polarity: -1 } },
    ];

    expect(ga.calculatePopulationDiversity(evaluated)).toBeCloseTo(0.75, 5);
  });

  it('caps stratified samples to the target size while preserving both groups', () => {
    const ga = new GeneticAlgorithm(baseConfig);
    const params = [
      ...Array.from({ length: 20 }, (_, index) => ({
        delay: index,
        gain: 0,
        polarity: 1,
        allPass: { enabled: false },
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        delay: index,
        gain: 0,
        polarity: 1,
        allPass: { frequency: 10, q: 0.1, enabled: true },
      })),
    ];

    const sampled = ga._stratifiedSample(params, 10);

    expect(sampled).toHaveLength(10);
    expect(sampled.some(param => param.allPass.enabled)).toBe(true);
    expect(sampled.some(param => !param.allPass.enabled)).toBe(true);
  });

  it('returns the requested stratified sample size when only one group exists', () => {
    const ga = new GeneticAlgorithm(baseConfig);
    const params = Array.from({ length: 40 }, (_, index) => ({
      delay: index,
      gain: 0,
      polarity: 1,
      allPass: { enabled: false },
    }));

    const sampled = ga._stratifiedSample(params, 10);

    expect(sampled).toHaveLength(10);
    expect(sampled.every(param => !param.allPass.enabled)).toBe(true);
  });

  it('normalizes the coarse best when creating a hybrid population', () => {
    const ga = new GeneticAlgorithm({
      ...baseConfig,
      allPass: { ...baseConfig.allPass, enabled: true },
    });

    const population = ga.createHybridPopulation(
      { delay: 0, gain: 0, polarity: 1 },
      1,
      0,
    );

    expect(population).toEqual([
      { delay: 0, gain: 0, polarity: 1, allPass: { frequency: 0, q: 0, enabled: false } },
    ]);
  });

  it('preserves multiple coarse seeds as hybrid-population elites', () => {
    const ga = new GeneticAlgorithm(baseConfig);

    const population = ga.createHybridPopulation(
      [
        { delay: -0.002, gain: 0, polarity: 1 },
        { delay: 0.003, gain: 1, polarity: -1 },
      ],
      5,
      0,
    );

    expect(population).toHaveLength(5);
    expect(population[0]).toMatchObject({ delay: -0.002, gain: 0, polarity: 1 });
    expect(population[1]).toMatchObject({ delay: 0.003, gain: 1, polarity: -1 });
  });
});
