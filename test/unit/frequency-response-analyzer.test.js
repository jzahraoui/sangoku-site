import { describe, expect, it } from 'vitest';
import { FrequencyResponseAnalyzer } from '../../src/analysis/frequency-response-analyzer.js';

function logFrequencyGrid(startHz, endHz, ppo = 96) {
  const freqs = [];
  const multiplier = Math.pow(2, 1 / ppo);
  for (let freq = startHz; freq <= endHz * 1.000001; freq *= multiplier) {
    freqs.push(freq);
  }
  return freqs;
}

function response(freqs, magnitudeFn) {
  return {
    freqs: Float32Array.from(freqs),
    magnitude: Float32Array.from(freqs, magnitudeFn),
    phase: null,
  };
}

function responseFromValues(freqs, magnitudeValues) {
  return response(freqs, (_freq, index) => magnitudeValues[index]);
}

function expectOctaveClose(actualHz, expectedHz, toleranceOctaves = 1 / 12) {
  expect(Math.abs(Math.log2(actualHz / expectedHz))).toBeLessThan(
    toleranceOctaves,
  );
}

function rollOnResponse() {
  const freqs = logFrequencyGrid(10, 160);
  return response(freqs, freq =>
    freq < 40 ? 80 - 18 * Math.log2(40 / freq) : 80,
  );
}

