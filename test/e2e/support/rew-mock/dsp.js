/**
 * Minimal deterministic DSP helpers for the REW mock.
 *
 * These are TEST DOUBLES, not engine code: the goal is UI parity, not
 * acoustic fidelity (cf. docs/reverse/02-rew-mock.md § 5). The frequency
 * responses served by the mock are plain FFTs of the stored impulse
 * responses, without REW's windowing or smoothing.
 */

/** In-place iterative radix-2 FFT (re/im arrays, length power of two). */
function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error(`FFT length must be a power of 2: ${n}`);

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Compute a linear-frequency response from an impulse response.
 * Returns magnitude in dB (without SPL offset) and phase in degrees for
 * bins 1..N/2 (DC excluded), with startFreq = freqStep = sampleRate / N.
 */
function frequencyResponseFromIR(ir, sampleRate) {
  const n = nextPowerOfTwo(Math.max(ir.length, 2));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(ir);
  fft(re, im);

  const bins = n / 2;
  const magnitude = new Float32Array(bins);
  const phase = new Float32Array(bins);
  for (let k = 1; k <= bins; k++) {
    const mag = Math.hypot(re[k], im[k]);
    magnitude[k - 1] = 20 * Math.log10(mag + 1e-12);
    phase[k - 1] = (Math.atan2(im[k], re[k]) * 180) / Math.PI;
  }
  const freqStep = sampleRate / n;
  return { startFreq: freqStep, freqStep, magnitude, phase };
}

/** Resample a linear-grid response onto a log (ppo) grid via linear interpolation. */
function resampleToPpo(linear, ppo, startFreq = 10, endFreq = 24000) {
  const freqs = [];
  for (let f = startFreq; f <= endFreq; f *= Math.pow(2, 1 / ppo)) freqs.push(f);

  const magnitude = new Float32Array(freqs.length);
  const phase = new Float32Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const pos = (freqs[i] - linear.startFreq) / linear.freqStep;
    const lo = Math.min(Math.max(Math.floor(pos), 0), linear.magnitude.length - 1);
    const hi = Math.min(lo + 1, linear.magnitude.length - 1);
    const t = Math.min(Math.max(pos - lo, 0), 1);
    magnitude[i] = linear.magnitude[lo] * (1 - t) + linear.magnitude[hi] * t;
    phase[i] = linear.phase[lo] * (1 - t) + linear.phase[hi] * t;
  }
  return { startFreq: freqs[0], ppo, magnitude, phase };
}

/** Sample-wise mean of impulse responses (≈ vector average in frequency domain). */
function averageIRs(irs) {
  const length = Math.min(...irs.map(ir => ir.length));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const ir of irs) sum += ir[i];
    out[i] = sum / irs.length;
  }
  return out;
}

/** Mean magnitude (dB) of a linear response within ± spanOctaves/2 around centerHz. */
function levelAround(linear, centerHz, spanOctaves) {
  const span = Math.max(spanOctaves, 0.1);
  const lowHz = centerHz / Math.pow(2, span / 2);
  const highHz = centerHz * Math.pow(2, span / 2);
  let sum = 0;
  let count = 0;
  for (let k = 0; k < linear.magnitude.length; k++) {
    const f = linear.startFreq + k * linear.freqStep;
    if (f >= lowHz && f <= highHz) {
      sum += linear.magnitude[k];
      count++;
    }
  }
  if (count === 0) {
    // Window narrower than the FFT resolution: use the nearest bin.
    const k = Math.min(
      Math.max(Math.round((centerHz - linear.startFreq) / linear.freqStep), 0),
      linear.magnitude.length - 1,
    );
    return linear.magnitude[k];
  }
  return sum / count;
}

function peakIndex(ir) {
  let idx = 0;
  for (let i = 1; i < ir.length; i++) {
    if (Math.abs(ir[i]) > Math.abs(ir[idx])) idx = i;
  }
  return idx;
}

export {
  averageIRs,
  frequencyResponseFromIR,
  levelAround,
  nextPowerOfTwo,
  peakIndex,
  resampleToPpo,
};
