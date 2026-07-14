/**
 * spectrum.js — [MOTEUR] module.
 *
 * Spectre complexe d'une IR évalué directement sur une grille de fréquences
 * arbitraire (DFT au point). Pas de FFT : les grilles visées font quelques
 * dizaines de points log-espacés qui ne tombent pas sur des bins, et le
 * coût O(points × échantillons) reste négligeable sur ces tailles.
 *
 * La phase intègre le `startTime` absolu de l'IR : deux spectres calculés ici
 * partagent le référentiel temporel de REW et sont donc directement sommables
 * (voie enceinte + voie LFE du bass management simulé).
 */

/**
 * Grille de fréquences log-espacées, bornes incluses.
 *
 * @param {number} minHz - Borne basse (> 0)
 * @param {number} maxHz - Borne haute (> minHz)
 * @param {number} pointsPerOctave - Densité de la grille (> 0)
 * @returns {Float64Array} fréquences croissantes, de minHz à maxHz exactement
 */
export function logSpacedFrequencies(minHz, maxHz, pointsPerOctave) {
  if (!Number.isFinite(minHz) || minHz <= 0 || !Number.isFinite(maxHz) || maxHz <= minHz) {
    throw new Error(`Invalid frequency band: ${minHz}Hz - ${maxHz}Hz`);
  }
  if (!Number.isFinite(pointsPerOctave) || pointsPerOctave <= 0) {
    throw new Error(`Invalid points per octave: ${pointsPerOctave}`);
  }

  const octaves = Math.log2(maxHz / minHz);
  const count = Math.max(2, Math.ceil(octaves * pointsPerOctave) + 1);
  const step = octaves / (count - 1);
  return Float64Array.from({ length: count }, (_, i) =>
    i === count - 1 ? maxHz : minHz * 2 ** (i * step),
  );
}

// Période de resynchronisation de la rotation complexe : la récurrence
// (une multiplication complexe par échantillon) dérive en O(n·eps) ; un
// recalcul trigonométrique exact tous les 1024 échantillons la maintient
// bien sous le bruit de quantification des IR, pour un coût négligeable.
const ROTATION_RESYNC_PERIOD = 1024;

/**
 * Spectre complexe X(f) = Σ x[n]·e^(−j2πf·(startTime + n/fs)) aux fréquences
 * demandées.
 *
 * @param {{ data: ArrayLike<number>, sampleRate: number, startTime?: number }} ir
 * @param {ArrayLike<number>} frequencies - Fréquences d'évaluation (Hz)
 * @returns {{ re: Float64Array, im: Float64Array }} même longueur que `frequencies`
 */
export function complexSpectrumAt(ir, frequencies) {
  const { data, sampleRate, startTime = 0 } = ir;
  if (!data?.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('Invalid impulse response for spectrum evaluation');
  }

  const re = new Float64Array(frequencies.length);
  const im = new Float64Array(frequencies.length);

  for (let k = 0; k < frequencies.length; k++) {
    const omega = (2 * Math.PI * frequencies[k]) / sampleRate;
    const stepRe = Math.cos(omega);
    const stepIm = -Math.sin(omega);
    let wRe = 1;
    let wIm = 0;
    let accRe = 0;
    let accIm = 0;
    for (let i = 0; i < data.length; i++) {
      const x = data[i];
      accRe += x * wRe;
      accIm += x * wIm;
      if (i % ROTATION_RESYNC_PERIOD === ROTATION_RESYNC_PERIOD - 1) {
        const angle = -omega * (i + 1);
        wRe = Math.cos(angle);
        wIm = Math.sin(angle);
      } else {
        const nextRe = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = nextRe;
      }
    }

    // Rampe de phase du référentiel absolu (le premier échantillon est à
    // t = startTime, pas à t = 0).
    const phase = -2 * Math.PI * frequencies[k] * startTime;
    const phaseRe = Math.cos(phase);
    const phaseIm = Math.sin(phase);
    re[k] = accRe * phaseRe - accIm * phaseIm;
    im[k] = accRe * phaseIm + accIm * phaseRe;
  }

  return { re, im };
}
