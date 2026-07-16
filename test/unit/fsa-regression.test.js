/**
 * Régression FSA (Find Sub Alignment) — fige la chaîne ACTUELLE de
 * produceAligned rejouée hors ligne sur les goldens align-sub : IR predicted
 * BRUTES (doctrine « mesures en brut »), ancre de pré-positionnement
 * junctionPeakSeconds (pics des IR vues à travers la paire LR24|LR24)
 * − T/16, xcorr interne en fenêtre avant [0, T/2] (repli contraint clampé,
 * 2026-07-16), « somme vraie » pondérée pour les multi-subs.
 *
 * Deux niveaux de garde, mesurés au banc décisionnel « délai FSA vs délai
 * loss-optimal » du 2026-07-16 (clôture du chantier all-pass raccord) :
 *
 *  1. CARACTÉRISATION — le délai net appliqué au sub (τ, ms d'avance) et la
 *     polarité par cas : toute dérive = changement de l'ancre, de la
 *     fenêtre, du clamp ou de la xcorr. Un changement INTENTIONNEL du
 *     comportement FSA doit re-dériver ces baselines (décision tracée,
 *     même règle que les goldens).
 *  2. PROPRIÉTÉ de loss-optimalité — dans son lobe (±T/4, polarité FSA), le
 *     délai FSA reste quasi loss-optimal pour la perte de sommation moyenne
 *     LR24|LR24 sur [fc/2, 2fc] (sur système réel : médiane 0,04 dB, 0,00
 *     au raccord motivant). Le `gapDb` par cas borne ce que un critère
 *     loss-min gagnerait sur la xcorr À CYCLE ET POLARITÉ IDENTIQUES — s'il
 *     grossit, le critère xcorr a régressé même si la parité est re-baselinée.
 *
 * Les baselines portent aussi les invariances de la chaîne (testées à
 * part) : sub inversé → même τ, polarité flippée, même gap (la polarité est
 * une nuisance) ; offset t=0 → τ décalé d'autant, même gap (référentiel
 * temporel absolu).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  applyBankAndCrossoverToIr,
  buildCrossoverCascade,
  simulationSpeakerHighPassSetting,
  subLowPassSetting,
} from '../../src/measurement/rew-filter-bank.js';
import {
  combineImpulseResponses,
  peakTimeSeconds,
  processThroughCascade,
} from '../../src/dsp/impulseResponse.js';
import { complexSpectrumAt, logSpacedFrequencies } from '../../src/dsp/spectrum.js';
import { getCascadeComplexResponse } from '../../src/dsp/biquadResponse.js';
import {
  alignImpulseResponses,
  crossoverAlignmentWindowMs,
} from '../../src/dsp/ir-align.js';

const golden = JSON.parse(
  readFileSync(new URL('../fixtures/align-sub/goldens.json', import.meta.url), 'utf-8'),
);

const SAMPLE_RATE = 48000;
// Grille d'évaluation de la perte : 48 ppo, couvre [fc/2, 2fc] du plus petit
// candidat des goldens (fc=40 → 20 Hz). Array.from : Float64Array.map
// coercerait les objets complexes en NaN.
const GRID = Array.from(logSpacedFrequencies(20, 500, 48));

// Baselines mesurées à la création (2026-07-16, clamp inclus). τ à ±0.02 ms
// (un échantillon), gap borné à baseline + 0.10 dB.
const TAU_TOLERANCE_MS = 0.02;
const GAP_SLACK_DB = 0.1;
const BASELINES = [
  { label: 'kef.FL↔kef.SW1', fc: 80, tauMs: 25.9028, invertB: false, gapDb: 0.077 },
  { label: 'kef.C↔kef.SW1', fc: 120, tauMs: 14.14, invertB: false, gapDb: 0.69 },
  { label: 'kef.TFL↔kef.SW1', fc: 100, tauMs: 23.6827, invertB: false, gapDb: 1.754 },
  { label: 'kef.FL↔kef.SW1inv', fc: 80, tauMs: 25.9028, invertB: true, gapDb: 0.077 },
  { label: 'kef.FL↔kef.SW1off', fc: 80, tauMs: 22.8028, invertB: false, gapDb: 0.077 },
  { label: 'kef.FL↔kef.SW2', fc: 80, tauMs: 68.9027, invertB: true, gapDb: 0.765 },
  { label: 'kef.FL↔kef.SW1', fc: 60, tauMs: 28.941, invertB: false, gapDb: 0.002 },
  { label: 'bar.FL↔bar.SW1', fc: 80, tauMs: 27.0063, invertB: false, gapDb: 0.481 },
  { label: 'bar.TML↔bar.SW1', fc: 120, tauMs: 38.3763, invertB: true, gapDb: 0.783 },
  { label: 'bar.FL↔bar.SW1', fc: 40, tauMs: 35.0368, invertB: false, gapDb: 0.882 },
  { label: 'somme m1', fc: 80, tauMs: 58.3754, invertB: false, gapDb: 0 },
  { label: 'somme m2', fc: 120, tauMs: 10.474, invertB: true, gapDb: 0.007 },
  { label: 'somme m3', fc: 80, tauMs: 22.6662, invertB: false, gapDb: 0 },
];

// ─── chaîne FSA (arithmétique exacte de produceAligned, hors borne AVR) ─────

function junctionPeakSeconds(ir, crossoverSetting) {
  const cascade = buildCrossoverCascade(crossoverSetting, ir.sampleRate);
  return peakTimeSeconds({
    data: processThroughCascade(ir.data, cascade),
    sampleRate: ir.sampleRate,
    startTime: ir.startTime ?? 0,
  });
}

function fsaAlignment(speakerIr, subSumIr, fc) {
  const gapSeconds =
    junctionPeakSeconds(subSumIr, subLowPassSetting(fc)) -
    junctionPeakSeconds(speakerIr, simulationSpeakerHighPassSetting(fc));
  const preSeconds = gapSeconds - 1 / (16 * fc); // cutoffPeriod / 16
  const shiftedSub = {
    data: subSumIr.data,
    sampleRate: subSumIr.sampleRate,
    startTime: (subSumIr.startTime ?? 0) - preSeconds,
  };
  const { maxMs } = crossoverAlignmentWindowMs(fc, { forward: true });
  const align = alignImpulseResponses(speakerIr, shiftedSub, {
    frequency: fc,
    minDelayMs: 0,
    maxDelayMs: Math.round(maxMs * 100) / 100,
  });
  return {
    tauMs: (preSeconds - align.delayMs / 1000) * 1000,
    invertB: align.invertB,
    withinBounds: align.withinBounds,
  };
}

// ─── perte de sommation au raccord LR24|LR24 ────────────────────────────────

const cmul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });

function bandChannels(speakerIr, subSumIr, fc) {
  const hpCascade = buildCrossoverCascade(simulationSpeakerHighPassSetting(fc), SAMPLE_RATE);
  const lpCascade = buildCrossoverCascade(subLowPassSetting(fc), SAMPLE_RATE);
  const specA = complexSpectrumAt(speakerIr, GRID);
  const specB = complexSpectrumAt(subSumIr, GRID);
  const out = [];
  for (let i = 0; i < GRID.length; i++) {
    const f = GRID[i];
    if (f < fc / 2 || f > fc * 2) continue;
    const a = cmul(
      { re: specA.re[i], im: specA.im[i] },
      getCascadeComplexResponse(hpCascade, f, SAMPLE_RATE),
    );
    const b = cmul(
      { re: specB.re[i], im: specB.im[i] },
      getCascadeComplexResponse(lpCascade, f, SAMPLE_RATE),
    );
    out.push({ f, a, b, ref: Math.hypot(a.re, a.im) + Math.hypot(b.re, b.im) });
  }
  return out;
}

/** Perte moyenne (dB) vs sommation parfaitement cohérente, sub avancé de tauMs. */
function meanLossAt(channels, tauMs, sign) {
  const w = 2 * Math.PI * (tauMs / 1000);
  let loss = 0;
  for (const { f, a, b, ref } of channels) {
    const angle = w * f;
    const bRe = b.re * Math.cos(angle) - b.im * Math.sin(angle);
    const bIm = b.re * Math.sin(angle) + b.im * Math.cos(angle);
    const sumMag = Math.hypot(a.re + sign * bRe, a.im + sign * bIm);
    loss += 20 * Math.log10(ref / Math.max(sumMag, 1e-15));
  }
  return channels.length ? loss / channels.length : NaN;
}

