import { describe, expect, it } from 'vitest';
import Scorer from '../../src/optimizer/scoring.js';

function scorerWithUnitWeights(length) {
  return new Scorer(new Float32Array(length).fill(1));
}

function response(freqs, magnitude) {
  return {
    freqs: Float32Array.from(freqs),
    magnitude: Float32Array.from(magnitude),
  };
}

describe('Scorer psychoacoustic invariants', () => {
  it('weights modal and crossover regions above infrasonic and out-of-band content', () => {
    expect(Scorer.computeFrequencyWeight(55)).toBeGreaterThan(
      Scorer.computeFrequencyWeight(20),
    );
    expect(Scorer.computeFrequencyWeight(100)).toBeGreaterThan(
      Scorer.computeFrequencyWeight(180),
    );
    expect(Scorer.computeFrequencyWeight(10)).toBe(0.1);
  });

  it('reports weighted efficiency as actual/theoretical linear magnitude ratio', () => {
    const scorer = scorerWithUnitWeights(3);
    const actual = response([40, 60, 80], [74, 74, 74]);
    const theoretical = response([40, 60, 80], [80, 80, 80]);

    expect(scorer.calculateEfficiencyRatio(actual, theoretical)).toBeCloseTo(50.1187, 3);
  });

  it('scores a flat response at full efficiency when it matches theoretical max', () => {
    const freqs = [25, 40, 55, 80, 100];
    const flat = response(freqs, [80, 80, 80, 80, 80]);
    const scorer = scorerWithUnitWeights(freqs.length);

    // Efficiency is weighted 2×, so a perfect flat response at full
    // efficiency scores 100 * 2 = 200 (no dip/null/peak/smoothness penalties).
    expect(scorer.calculateQualityScore(flat, flat)).toBeCloseTo(200, 5);
  });

  it('penalizes dips much more strongly than equivalent peaks', () => {
    const scorer = scorerWithUnitWeights(5);
    const referenceLevel = 80;
    const levelWeightSum = 5;
    const dip = Float32Array.from([80, 80, 70, 80, 80]);
    const peak = Float32Array.from([80, 80, 90, 80, 80]);

    const { dipPenalty } = scorer._calculateDipPeakPenalties(
      dip,
      referenceLevel,
      levelWeightSum,
      dip.length,
    );
    const { peakPenalty } = scorer._calculateDipPeakPenalties(
      peak,
      referenceLevel,
      levelWeightSum,
      peak.length,
    );

    expect(dipPenalty * 3).toBeGreaterThan(peakPenalty * 0.5 * 20);
  });

  it('penalizes narrow nulls more than similarly deep broad curvature', () => {
    const freqs = Float32Array.from([20, 30, 40, 50, 60, 70, 80]);
    const scorer = scorerWithUnitWeights(freqs.length);
    const levelWeightSum = freqs.length;
    const narrowNull = Float32Array.from([80, 80, 80, 60, 80, 80, 80]);
    const broadDip = Float32Array.from([80, 75, 70, 65, 70, 75, 80]);

    const narrowPenalty = scorer._calculateNullPenalty(
      freqs,
      narrowNull,
      levelWeightSum,
      freqs.length,
    );
    const broadPenalty = scorer._calculateNullPenalty(
      freqs,
      broadDip,
      levelWeightSum,
      freqs.length,
    );

    expect(narrowPenalty).toBeGreaterThan(broadPenalty * 3);
  });

  it('keeps smoothness free below 12 dB/oct and caps isolated spikes', () => {
    const scorer = scorerWithUnitWeights(2);
    const freqs = Float32Array.from([40, 80]);
    const levelWeightSum = 2;

    const thresholdPenalty = scorer._calculateSmoothnessPenalty(
      freqs,
      Float32Array.from([80, 92]),
      levelWeightSum,
      freqs.length,
    );
    const referencePenalty = scorer._calculateSmoothnessPenalty(
      freqs,
      Float32Array.from([80, 104]),
      levelWeightSum,
      freqs.length,
    );
    const cappedPenalty = scorer._calculateSmoothnessPenalty(
      freqs,
      Float32Array.from([80, 200]),
      levelWeightSum,
      freqs.length,
    );

    expect(thresholdPenalty).toBe(0);
    expect(referencePenalty).toBeCloseTo(0.3, 5);
    expect(cappedPenalty).toBeCloseTo(1.25, 5);
  });
});