describe('FrequencyResponseAnalyzer', () => {
  it('validates getFrequencyResponse-like data', () => {
    expect(() => FrequencyResponseAnalyzer.validateResponse(null)).toThrow(
      TypeError,
    );
    expect(() =>
      FrequencyResponseAnalyzer.validateResponse({
        freqs: Float32Array.from([20]),
        magnitude: Float32Array.from([80]),
      }),
    ).toThrow(RangeError);
    expect(() =>
      FrequencyResponseAnalyzer.validateResponse({
        freqs: Float32Array.from([40, 20]),
        magnitude: Float32Array.from([80, 80]),
      }),
    ).toThrow(/strictly increasing/);
  });

  it('estimates a robust reference level from the passband median', () => {
    const freqs = logFrequencyGrid(20, 120);
    const frequencyResponse = response(freqs, freq => {
      if (freq > 48 && freq < 52) return 95;
      if (freq >= 30 && freq <= 80) return 80;
      return 74;
    });

    const reference = FrequencyResponseAnalyzer.estimateReferenceLevel(
      frequencyResponse,
      {
        passbandHz: [30, 80],
        smoothing: 'None',
      },
    );

    expect(reference.status).toBe('ok');
    expect(reference.method).toBe('passbandMedian');
    expect(reference.levelDb).toBeCloseTo(80, 4);
  });

  it('detects bandwidth cutoffs with logarithmic interpolation', () => {
    const freqs = logFrequencyGrid(10, 300);
    const frequencyResponse = response(freqs, freq => {
      let magnitude = 80;
      if (freq < 30) magnitude -= 24 * Math.log2(30 / freq);
      if (freq > 120) magnitude -= 24 * Math.log2(freq / 120);
      return magnitude;
    });

    const bandwidth = FrequencyResponseAnalyzer.detectBandwidth(frequencyResponse, {
      rangeHz: [10, 300],
      passbandHz: [40, 90],
      thresholdDb: -6,
      smoothing: 'None',
    });

    expect(bandwidth.status).toBe('ok');
    expectOctaveClose(bandwidth.lowCutoffHz, 30 / Math.pow(2, 6 / 24), 1 / 24);
    expectOctaveClose(bandwidth.highCutoffHz, 120 * Math.pow(2, 6 / 24), 1 / 24);
    expect(bandwidth.bandwidthOctaves).toBeGreaterThan(2);
  });

  it('detects falloff relative to the current target curve', () => {
    const freqs = [20, 30, 40, 50, 100, 400, 600, 1000];
    const targetCurveData = response(freqs, () => 75);
    const measurementData = responseFromValues(freqs, [65, 71, 73, 75, 75, 73, 70, 65]);

    expect(
      FrequencyResponseAnalyzer.detectTargetRelativeFallOff(
        targetCurveData,
        measurementData,
        { thresholdDb: -3 },
      ),
    ).toEqual({ lowHz: 40, highHz: 400 });
  });

  it('searches target-relative falloff across the full response range', () => {
    const freqs = [20, 30, 40, 60, 100, 500, 800, 1000];
    const targetCurveData = response(freqs, () => 75);
    const lowSideMeasurement = responseFromValues(freqs, [70, 71, 70, 68, 67, 69, 73, 70]);
    const highSideMeasurement = responseFromValues(freqs, [70, 73, 70, 68, 67, 69, 70, 70]);

    expect(
      FrequencyResponseAnalyzer.detectTargetRelativeFallOff(
        targetCurveData,
        lowSideMeasurement,
        { thresholdDb: -3 },
      ).lowHz,
    ).toBe(800);
    expect(
      FrequencyResponseAnalyzer.detectTargetRelativeFallOff(
        targetCurveData,
        highSideMeasurement,
        { thresholdDb: -3 },
      ).highHz,
    ).toBe(30);
  });

  it('calculates a local slope profile in dB per octave', () => {
    const freqs = logFrequencyGrid(20, 160);
    const frequencyResponse = response(freqs, freq => 60 + 24 * Math.log2(freq / 20));
    const profile = FrequencyResponseAnalyzer.calculateSlopeProfile(
      frequencyResponse,
      {
        smoothing: 'None',
        slopeWindowOctaves: 0.5,
      },
    );
    const midIndex = Math.floor(profile.freqs.length / 2);

    expect(profile.status).toBe('ok');
    expect(profile.slopesDbPerOctave[midIndex]).toBeCloseTo(24, 3);
    expect(profile.fitErrorDb[midIndex]).toBeLessThan(1e-3);
  });

  it('detects a stable natural low-frequency growth region', () => {
    const growth = FrequencyResponseAnalyzer.detectNaturalGrowth(rollOnResponse(), {
      rangeHz: [10, 120],
      smoothing: 'None',
      expectedSlopeRangeDbPerOctave: [6, 30],
      minRegionOctaves: 1,
      minGrowthDb: 12,
      slopeWindowOctaves: 0.5,
    });

    expect(growth.status).toBe('ok');
    expect(growth.startHz).toBeLessThan(16);
    expect(growth.endHz).toBeGreaterThan(30);
    expect(growth.endHz).toBeLessThan(50);
    expect(growth.signedAverageSlopeDbPerOctave).toBeCloseTo(18, 1);
  });

  it('does not mistake a narrow peak for natural growth', () => {
    const freqs = logFrequencyGrid(10, 160);
    const frequencyResponse = response(freqs, freq => {
      const distance = Math.log2(freq / 32);
      return 80 + 10 * Math.exp((-distance * distance) / (2 * 0.03 * 0.03));
    });

    const growth = FrequencyResponseAnalyzer.detectNaturalGrowth(frequencyResponse, {
      rangeHz: [10, 120],
      smoothing: 'None',
      expectedSlopeRangeDbPerOctave: [3, 36],
      minRegionOctaves: 0.5,
      minGrowthDb: 3,
      slopeWindowOctaves: 0.25,
    });

    expect(growth.status).toBe('indeterminate');
  });

  it('detects the knee between roll-on and passband', () => {
    const knee = FrequencyResponseAnalyzer.detectKneeFrequency(rollOnResponse(), {
      rangeHz: [10, 120],
      smoothing: 'None',
      minSegmentOctaves: 0.75,
      minKneeImprovement: 0.2,
    });

    expect(knee.status).toBe('ok');
    expectOctaveClose(knee.frequencyHz, 40, 1 / 12);
    expect(knee.leftSlopeDbPerOctave).toBeGreaterThan(12);
    expect(Math.abs(knee.rightSlopeDbPerOctave)).toBeLessThan(3);
  });
});