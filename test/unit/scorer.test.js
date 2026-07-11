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

describe('Scorer pre-EQ score', () => {
  function linSpace(start, step, count) {
    return Array.from({ length: count }, (_, i) => start + i * step);
  }

  it('ignores peaks: a peaky response scores like a flat one at equal efficiency', () => {
    const freqs = linSpace(30, 5, 9);
    const scorer = scorerWithUnitWeights(freqs.length);
    const theo = { ...response(freqs, freqs.map(() => 80)), phase: new Float32Array(freqs.length) };
    const flat = { ...response(freqs, freqs.map(() => 77)), phase: new Float32Array(freqs.length) };
    // Same magnitudes except one +8dB peak: balanced penalizes it, pre-eq
    // must not (EQ cuts it for free) — the peak even raises efficiency.
    const peaky = {
      ...response(freqs, freqs.map((f, i) => (i === 4 ? 85 : 77))),
      phase: new Float32Array(freqs.length),
    };

    expect(scorer.calculatePreEqScore(peaky, theo)).toBeGreaterThanOrEqual(
      scorer.calculatePreEqScore(flat, theo),
    );
  });

  it('penalizes a localized hole below theo but not a uniform shortfall', () => {
    const freqs = linSpace(30, 5, 9);
    const scorer = scorerWithUnitWeights(freqs.length);
    const theo = { ...response(freqs, freqs.map(() => 80)), phase: new Float32Array(freqs.length) };
    const uniform = new Float32Array(freqs.length).fill(74);
    const holed = Float32Array.from(uniform);
    holed[4] = 60; // 14dB below the typical 6dB shortfall

    const uniformPenalty = scorer._calculateDipVsTheoPenalty(
      uniform, theo.magnitude, freqs.length, freqs.length,
    );
    const holedPenalty = scorer._calculateDipVsTheoPenalty(
      holed, theo.magnitude, freqs.length, freqs.length,
    );

    expect(uniformPenalty).toBe(0);
    expect(holedPenalty).toBeGreaterThan(0);
  });

  it('charges group-delay excess beyond one period but not a pure bulk delay', () => {
    const count = 48;
    const freqs = linSpace(20, 2.5, count);
    const scorer = scorerWithUnitWeights(count);

    // Pure delay: phase = -360 * f * tau (linear phase, wrapped) — constant
    // group delay, zero excess.
    const tau = 0.01;
    const pureDelayPhase = Float32Array.from(
      freqs.map(f => ((-360 * f * tau + 180) % 360 + 360) % 360 - 180),
    );
    // Same delay plus a strong local phase rotation around 60Hz (several
    // periods of extra group delay over a narrow band).
    const trailingPhase = Float32Array.from(
      freqs.map(f => {
        const local = Math.exp(-Math.pow((f - 60) / 4, 2)) * -4000;
        const deg = -360 * f * tau + local;
        return ((deg + 180) % 360 + 360) % 360 - 180;
      }),
    );

    const pureDelayPenalty = scorer._calculateGroupDelayExcessPenalty(
      freqs, pureDelayPhase, count, count,
    );
    const trailingPenalty = scorer._calculateGroupDelayExcessPenalty(
      freqs, trailingPhase, count, count,
    );

    expect(pureDelayPenalty).toBeCloseTo(0, 5);
    expect(trailingPenalty).toBeGreaterThan(0);
  });
});
