import FrequencyResponseProcessor from '../frequency-response-processor.js';

const DEFAULT_PASSBAND_HZ = [30, 80];
const DEFAULT_THRESHOLD_DB = -6;
const DEFAULT_SMOOTHING = '1/6';
const DEFAULT_SLOPE_WINDOW_OCTAVES = 1 / 3;
const DEFAULT_MIN_REGION_OCTAVES = 0.5;
const DEFAULT_EXPECTED_SLOPE_DB_PER_OCTAVE = [3, 36];
const DEFAULT_MAX_RIPPLE_DB = 6;
const DEFAULT_MIN_GROWTH_DB = 3;
const DEFAULT_CONSENSUS_SMOOTHINGS = ['1/12', '1/6', '1/3'];
const DEFAULT_TARGET_RELATIVE_FALL_OFF_DB = -3;
const NO_LOW_TARGET_RELATIVE_FALL_OFF_HZ = -1;
const NO_HIGH_TARGET_RELATIVE_FALL_OFF_HZ = +Infinity;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isNoneSmoothing(smoothing) {
  return smoothing == null || smoothing === 'None' || smoothing === 'none';
}

function assertObject(value, name) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`);
  }
}

function normaliseHzRange(value, fallback, name) {
  if (value == null) return fallback;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(`${name} must be a [lowHz, highHz] array`);
  }

  const low = Number(value[0]);
  const high = Number(value[1]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    throw new TypeError(`${name} must contain finite numbers`);
  }
  if (low <= 0 || high <= low) {
    throw new RangeError(`${name} must be positive and strictly increasing`);
  }

  return [low, high];
}

function normalisePositiveNumber(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return resolved;
}

function normaliseNegativeNumber(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved >= 0) {
    throw new RangeError(`${name} must be a negative number`);
  }
  return resolved;
}

function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
}

function octaveDistance(lowHz, highHz) {
  return Math.log2(highHz / lowHz);
}

function geometricMean(lowHz, highHz) {
  return Math.sqrt(lowHz * highHz);
}

function collectValuesInRange(freqs, values, rangeHz) {
  if (!rangeHz) return values;
  const [lowHz, highHz] = rangeHz;
  const selected = [];
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= lowHz && freqs[i] <= highHz) {
      selected.push(values[i]);
    }
  }
  return selected;
}

function findContiguousSpans(flags) {
  const spans = [];
  let start = -1;

  for (let i = 0; i < flags.length; i++) {
    if (flags[i] && start === -1) {
      start = i;
      continue;
    }

    if (!flags[i] && start !== -1) {
      spans.push({ start, end: i - 1 });
      start = -1;
    }
  }

  if (start !== -1) spans.push({ start, end: flags.length - 1 });
  return spans;
}

function fitLinearRegression(xValues, yValues, start, end) {
  const count = end - start + 1;
  if (count < 2) {
    return {
      slope: 0,
      intercept: yValues[start] ?? 0,
      rmse: 0,
      sse: 0,
      count,
    };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;

  for (let i = start; i <= end; i++) {
    const x = xValues[i];
    const y = yValues[i];
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }

  const denominator = count * sumXX - sumX * sumX;
  const slope = Math.abs(denominator) < 1e-12
    ? 0
    : (count * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / count;

  let sse = 0;
  for (let i = start; i <= end; i++) {
    const residual = yValues[i] - (slope * xValues[i] + intercept);
    sse += residual * residual;
  }

  return {
    slope,
    intercept,
    rmse: Math.sqrt(sse / count),
    sse,
    count,
  };
}

function buildIndeterminate(reason, warnings = []) {
  return {
    status: 'indeterminate',
    reason,
    confidence: 0,
    warnings,
  };
}

function nearestFrequencyIndex(freqs, frequency) {
  if (!freqs?.length || !Number.isFinite(frequency)) return -1;

  let low = 0;
  let high = freqs.length;

  while (low < high) {
    const mid = (low + high) >>> 1;
    if (freqs[mid] < frequency) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  if (low === 0) return 0;
  if (low >= freqs.length) return freqs.length - 1;

  const previousIndex = low - 1;
  return Math.abs(freqs[previousIndex] - frequency) <= Math.abs(freqs[low] - frequency)
    ? previousIndex
    : low;
}

function targetRelativeFallOffSideConfig(side) {
  if (side === 'low') {
    return {
      fallback: NO_LOW_TARGET_RELATIVE_FALL_OFF_HZ,
      step: 1,
    };
  }

  if (side === 'high') {
    return {
      fallback: NO_HIGH_TARGET_RELATIVE_FALL_OFF_HZ,
      step: -1,
    };
  }

  throw new Error(`Invalid cutoff side: ${side}`);
}

function targetRelativeMagnitudeDiff(targetSeries, measurementSeries, targetIndex) {
  const measurementIndex = nearestFrequencyIndex(
    measurementSeries.freqs,
    targetSeries.freqs[targetIndex],
  );

  if (measurementIndex === -1) return Number.NaN;

  return measurementSeries.magnitude[measurementIndex] - targetSeries.magnitude[targetIndex];
}

function findTargetRelativeCutoff(side, targetSeries, measurementSeries, thresholdDb) {
  const config = targetRelativeFallOffSideConfig(side);
  let targetIndex = config.step > 0 ? 0 : targetSeries.freqs.length - 1;

  while (targetIndex >= 0 && targetIndex < targetSeries.freqs.length) {
    const magnitudeDiff = targetRelativeMagnitudeDiff(
      targetSeries,
      measurementSeries,
      targetIndex,
    );

    if (Number.isFinite(magnitudeDiff) && magnitudeDiff >= thresholdDb) {
      return Math.round(targetSeries.freqs[targetIndex]);
    }

    targetIndex += config.step;
  }

  return config.fallback;
}

export class FrequencyResponseAnalyzer {
  static validateResponse(response, context = 'FrequencyResponseAnalyzer') {
    assertObject(response, 'frequencyResponse');

    const { freqs, values } = FrequencyResponseProcessor.validateFrequencySeries(
      response.freqs,
      response.magnitude,
      context,
    );

    if (freqs.length < 2) {
      throw new RangeError(`${context}: at least two frequency points are required`);
    }

    return { freqs, magnitude: values };
  }

  static prepareResponse(response, options = {}) {
    const { freqs, magnitude } = this.validateResponse(response, 'prepareResponse');
    const fullRange = [freqs[0], freqs.at(-1)];
    const rangeHz = normaliseHzRange(options.rangeHz, fullRange, 'rangeHz');
    const selectedFreqs = [];
    const selectedMagnitude = [];

    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] >= rangeHz[0] && freqs[i] <= rangeHz[1]) {
        selectedFreqs.push(freqs[i]);
        selectedMagnitude.push(magnitude[i]);
      }
    }

    if (selectedFreqs.length < 2) {
      throw new RangeError('rangeHz must include at least two frequency points');
    }

    const smoothing = options.smoothing ?? 'None';
    const smoothedMagnitude = isNoneSmoothing(smoothing)
      ? selectedMagnitude
      : Array.from(
          FrequencyResponseProcessor.smooth(
            selectedFreqs,
            selectedMagnitude,
            smoothing,
          ),
        );

    return {
      freqs: selectedFreqs,
      magnitude: smoothedMagnitude,
      rangeHz,
      smoothing,
    };
  }

  static estimateReferenceLevel(response, options = {}) {
    const series = this.prepareResponse(response, {
      ...options,
      smoothing: options.smoothing ?? DEFAULT_SMOOTHING,
    });
    const warnings = [];
    const hasExplicitPassband = Object.hasOwn(options, 'passbandHz');
    const defaultPassbandAvailable =
      series.freqs[0] <= DEFAULT_PASSBAND_HZ[0] &&
      series.freqs.at(-1) >= DEFAULT_PASSBAND_HZ[1];
    const passbandHz = normaliseHzRange(
      options.passbandHz,
      defaultPassbandAvailable ? DEFAULT_PASSBAND_HZ : null,
      'passbandHz',
    );

    let method = 'upperTrimmedMedian';
    let values = [];

    if (passbandHz) {
      values = collectValuesInRange(series.freqs, series.magnitude, passbandHz);
      if (values.length >= 3) {
        method = 'passbandMedian';
      } else {
        warnings.push(
          hasExplicitPassband
            ? 'passbandHz contains too few points; using upper trimmed median'
            : 'default passband contains too few points; using upper trimmed median',
        );
        values = [];
      }
    }

    if (values.length === 0) {
      const sorted = [...series.magnitude].sort((a, b) => a - b);
      const lowIndex = Math.floor(sorted.length * 0.55);
      const highIndex = Math.max(lowIndex + 1, Math.ceil(sorted.length * 0.9));
      values = sorted.slice(lowIndex, highIndex);
      if (values.length === 0) values = sorted;
      warnings.push('reference level estimated without an explicit passband');
    }

    const levelDb = median(values);
    const baseConfidence = method === 'passbandMedian' ? 0.9 : 0.55;
    const countConfidence = clamp(values.length / 8, 0.25, 1);

    return {
      status: 'ok',
      levelDb,
      method,
      passbandHz,
      pointCount: values.length,
      confidence: clamp(baseConfidence * countConfidence, 0, 0.95),
      warnings,
    };
  }

  static detectBandwidth(response, options = {}) {
    const thresholdDb = normaliseNegativeNumber(
      options.thresholdDb,
      DEFAULT_THRESHOLD_DB,
      'thresholdDb',
    );
    const series = this.prepareResponse(response, {
      ...options,
      smoothing: options.smoothing ?? DEFAULT_SMOOTHING,
    });
    const reference = this.estimateReferenceLevel(response, options);
    const thresholdLevelDb = reference.levelDb + thresholdDb;
    const flags = series.magnitude.map(value => value >= thresholdLevelDb);
    const spans = findContiguousSpans(flags);
    const warnings = [...reference.warnings];

    if (spans.length === 0) {
      return buildIndeterminate('no response region is above the threshold', warnings);
    }

    const passbandCenter = reference.passbandHz
      ? geometricMean(reference.passbandHz[0], reference.passbandHz[1])
      : null;
    const primarySpan = spans.reduce((best, span) => {
      const spanWidth = octaveDistance(series.freqs[span.start], series.freqs[span.end]);
      const bestWidth = octaveDistance(series.freqs[best.start], series.freqs[best.end]);
      const containsPassband = passbandCenter != null &&
        series.freqs[span.start] <= passbandCenter &&
        series.freqs[span.end] >= passbandCenter;
      const bestContainsPassband = passbandCenter != null &&
        series.freqs[best.start] <= passbandCenter &&
        series.freqs[best.end] >= passbandCenter;

      if (containsPassband !== bestContainsPassband) {
        return containsPassband ? span : best;
      }

      return spanWidth > bestWidth ? span : best;
    }, spans[0]);

    const lowCutoffHz = primarySpan.start > 0
      ? this.interpolateLogFrequency(
          series.freqs[primarySpan.start - 1],
          series.freqs[primarySpan.start],
          series.magnitude[primarySpan.start - 1],
          series.magnitude[primarySpan.start],
          thresholdLevelDb,
        )
      : series.freqs[primarySpan.start];
    const highCutoffHz = primarySpan.end < series.freqs.length - 1
      ? this.interpolateLogFrequency(
          series.freqs[primarySpan.end],
          series.freqs[primarySpan.end + 1],
          series.magnitude[primarySpan.end],
          series.magnitude[primarySpan.end + 1],
          thresholdLevelDb,
        )
      : series.freqs[primarySpan.end];
    const bandwidthOctaves = octaveDistance(lowCutoffHz, highCutoffHz);
    const touchesBoundary =
      primarySpan.start === 0 || primarySpan.end === series.freqs.length - 1;

    if (spans.length > 1) warnings.push('multiple above-threshold regions detected');
    if (touchesBoundary) warnings.push('bandwidth touches the analysis range boundary');

    const confidence = clamp(
      reference.confidence -
        (spans.length > 1 ? 0.12 : 0) -
        (touchesBoundary ? 0.18 : 0),
      0.1,
      0.95,
    );

    return {
      status: 'ok',
      lowCutoffHz,
      highCutoffHz,
      lowCutoff: lowCutoffHz,
      highCutoff: highCutoffHz,
      centerFrequencyHz: geometricMean(lowCutoffHz, highCutoffHz),
      centerFrequency: geometricMean(lowCutoffHz, highCutoffHz),
      bandwidthOctaves,
      octaves: bandwidthOctaves,
      referenceLevelDb: reference.levelDb,
      thresholdDb,
      thresholdLevelDb,
      reference,
      confidence,
      warnings,
    };
  }

  static detectTargetRelativeFallOff(targetResponse, measurementResponse, options = {}) {
    const thresholdDb = normaliseNegativeNumber(
      options.thresholdDb,
      DEFAULT_TARGET_RELATIVE_FALL_OFF_DB,
      'thresholdDb',
    );
    const targetSeries = this.validateResponse(
      targetResponse,
      'detectTargetRelativeFallOff targetResponse',
    );
    const measurementSeries = this.validateResponse(
      measurementResponse,
      'detectTargetRelativeFallOff measurementResponse',
    );

    return {
      lowHz: findTargetRelativeCutoff(
        'low',
        targetSeries,
        measurementSeries,
        thresholdDb,
      ),
      highHz: findTargetRelativeCutoff(
        'high',
        targetSeries,
        measurementSeries,
        thresholdDb,
      ),
    };
  }

  static calculateSlopeProfile(response, options = {}) {
    const slopeWindowOctaves = normalisePositiveNumber(
      options.slopeWindowOctaves,
      DEFAULT_SLOPE_WINDOW_OCTAVES,
      'slopeWindowOctaves',
    );
    const halfWindow = slopeWindowOctaves * 0.5;
    const series = this.prepareResponse(response, {
      ...options,
      smoothing: options.smoothing ?? DEFAULT_SMOOTHING,
    });
    const logFreqs = series.freqs.map(freq => Math.log2(freq));
    const slopesDbPerOctave = new Float32Array(series.freqs.length);
    const fitErrorDb = new Float32Array(series.freqs.length);
    let left = 0;
    let right = 0;

    for (let i = 0; i < series.freqs.length; i++) {
      while (left < i && logFreqs[i] - logFreqs[left] > halfWindow) left++;
      while (
        right + 1 < series.freqs.length &&
        logFreqs[right + 1] - logFreqs[i] <= halfWindow
      ) {
        right++;
      }

      const fitStart = right > left ? left : Math.max(0, i - 1);
      const fitEnd = right > left ? right : Math.min(series.freqs.length - 1, i + 1);
      const fit = fitLinearRegression(logFreqs, series.magnitude, fitStart, fitEnd);
      slopesDbPerOctave[i] = fit.slope;
      fitErrorDb[i] = fit.rmse;
    }

    return {
      status: 'ok',
      freqs: Float32Array.from(series.freqs),
      slopesDbPerOctave,
      fitErrorDb,
      smoothing: series.smoothing,
      slopeWindowOctaves,
    };
  }

  static detectNaturalGrowth(response, options = {}) {
    const expectedSlopeRangeDbPerOctave = normaliseHzRange(
      options.expectedSlopeRangeDbPerOctave,
      DEFAULT_EXPECTED_SLOPE_DB_PER_OCTAVE,
      'expectedSlopeRangeDbPerOctave',
    );
    const minRegionOctaves = normalisePositiveNumber(
      options.minRegionOctaves,
      DEFAULT_MIN_REGION_OCTAVES,
      'minRegionOctaves',
    );
    const maxRippleDb = normalisePositiveNumber(
      options.maxRippleDb,
      DEFAULT_MAX_RIPPLE_DB,
      'maxRippleDb',
    );
    const minGrowthDb = normalisePositiveNumber(
      options.minGrowthDb,
      DEFAULT_MIN_GROWTH_DB,
      'minGrowthDb',
    );
    const direction = options.direction ?? 'lowToHigh';
    if (direction !== 'lowToHigh' && direction !== 'highToLow') {
      throw new Error('direction must be lowToHigh or highToLow');
    }

    const series = this.prepareResponse(response, {
      ...options,
      smoothing: options.smoothing ?? DEFAULT_SMOOTHING,
    });
    const slopeProfile = this.calculateSlopeProfile(response, options);
    const sign = direction === 'lowToHigh' ? 1 : -1;
    const [minSlope, maxSlope] = expectedSlopeRangeDbPerOctave;
    const flags = Array.from(slopeProfile.slopesDbPerOctave, (slope, index) => {
      const signedSlope = sign * slope;
      return (
        signedSlope >= minSlope &&
        signedSlope <= maxSlope &&
        slopeProfile.fitErrorDb[index] <= maxRippleDb
      );
    });
    const spans = findContiguousSpans(flags);
    const logFreqs = series.freqs.map(freq => Math.log2(freq));
    const candidates = [];

    for (const span of spans) {
      const widthOctaves = logFreqs[span.end] - logFreqs[span.start];
      if (widthOctaves < minRegionOctaves) continue;

      const fit = fitLinearRegression(logFreqs, series.magnitude, span.start, span.end);
      const signedSlope = sign * fit.slope;
      const signedGrowthDb = sign *
        (series.magnitude[span.end] - series.magnitude[span.start]);
      const monotonicity = this.calculateMonotonicity(
        series.magnitude,
        span.start,
        span.end,
        sign,
      );

      if (signedSlope < minSlope || signedSlope > maxSlope) continue;
      if (signedGrowthDb < minGrowthDb) continue;
      if (fit.rmse > maxRippleDb) continue;

      const confidence = clamp(
        0.35 +
          Math.min(widthOctaves / minRegionOctaves, 2) * 0.15 +
          Math.min(signedGrowthDb / Math.max(minGrowthDb, 1), 2) * 0.12 +
          monotonicity * 0.18 -
          Math.min(fit.rmse / maxRippleDb, 1) * 0.1,
        0.1,
        0.95,
      );

      candidates.push({
        startIndex: span.start,
        endIndex: span.end,
        startHz: series.freqs[span.start],
        endHz: series.freqs[span.end],
        widthOctaves,
        growthDb: signedGrowthDb,
        averageSlopeDbPerOctave: fit.slope,
        signedAverageSlopeDbPerOctave: signedSlope,
        fitErrorDb: fit.rmse,
        monotonicity,
        confidence,
      });
    }

    if (candidates.length === 0) {
      return buildIndeterminate('no stable natural growth region found');
    }

    const best = candidates.reduce(
      (winner, candidate) =>
        candidate.confidence > winner.confidence ? candidate : winner,
      candidates[0],
    );

    return {
      status: 'ok',
      ...best,
      candidateCount: candidates.length,
      smoothing: series.smoothing,
      slopeWindowOctaves: slopeProfile.slopeWindowOctaves,
      expectedSlopeRangeDbPerOctave,
      minRegionOctaves,
      maxRippleDb,
      warnings: candidates.length > 1 ? ['multiple growth regions detected'] : [],
    };
  }

  static detectKneeFrequency(response, options = {}) {
    const minSegmentOctaves = normalisePositiveNumber(
      options.minSegmentOctaves,
      options.slopeWindowOctaves ?? DEFAULT_SLOPE_WINDOW_OCTAVES,
      'minSegmentOctaves',
    );
    const minImprovement = options.minKneeImprovement ?? 0.25;
    if (!Number.isFinite(minImprovement) || minImprovement < 0 || minImprovement > 1) {
      throw new RangeError('minKneeImprovement must be between 0 and 1');
    }

    const series = this.prepareResponse(response, {
      ...options,
      smoothing: options.smoothing ?? DEFAULT_SMOOTHING,
    });
    if (series.freqs.length < 6) {
      return buildIndeterminate('not enough points for knee detection');
    }

    const logFreqs = series.freqs.map(freq => Math.log2(freq));
    const fullFit = fitLinearRegression(
      logFreqs,
      series.magnitude,
      0,
      series.freqs.length - 1,
    );
    let best = null;

    for (let split = 2; split < series.freqs.length - 3; split++) {
      const leftWidth = logFreqs[split] - logFreqs[0];
      const rightWidth = logFreqs.at(-1) - logFreqs[split];
      if (leftWidth < minSegmentOctaves || rightWidth < minSegmentOctaves) continue;

      const leftFit = fitLinearRegression(logFreqs, series.magnitude, 0, split);
      const rightFit = fitLinearRegression(
        logFreqs,
        series.magnitude,
        split,
        series.freqs.length - 1,
      );
      const sse = leftFit.sse + rightFit.sse;

      if (!best || sse < best.sse) {
        best = { split, leftFit, rightFit, sse };
      }
    }

    if (!best) {
      return buildIndeterminate('no valid segmented fit found');
    }

    const improvement = fullFit.sse <= 1e-9
      ? 0
      : clamp((fullFit.sse - best.sse) / fullFit.sse, 0, 1);

    if (improvement < minImprovement) {
      return buildIndeterminate('segmented fit does not improve enough', [
        `improvement=${improvement.toFixed(3)}`,
      ]);
    }

    return {
      status: 'ok',
      frequencyHz: series.freqs[best.split],
      kneeFrequencyHz: series.freqs[best.split],
      leftSlopeDbPerOctave: best.leftFit.slope,
      rightSlopeDbPerOctave: best.rightFit.slope,
      improvement,
      fitErrorDb: Math.sqrt(best.sse / series.freqs.length),
      confidence: clamp(0.35 + improvement * 0.55, 0.1, 0.95),
      smoothing: series.smoothing,
      warnings: [],
    };
  }

  static analyze(response, options = {}) {
    const bandwidth = this.detectBandwidth(response, options);
    const naturalGrowth = this.detectNaturalGrowth(response, options);
    const knee = this.detectKneeFrequency(response, options);
    const consensus = this.calculateGrowthConsensus(response, options);
    const results = [bandwidth, naturalGrowth, knee, consensus].filter(
      result => result.status === 'ok',
    );
    const confidence = results.length === 0
      ? 0
      : results.reduce((sum, result) => sum + result.confidence, 0) / results.length;
    const warnings = [bandwidth, naturalGrowth, knee, consensus].flatMap(
      result => result.warnings ?? [],
    );

    return {
      status: results.length > 0 ? 'ok' : 'indeterminate',
      bandwidth,
      naturalGrowth,
      knee,
      consensus,
      confidence,
      warnings,
    };
  }

  static calculateGrowthConsensus(response, options = {}) {
    const smoothings = options.consensusSmoothings ?? DEFAULT_CONSENSUS_SMOOTHINGS;
    if (smoothings === false || smoothings.length === 0) {
      return buildIndeterminate('consensus disabled');
    }

    const results = [];
    for (const smoothing of smoothings) {
      const result = this.detectNaturalGrowth(response, { ...options, smoothing });
      if (result.status === 'ok') results.push(result);
    }

    if (results.length < 2) {
      return buildIndeterminate('not enough successful growth detections for consensus');
    }

    const starts = results.map(result => Math.log2(result.startHz));
    const spreadOctaves = Math.max(...starts) - Math.min(...starts);
    const toleranceOctaves = options.consensusToleranceOctaves ?? 1 / 6;
    const startHz = geometricMean(
      Math.min(...results.map(result => result.startHz)),
      Math.max(...results.map(result => result.startHz)),
    );
    const confidence = spreadOctaves <= toleranceOctaves
      ? clamp(0.7 + (toleranceOctaves - spreadOctaves) * 0.8, 0.1, 0.95)
      : 0.35;

    return {
      status: spreadOctaves <= toleranceOctaves ? 'ok' : 'unstable',
      startHz,
      spreadOctaves,
      toleranceOctaves,
      successfulDetections: results.length,
      confidence,
      warnings: spreadOctaves <= toleranceOctaves
        ? []
        : ['growth detection changes too much across smoothing settings'],
      results,
    };
  }

  static calculateMonotonicity(values, start, end, sign) {
    if (end <= start) return 1;
    let alignedSteps = 0;
    const totalSteps = end - start;

    for (let i = start + 1; i <= end; i++) {
      if (sign * (values[i] - values[i - 1]) >= -0.25) alignedSteps++;
    }

    return alignedSteps / totalSteps;
  }

  static interpolateLogFrequency(freq1, freq2, mag1, mag2, targetMag) {
    if (!Number.isFinite(freq1) || !Number.isFinite(freq2) || freq1 <= 0 || freq2 <= 0) {
      throw new RangeError('frequencies must be positive finite values');
    }

    if (Math.abs(mag2 - mag1) < 1e-10) {
      return geometricMean(freq1, freq2);
    }

    const ratio = clamp((targetMag - mag1) / (mag2 - mag1), 0, 1);
    return freq1 * Math.pow(freq2 / freq1, ratio);
  }
}

export default FrequencyResponseAnalyzer;