/** Perte minimale dans le lobe FSA : ±T/4 autour de tauMs, polarité fixée. */
function bestLossInLobe(channels, centerMs, fc, sign) {
  let best = { loss: Infinity, tauMs: centerMs };
  const scan = (from, to, step) => {
    for (let tau = from; tau <= to + 1e-9; tau += step) {
      const loss = meanLossAt(channels, tau, sign);
      if (loss < best.loss) best = { loss, tauMs: tau };
    }
  };
  const halfSpan = 250 / fc;
  scan(centerMs - halfSpan, centerMs + halfSpan, 0.02);
  scan(best.tauMs - 0.024, best.tauMs + 0.024, 0.002);
  return best;
}

// ─── corpus : évaluation à la demande (une fois par cas) ────────────────────

const irCache = new Map();
function goldenPair(label, fc) {
  const key = `${label}@${fc}`;
  if (irCache.has(key)) return irCache.get(key);

  let pair;
  const sumCase = (golden.sumCases ?? []).find(c => `somme ${c.label}` === label);
  if (sumCase) {
    pair = {
      speakerIr: applyBankAndCrossoverToIr(golden.irs[`sum.${sumCase.label}.speaker`], [], null),
      subSumIr: combineImpulseResponses(
        Array.from(
          { length: sumCase.subCount },
          (_, i) => golden.irs[`sum.${sumCase.label}.sub${i}`],
        ),
        sumCase.weightsDb,
      ),
    };
  } else {
    const c = golden.cases.find(x => `${x.speaker}↔${x.sub}` === label && x.fc === fc);
    pair = {
      speakerIr: applyBankAndCrossoverToIr(golden.irs[c.speaker], c.speakerBank, null),
      subSumIr: applyBankAndCrossoverToIr(golden.irs[c.sub], c.subBank, null),
    };
  }
  irCache.set(key, pair);
  return pair;
}

