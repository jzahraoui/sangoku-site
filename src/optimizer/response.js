import Polar from '../Polar.js';
import FrequencyResponseProcessor from '../frequency-response-processor.js';
import { normalizeParam } from './config.js';

export function validateResponseArrays(response, label, requirePhase = true) {
  const { freqs, magnitude, phase } = response ?? {};
  validateResponseArrayStructure({ freqs, magnitude, phase }, label, requirePhase);
  validateResponseArrayValues({ freqs, magnitude, phase }, label, requirePhase);
}

function validateResponseArrayStructure(arrays, label, requirePhase) {
  validateFrequencyArrayStructure(arrays.freqs, label);
  validateMagnitudeArrayStructure(arrays.freqs, arrays.magnitude, label);
  if (requirePhase) {
    validatePhaseArrayStructure(arrays.freqs, arrays.phase, label);
  }
}

function validateFrequencyArrayStructure(freqs, label) {
  if (!isArrayLike(freqs) || freqs.length === 0) {
    throw new Error(`${label} frequency response arrays cannot be empty`);
  }
}

function validateMagnitudeArrayStructure(freqs, magnitude, label) {
  if (!isArrayLike(magnitude)) {
    throw new Error(`${label} magnitude array is required`);
  }
  if (freqs.length !== magnitude.length) {
    throw new Error(`${label} frequency and magnitude arrays must have the same length`);
  }
}

function validatePhaseArrayStructure(freqs, phase, label) {
  if (!isArrayLike(phase)) {
    throw new Error(`${label} phase array is required`);
  }
  if (freqs.length !== phase.length) {
    throw new Error(`${label} frequency and phase arrays must have the same length`);
  }
}

function validateResponseArrayValues(arrays, label, requirePhase) {
  const { freqs, magnitude, phase } = arrays;
  for (let i = 0; i < freqs.length; i++) {
    validateFrequencyValue(freqs, i, label);
    validateMagnitudeValue(magnitude[i], label);
    if (requirePhase) validatePhaseValue(phase[i], label);
  }
}

function validateFrequencyValue(freqs, index, label) {
  if (!Number.isFinite(freqs[index]) || freqs[index] <= 0) {
    throw new Error(`${label} frequency values must be positive finite numbers`);
  }
  if (index > 0 && freqs[index] <= freqs[index - 1]) {
    throw new Error(`${label} frequency values must be strictly increasing`);
  }
}

function validateMagnitudeValue(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} magnitude values must be finite numbers`);
  }
}

function validatePhaseValue(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} phase values must be finite numbers`);
  }
}

function isArrayLike(value) {
  return value && typeof value.length === 'number';
}

export function displayResponse(response) {
  if (!response?.freqs?.length) {
    return '';
  }

  const size = response.freqs.length;
  const lines = new Array(size);

  for (let i = 0; i < size; i++) {
    lines[i] = `${response.freqs[i].toFixed(6)}  ${response.magnitude[i].toFixed(
      3,
    )} ${response.phase[i].toFixed(4)}`;
  }

  return lines.join('\n');
}

export function calculateCombinedResponse(
  subs,
  theoreticalResponse = false,
  realisticTheoreticalResponse = false,
  { validate = true } = {},
) {
  if (!subs?.length) throw new Error('No measurements provided');
  if (theoreticalResponse && realisticTheoreticalResponse) {
    throw new Error(
      'Cannot calculate both theoretical and realistic theoretical response simultaneously',
    );
  }

  const freqs = validate
    ? validateCompatibleResponses(
        subs,
        !(theoreticalResponse || realisticTheoreticalResponse),
      )
    : subs[0].freqs;

  const freqStep = subs[0].freqStep;
  const ppo = subs[0].ppo;
  const magnitude = new Float32Array(freqs.length);
  const phase = new Float32Array(freqs.length);

  const subPhases = buildPhaseSources(
    subs,
    theoreticalResponse,
    realisticTheoreticalResponse,
  );

  for (let freqIndex = 0; freqIndex < freqs.length; freqIndex++) {
    let real = 0;
    let imaginary = 0;

    for (let subIndex = 0; subIndex < subs.length; subIndex++) {
      const linearMagnitude = Polar.DbToLinearGain(
        subs[subIndex].magnitude[freqIndex],
      );
      const phaseDegrees = theoreticalResponse ? 0 : subPhases[subIndex][freqIndex];
      const phaseRadians = phaseDegrees * Polar.DEGREES_TO_RADIANS;
      real += linearMagnitude * Math.cos(phaseRadians);
      imaginary += linearMagnitude * Math.sin(phaseRadians);
    }

    magnitude[freqIndex] = linearMagnitudeToDb(Math.hypot(real, imaginary));
    phase[freqIndex] = Math.atan2(imaginary, real) * Polar.RADIANS_TO_DEGREES;
  }

  return { freqs, magnitude, phase, freqStep, ppo };
}

