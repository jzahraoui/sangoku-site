import { fftInPlace } from './fft.js';

/**
 * Impulse-response synthesis from a frequency response (ADR 003).
 *
 * [MOTEUR] module — no DOM, no UI framework. The virtual subwoofer projections
 * are computed as frequency responses (magnitude dB / phase deg); REW exposes
 * no impulse data for plain frequency-response imports, which breaks every
 * IR-based consumer (Find Sub Alignment, previews, peak-gap measurements).
 * Synthesizing the impulse client-side (inverse FFT of the complex spectrum)
 * and importing it as impulse-response data makes the projection a first-class
 * measurement: REW derives the exact same magnitude/phase back from it.
 *
 * Timing: the phase carries the absolute delays of the summed responses
 * (REW responses are referenced to the measurement timeline t = 0), so with
 * `startTime: 0` at import the impulse peak lands at the physically correct
 * time — what produceAligned's peak arithmetic expects.
 */

const DEFAULT_SAMPLE_RATE = 48000;
const MIN_FFT_LENGTH = 4096;
// 2^18 à 48 kHz = 5,46 s d'impulsion, soit Δf = 0,183 Hz : une résolution
// d'affichage 1/48 d'octave tenue jusqu'à ~13 Hz — les mesures réelles de
// balayage font mieux, les projections ne doivent pas être le maillon
// faible dans le grave. Payload d'import REW : ~1,4 Mo en base64.
const MAX_FFT_LENGTH = 262144;

const nextPowerOfTwo = value => 2 ** Math.ceil(Math.log2(value));

/** Unwrap phases (degrees) so linear interpolation never crosses a ±180 jump. */
function unwrapPhaseDegrees(phase) {
  const unwrapped = new Float64Array(phase.length);
  let offset = 0;
  unwrapped[0] = phase[0];
  for (let i = 1; i < phase.length; i++) {
    const delta = phase[i] - phase[i - 1];
    if (delta > 180) offset -= 360;
    else if (delta < -180) offset += 360;
    unwrapped[i] = phase[i] + offset;
  }
  return unwrapped;
}

/**
 * Linear interpolation of `values` (indexed by `freqs`) at `frequency`.
 * Returns null outside the measured band. Works for any monotonic grid
 * (linear or PPO spaced).
 */
function interpolateAt(freqs, values, frequency, cursor) {
  if (frequency < freqs[0] || frequency > freqs[freqs.length - 1]) return null;
  let i = cursor.index;
  while (i < freqs.length - 2 && freqs[i + 1] < frequency) i++;
  cursor.index = i;
  const f0 = freqs[i];
  const f1 = freqs[i + 1];
  const t = f1 === f0 ? 0 : (frequency - f0) / (f1 - f0);
  return values[i] + t * (values[i + 1] - values[i]);
}

/**
 * Build the time-domain impulse of a frequency response.
 *
 * @param {object} response - { freqs[], magnitude[] (dB SPL), phase[] (deg),
 *   freqStep? } — the shape returned by calculateCombinedResponse and the REW
 *   frequency-response getters.
 * @param {object} [options] - { sampleRate, maxLength, center }. `center: true`
 *   adds a linear phase placing the impulse at the middle of the buffer and
 *   reports the matching negative `startTimeSeconds`: importing with that
 *   start time keeps every sample at its physical time (verified on a live
 *   REW — a centered peak imported with startTime −N/2/fs reads back at its
 *   original t) while preserving the anticausal content. Without it,
 *   zero-phase responses (Theo) and negatively-delayed sums wrap their
 *   pre-t=0 half to the end of the buffer and REW discards it (≈ −6 dB on
 *   the reference, truncated predicted responses).
 * @returns {{ data: Float32Array, sampleRate: number, startTimeSeconds: number }}
 */
function synthesizeImpulseFromResponse(
  response,
  { sampleRate = DEFAULT_SAMPLE_RATE, maxLength = MAX_FFT_LENGTH, center = false } = {},
) {
  const { freqs, magnitude, phase } = response ?? {};
  if (!freqs?.length || !magnitude?.length || !phase?.length) {
    throw new Error('Response must carry freqs, magnitude and phase');
  }
  if (freqs.length !== magnitude.length || freqs.length !== phase.length) {
    throw new Error('freqs/magnitude/phase lengths differ');
  }

  // FFT length: resolve the response's own grid at its FINEST spacing — the
  // first interval. On a linear grid it is the constant step; on a log (PPO)
  // grid it is the spacing at the lowest frequency, where the resolution
  // demand is highest. The former sizing read `response.freqStep`, which is
  // a step in Hz on linear REW exports but ABSENT on the log (96-ppo)
  // exports REW also produces: the fallback then averaged a log grid
  // linearly (~20 Hz over a full-range export) and every projection
  // collapsed to the 4096-sample floor — first usable bin ~12 Hz, nothing
  // below ~23 Hz on screen (observed on a live REW 5.40).
  const dfLow = freqs.length > 1 ? freqs[1] - freqs[0] : response.freqStep || 0;
  const wanted = nextPowerOfTwo(sampleRate / Math.max(dfLow, 1e-6));
  const fftLength = Math.min(Math.max(wanted, MIN_FFT_LENGTH), maxLength);
  const binHz = sampleRate / fftLength;

  const unwrappedPhase = unwrapPhaseDegrees(phase);
  const centerSeconds = center ? fftLength / (2 * sampleRate) : 0;
  // FFT locale sur tableaux typés (src/dsp/fft.js) : la variante mathjs
  // allouait un objet Complex par échantillon (~300 ms et des centaines de
  // milliers d'objets par transformée 32k) — prohibitif pour les buffers
  // longs qu'exige la résolution basse fréquence des projections.
  const re = new Float64Array(fftLength);
  const im = new Float64Array(fftLength);
  const cursor = { index: 0 };
  for (let bin = 1; bin < fftLength / 2; bin++) {
    const frequency = bin * binHz;
    const magnitudeDb = interpolateAt(freqs, magnitude, frequency, cursor);
    if (magnitudeDb === null) continue;
    const phaseDegrees =
      interpolateAt(freqs, unwrappedPhase, frequency, cursor) -
      360 * frequency * centerSeconds;
    const linear = 10 ** (magnitudeDb / 20);
    const radians = (phaseDegrees * Math.PI) / 180;
    const valueRe = linear * Math.cos(radians);
    const valueIm = linear * Math.sin(radians);
    re[bin] = valueRe;
    im[bin] = valueIm;
    // Symétrie hermitienne : impulsion réelle.
    re[fftLength - bin] = valueRe;
    im[fftLength - bin] = -valueIm;
  }

  fftInPlace(re, im, true);
  const data = new Float32Array(fftLength);
  for (let i = 0; i < fftLength; i++) {
    data[i] = re[i];
  }
  return { data, sampleRate, startTimeSeconds: -centerSeconds };
}

export { synthesizeImpulseFromResponse };
