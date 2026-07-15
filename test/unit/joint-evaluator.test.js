import { describe, expect, it } from 'vitest';
import Polar from '../../src/Polar.js';
import {
  createJointEvaluationContext,
  evaluateCombinedResponse,
} from '../../src/optimizer/joint-evaluator.js';
import {
  buildParameterizedSubResponses,
  calculateCombinedResponse,
} from '../../src/optimizer/response.js';
import {
  buildGenomeLayout,
  decodeGenome,
  decodeGenomeInto,
} from '../../src/optimizer/joint-flow.js';

function makeSeededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Subs jouets avec du relief (modes + creux) et une phase de délai : le cas
// plat ne stresse ni les filtres ni les annulations.
function makeSub(name, { level = 80, delayMs = 0, rippleDb = 6, ripplePeriod = 0.7 } = {}) {
  const ppo = 24;
  const points = 96;
  const freqs = [];
  let f = 15;
  while (freqs.length < points) {
    freqs.push(f);
    f *= Math.pow(2, 1 / ppo);
  }
  const magnitude = new Float32Array(points);
  const phase = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    magnitude[i] = level + rippleDb * Math.sin(Math.log(freqs[i]) / ripplePeriod);
    const deg = -360 * freqs[i] * (delayMs / 1000);
    phase[i] = ((deg + 180) % 360 + 360) % 360 - 180;
  }
  return {
    measurement: name,
    name,
    freqs,
    magnitude,
    phase,
    freqStep: Math.pow(2, 1 / ppo),
    ppo,
    param: null,
  };
}

function makeSubs() {
  return [
    makeSub('SW1'),
    makeSub('SW2', { delayMs: 2.4, rippleDb: 4, ripplePeriod: 0.5 }),
    makeSub('SW3', { delayMs: -1.1, level: 78, rippleDb: 8 }),
  ];
}

function randomParams(random, subCount, { withAllPass = false } = {}) {
  const params = [];
  for (let k = 0; k < subCount; k++) {
    const reference = k === 0;
    const enabled = withAllPass && !reference && random() > 0.5;
    params.push({
      delay: reference ? 0 : (random() * 2 - 1) * 0.005,
      polarity: reference || random() > 0.3 ? 1 : -1,
      gain: reference ? 0 : -12 * random(),
      allPass: enabled
        ? { frequency: 10 + 90 * random(), q: 0.3 + 1.5 * random(), enabled: true }
        : { frequency: 0, q: 0, enabled: false },
      filters: Array.from({ length: 3 }, () => ({
        frequency: 20 * Math.pow(10, random()),
        // Inclut des gains quasi nuls pour exercer le seuil de neutralité.
        gain: random() > 0.2 ? -12 + 18 * random() : 0.001,
        q: 0.3 * Math.pow(26, random()),
      })),
    });
  }
  return params;
}

// Chemin de référence : calculateResponseWithParams (dB/degrés par sub) puis
// calculateCombinedResponse — exactement ce que scoreParams évaluait.
function classicCombined(subs, params) {
  const previous = subs.map(sub => sub.param);
  for (let k = 0; k < subs.length; k++) subs[k].param = params[k];
  try {
    return calculateCombinedResponse(
      buildParameterizedSubResponses(subs, -1, { validate: false }),
      false,
      false,
      { validate: false },
    );
  } finally {
    for (let k = 0; k < subs.length; k++) subs[k].param = previous[k];
  }
}

// Écart en domaine linéaire complexe, normalisé au plafond cohérent du bin :
// stable près des annulations profondes, où une comparaison en dB explose
// pour des écarts physiquement négligeables.
function maxRelativeComplexError(subs, a, b) {
  let worst = 0;
  for (let i = 0; i < a.magnitude.length; i++) {
    let ceiling = 0;
    for (const sub of subs) ceiling += Polar.DbToLinearGain(sub.magnitude[i]);
    const magA = Polar.DbToLinearGain(a.magnitude[i]);
    const magB = Polar.DbToLinearGain(b.magnitude[i]);
    const phaseA = a.phase[i] * Polar.DEGREES_TO_RADIANS;
    const phaseB = b.phase[i] * Polar.DEGREES_TO_RADIANS;
    const dRe = magA * Math.cos(phaseA) - magB * Math.cos(phaseB);
    const dIm = magA * Math.sin(phaseA) - magB * Math.sin(phaseB);
    worst = Math.max(worst, Math.hypot(dRe, dIm) / ceiling);
  }
  return worst;
}

describe('joint-evaluator', () => {
  it('matches the classic response path on random params (fused lin/rad)', () => {
    const subs = makeSubs();
    const context = createJointEvaluationContext(subs);
    const random = makeSeededRandom(20260715);

    for (let trial = 0; trial < 25; trial++) {
      const params = randomParams(random, subs.length, { withAllPass: trial % 3 === 0 });
      const fused = evaluateCombinedResponse(context, params);
      const classic = classicCombined(subs, params);
      // Seul écart attendu : la quantification Float32 dB/degrés
      // intermédiaire du chemin classique (absente du chemin fusionné).
      expect(maxRelativeComplexError(subs, fused, classic)).toBeLessThan(1e-5);
    }
  });

  it('reuses its buffers without contaminating successive evaluations', () => {
    const subs = makeSubs();
    const context = createJointEvaluationContext(subs);
    const random = makeSeededRandom(7);
    const paramsA = randomParams(random, subs.length);
    const paramsB = randomParams(random, subs.length, { withAllPass: true });

    const first = evaluateCombinedResponse(context, paramsA);
    const firstMagnitude = Float32Array.from(first.magnitude);
    const firstPhase = Float32Array.from(first.phase);

    evaluateCombinedResponse(context, paramsB);
    const again = evaluateCombinedResponse(context, paramsA);

    expect(Array.from(again.magnitude)).toEqual(Array.from(firstMagnitude));
    expect(Array.from(again.phase)).toEqual(Array.from(firstPhase));
  });

  it('decodeGenomeInto decodes exactly like decodeGenome (all-pass inclus)', () => {
    for (const allPassPerSub of [false, true]) {
      const config = {
        delay: { min: -0.005, max: 0.005 },
        frequency: { min: 20, max: 200 },
        optimization: {
          joint: {
            filtersPerSub: 2,
            filterGain: { min: -12, max: 6 },
            filterQ: { min: 0.3, max: 8 },
            filterFrequency: { min: 15, max: 250 },
            gain: { min: -12, max: 0 },
            allPassPerSub,
            allPassFrequency: { min: 10, max: 120 },
            allPassQ: { min: 0.2, max: 2 },
          },
        },
      };
      const layout = buildGenomeLayout(config, 3);
      const random = makeSeededRandom(allPassPerSub ? 99 : 11);
      const scratch = Array.from({ length: 3 }, () => ({
        delay: 0,
        polarity: 1,
        gain: 0,
        allPass: { frequency: 0, q: 0, enabled: false },
        filters: Array.from({ length: 2 }, () => ({ frequency: 0, gain: 0, q: 0 })),
      }));

      for (let trial = 0; trial < 10; trial++) {
        const genome = new Float64Array(layout.bounds.length);
        for (let d = 0; d < genome.length; d++) {
          const [min, max] = layout.bounds[d];
          genome[d] = min + random() * (max - min);
        }
        const reference = decodeGenome(layout, genome);
        const decoded = decodeGenomeInto(layout, genome, scratch);
        expect(JSON.parse(JSON.stringify(decoded))).toEqual(
          JSON.parse(JSON.stringify(reference)),
        );
      }
    }
  });
});