function buildPhaseSources(subs, theoreticalResponse, realisticTheoreticalResponse) {
  if (theoreticalResponse) {
    return [];
  }

  if (realisticTheoreticalResponse) {
    return subs.map(sub =>
      FrequencyResponseProcessor.calculateMinimumPhase({
        freqs: sub.freqs,
        magnitude: sub.magnitude,
        freqStep: sub.freqStep,
        ppo: sub.ppo,
      }),
    );
  }

  return subs.map(sub => sub.phase);
}

function linearMagnitudeToDb(linearMagnitude) {
  return 20 * Math.log10(Math.max(linearMagnitude, Number.EPSILON));
}

export function validateCompatibleResponses(subs, requirePhase = true) {
  validateResponseArrays(subs[0], 'Sub 0', requirePhase);

  for (let subIndex = 1; subIndex < subs.length; subIndex++) {
    validateResponseArrays(subs[subIndex], `Sub ${subIndex}`, requirePhase);
  }

  validateMatchingFrequencyGrid(subs);
  return subs[0].freqs;
}

/**
 * Asserts every sub shares the same frequency grid as `subs[0]`.
 * Caller is responsible for any prior structure validation.
 */
export function validateMatchingFrequencyGrid(subs, tolerance = 1e-3) {
  const firstFreqs = subs[0].freqs;
  const firstLen = firstFreqs.length;

  for (let subIndex = 1; subIndex < subs.length; subIndex++) {
    const subFreqs = subs[subIndex].freqs;

    if (subFreqs.length !== firstLen) {
      throw new Error(
        `Sub ${subIndex} has a different number of frequency points than the first sub`,
      );
    }

    for (let i = 0; i < firstLen; i++) {
      if (Math.abs(subFreqs[i] - firstFreqs[i]) > tolerance) {
        throw new Error(
          `Sub ${subIndex} has a different frequency point at index ${i} than the first sub`,
        );
      }
    }
  }
}

export function calculateResponseWithParams(sub, { validate = true } = {}) {
  if (validate) {
    validateResponseArrays(sub, sub?.name ?? 'Sub');
  }

  const size = sub.freqs.length;
  const param = normalizeParam(sub.param);
  const response = {
    measurement: sub.measurement,
    name: sub.name,
    freqs: sub.freqs,
    magnitude: new Float32Array(size),
    phase: new Float32Array(size),
    freqStep: sub.freqStep,
    param,
    ppo: sub.ppo,
  };
  const { gain, delay, polarity, allPass } = param;
  const gainLinear = Polar.DbToLinearGain(gain);
  const polarityPhase = polarity === -1 ? Math.PI : 0;

  let allPassPhaseShift = null;
  if (allPass?.enabled) {
    allPassPhaseShift = calculateAllPassResponse(allPass.frequency, allPass.q);
  }

  for (let freqIndex = 0; freqIndex < size; freqIndex++) {
    const magnitudeLinear = Polar.DbToLinearGain(sub.magnitude[freqIndex]) * gainLinear;
    let phaseRadians =
      sub.phase[freqIndex] * Polar.DEGREES_TO_RADIANS +
      Polar.TWO_PI * sub.freqs[freqIndex] * delay +
      polarityPhase;

    if (allPass?.enabled) {
      phaseRadians +=
        allPassPhaseShift(sub.freqs[freqIndex]) * Polar.DEGREES_TO_RADIANS;
    }

    response.magnitude[freqIndex] = linearMagnitudeToDb(magnitudeLinear);
    response.phase[freqIndex] =
      Polar.normalizePhase(phaseRadians) * Polar.RADIANS_TO_DEGREES;
  }

  return response;
}

export function buildParameterizedSubResponses(
  preparedSubs,
  excludeIndex = -1,
  options = {},
) {
  const responses = [];
  for (let subIndex = 0; subIndex < preparedSubs.length; subIndex++) {
    if (subIndex === excludeIndex) continue;
    responses.push(calculateResponseWithParams(preparedSubs[subIndex], options));
  }
  return responses;
}

export function getFinalSubSum(optimizer) {
  // Use preparedSubs (frequency-filtered to the optimization band) so the
  // returned response matches the band used during optimization. Using
  // subMeasurements here would include out-of-band frequencies and produce a
  // score inconsistent with the optimization result.
  const preparedSubs = optimizer.preparedSubs;
  const [firstSub, ...subsWithoutFirst] = preparedSubs;
  const optimizedSubArray = [firstSub];

  for (const preparedSub of subsWithoutFirst) {
    const found = optimizer.optimizedSubs.find(
      sub => sub.measurement === preparedSub.measurement,
    );

    if (!found) throw new Error('Sub not found in optimized subs');

    optimizedSubArray.push(
      calculateResponseWithParams({ ...preparedSub, param: found.param }),
    );
  }

  return calculateCombinedResponse(optimizedSubArray);
}

export function calculateAllPassResponse(frequency, q) {
  const w0 = Polar.TWO_PI * frequency;

  return freqValue => {
    const w = Polar.TWO_PI * freqValue;
    const phaseShift = -2 * Math.atan2((w0 * w) / q, w0 * w0 - w * w);
    return phaseShift * Polar.RADIANS_TO_DEGREES;
  };
}