const resultCache = new Map();
function fsaResult(label, fc) {
  const key = `${label}@${fc}`;
  if (resultCache.has(key)) return resultCache.get(key);

  const { speakerIr, subSumIr } = goldenPair(label, fc);
  const fsa = fsaAlignment(speakerIr, subSumIr, fc);
  const channels = bandChannels(speakerIr, subSumIr, fc);
  const sign = fsa.invertB ? -1 : 1;
  const lossFsa = meanLossAt(channels, fsa.tauMs, sign);
  const result = {
    ...fsa,
    gapDb: lossFsa - bestLossInLobe(channels, fsa.tauMs, fc, sign).loss,
  };
  resultCache.set(key, result);
  return result;
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('régression FSA — chaîne produceAligned sur les goldens align-sub', () => {
  for (const base of BASELINES) {
    it(`${base.label} @${base.fc} Hz : τ, polarité et loss-optimalité du lobe`, () => {
      const r = fsaResult(base.label, base.fc);
      expect(r.withinBounds).toBe(true);
      expect(Math.abs(r.tauMs - base.tauMs)).toBeLessThanOrEqual(TAU_TOLERANCE_MS);
      expect(r.invertB).toBe(base.invertB);
      // gap ≥ 0 par construction (au pas de la grille de scan près)
      expect(r.gapDb).toBeGreaterThanOrEqual(-0.01);
      expect(r.gapDb).toBeLessThanOrEqual(base.gapDb + GAP_SLACK_DB);
    });
  }

  it('invariance : sub inversé → même τ, polarité flippée, même gap', () => {
    const ref = fsaResult('kef.FL↔kef.SW1', 80);
    const inv = fsaResult('kef.FL↔kef.SW1inv', 80);
    expect(Math.abs(inv.tauMs - ref.tauMs)).toBeLessThanOrEqual(0.001);
    expect(inv.invertB).toBe(!ref.invertB);
    expect(Math.abs(inv.gapDb - ref.gapDb)).toBeLessThanOrEqual(0.001);
  });

  it('invariance : offset t=0 → τ décalé de l’offset, même polarité, même gap', () => {
    const ref = fsaResult('kef.FL↔kef.SW1', 80);
    const off = fsaResult('kef.FL↔kef.SW1off', 80);
    // l’offset t=0 du golden (3.1 ms) se retrouve intégralement dans τ
    expect(Math.abs(ref.tauMs - off.tauMs - 3.1)).toBeLessThanOrEqual(0.005);
    expect(off.invertB).toBe(ref.invertB);
    expect(Math.abs(off.gapDb - ref.gapDb)).toBeLessThanOrEqual(0.001);
  });
});
