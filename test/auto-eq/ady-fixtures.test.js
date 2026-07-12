/**
 * Validation du corpus de fixtures multi-positions (phase 0 du plan qualité
 * audio) — data-driven sur les manifest.json de test/fixtures/ady/<système>/.
 *
 * Encode les faits mesurés qui fondent le diagnostic de référentiel
 * (PLAN-QUALITE-AUDIO.md) :
 *   - le fenêtrage Optimized MTW retire de l'énergie au-dessus de ~300 Hz sur
 *     les voies large bande (D(f) = brute − fenêtrée > 0, croissant) ;
 *   - le Vector average est sous le RMS(+phase) average (décorrélation
 *     inter-positions, biais large bande) ;
 *   - la variance inter-positions est significative (matière de la phase 3).
 * Ces faits servent de référence aux tests des phases 1-3.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';

import {
  parseREWFile,
  createNearestSampler,
  toFrequencyResponse,
} from './test-config.js';
import {
  variableSmoothMagnitude,
  calculatePerceptualRMSError,
  meanLevelDifference,
} from './perceptual-metrics.js';

const ROOT = './test/fixtures/ady';
const AVG_SLUGS = ['vector-avg', 'rms-avg', 'db-avg'];

const systems = readdirSync(ROOT, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(`${ROOT}/${entry.name}/manifest.json`))
  .map(entry => ({
    name: entry.name,
    dir: `${ROOT}/${entry.name}`,
    manifest: JSON.parse(readFileSync(`${ROOT}/${entry.name}/manifest.json`, 'utf-8')),
  }));

const sampler = data => createNearestSampler(toFrequencyResponse(data));

const positionNames = count =>
  Array.from({ length: count }, (_, i) => `P${String(i + 1).padStart(2, '0')}`);

const isFullRange = channelInfo => (channelInfo.rolloffHz ?? 20000) >= 10000;

test('le corpus contient au moins les 4 systèmes attendus', () => {
  const names = systems.map(s => s.name);
  for (const expected of ['kef-3pos', 'prociprince-8pos', 'tony61-6pos', 'barmatic-6pos']) {
    assert.ok(names.includes(expected), `système manquant: ${expected}`);
  }
});

// ─── Intégrité ───────────────────────────────────────────────────────────────

test('toutes les fixtures se chargent avec une grille 96 PPO complète', () => {
  for (const { name, dir, manifest } of systems) {
    for (const [ch, info] of Object.entries(manifest.channels)) {
      const files = [
        ...positionNames(info.positions).map(p => `${ch}_${p}`),
        ...AVG_SLUGS.flatMap(s => [`${ch}_${s}_raw`, `${ch}_${s}_mtw`]),
      ];
      for (const fileName of files) {
        const data = parseREWFile(`${dir}/${fileName}.txt`);
        assert.ok(data.length >= 1000, `${name}/${fileName}: ${data.length} points`);
        assert.ok(data[0].freq < 25, `${name}/${fileName} doit commencer sous 25 Hz`);
        assert.ok(data.at(-1).freq > 16000, `${name}/${fileName} doit dépasser 16 kHz`);
        for (const point of data) {
          assert.ok(
            Number.isFinite(point.spl),
            `${name}/${fileName}: SPL non fini à ${point.freq}`,
          );
        }
      }
    }
  }
});

// ─── Faits du diagnostic de référentiel ─────────────────────────────────────

test('MTW retire de l’énergie au-dessus de 300 Hz (croissant avec la fréquence)', () => {
  // Valeurs mesurées sur le corpus (2026-07-12) : D(300-3000) = 0.96 à 2.40 dB
  // partout, sauf la surround kef SBR (0.22-0.25, enceinte proche → peu d'excès
  // réverbéré). D(40-300) ≤ 0.43 partout.
  const FRONT_CHANNELS = new Set(['FL', 'C', 'FR']);
  for (const { name, dir, manifest } of systems) {
    for (const [ch, info] of Object.entries(manifest.channels)) {
      for (const slug of AVG_SLUGS) {
        const raw = parseREWFile(`${dir}/${ch}_${slug}_raw.txt`);
        const mtwFn = sampler(parseREWFile(`${dir}/${ch}_${slug}_mtw.txt`));
        const dMid = meanLevelDifference(raw, mtwFn, 300, 3000);
        const dBass = meanLevelDifference(raw, mtwFn, 40, 300);
        assert.ok(
          dMid > 0.15,
          `${name}/${ch} ${slug}: D(300-3000)=${dMid.toFixed(2)} dB attendu > 0.15`,
        );
        assert.ok(
          dMid > dBass,
          `${name}/${ch} ${slug}: D doit croître (mid ${dMid.toFixed(2)} vs bass ${dBass.toFixed(2)})`,
        );
        if (FRONT_CHANNELS.has(ch) && isFullRange(info)) {
          assert.ok(
            dMid > 0.8,
            `${name}/${ch} ${slug}: front large bande, D(300-3000)=${dMid.toFixed(2)} dB attendu > 0.8`,
          );
        }
      }
    }
  }
});

test('MTW ne retire presque rien sous 300 Hz (fenêtres longues)', () => {
  for (const { name, dir, manifest } of systems) {
    for (const [ch] of Object.entries(manifest.channels)) {
      for (const slug of AVG_SLUGS) {
        const raw = parseREWFile(`${dir}/${ch}_${slug}_raw.txt`);
        const mtwFn = sampler(parseREWFile(`${dir}/${ch}_${slug}_mtw.txt`));
        const dBass = meanLevelDifference(raw, mtwFn, 40, 300);
        assert.ok(
          Math.abs(dBass) < 1.5,
          `${name}/${ch} ${slug}: |D(40-300)|=${Math.abs(dBass).toFixed(2)} dB attendu < 1.5`,
        );
      }
    }
  }
});

test('le Vector average est sous le RMS average (décorrélation inter-positions)', () => {
  for (const { name, dir, manifest } of systems) {
    for (const [ch] of Object.entries(manifest.channels)) {
      const vec = parseREWFile(`${dir}/${ch}_vector-avg_raw.txt`);
      const rmsFn = sampler(parseREWFile(`${dir}/${ch}_rms-avg_raw.txt`));
      const diff = meanLevelDifference(vec, rmsFn, 40, 16000);
      assert.ok(
        diff < -0.3,
        `${name}/${ch}: vector − rms = ${diff.toFixed(2)} dB attendu < −0.3`,
      );
    }
  }
});

test('la variance inter-positions est significative (fondement de la phase 3)', () => {
  for (const { name, dir, manifest } of systems) {
    for (const [ch, info] of Object.entries(manifest.channels)) {
      const positions = positionNames(info.positions).map(p =>
        sampler(parseREWFile(`${dir}/${ch}_${p}.txt`)),
      );
      const reference = parseREWFile(`${dir}/${ch}_rms-avg_raw.txt`);
      let stdSum = 0;
      let count = 0;
      for (const { freq } of reference) {
        if (freq < 40 || freq > 16000) continue;
        const values = positions.map(fn => fn(freq));
        const mean = values.reduce((s, v) => s + v, 0) / values.length;
        stdSum += Math.sqrt(
          values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length,
        );
        count++;
      }
      const meanStd = stdSum / count;
      assert.ok(meanStd > 0.5, `${name}/${ch}: σ moyen ${meanStd.toFixed(2)} dB attendu > 0.5`);
      assert.ok(meanStd < 8, `${name}/${ch}: σ moyen ${meanStd.toFixed(2)} dB anormalement élevé`);
    }
  }
});

// ─── Sanity du lissage variable (métrique perceptuelle) ────────────────────

test('variableSmoothMagnitude préserve une courbe constante', () => {
  const freqs = [];
  for (let f = 20; f <= 20000; f *= 1.03) freqs.push(f);
  const flat = freqs.map(() => 75);
  const smoothed = variableSmoothMagnitude(freqs, flat);
  for (const v of smoothed) {
    assert.ok(Math.abs(v - 75) < 1e-9);
  }
});

test('variableSmoothMagnitude lisse plus fort en HF qu’en BF', () => {
  const freqs = [];
  for (let f = 20; f <= 20000; f *= Math.pow(2, 1 / 96)) freqs.push(f);
  const rippled = freqs.map((f, i) => 75 + 2 * Math.sin(i / 1.3));
  const smoothed = variableSmoothMagnitude(freqs, rippled);
  const residualRipple = (lo, hi) => {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] < lo || freqs[i] > hi) continue;
      sum += Math.abs(smoothed[i] - 75);
      count++;
    }
    return sum / count;
  };
  const bassRipple = residualRipple(40, 80);
  const highRipple = residualRipple(8000, 16000);
  assert.ok(
    highRipple < bassRipple / 2,
    `ripple HF ${highRipple.toFixed(3)} attendu ≪ ripple BF ${bassRipple.toFixed(3)}`,
  );
});

test('calculatePerceptualRMSError ignore l’ondulation fine HF mais voit un écart large', () => {
  const freqs = [];
  for (let f = 1000; f <= 16000; f *= Math.pow(2, 1 / 96)) freqs.push(f);
  const target = () => 75;

  const fineRipple = freqs.map((f, i) => ({ freq: f, spl: 75 + 2 * Math.sin(i / 1.3) }));
  const ripplePerceptual = calculatePerceptualRMSError(fineRipple, target, 2000, 16000);

  const broadShift = freqs.map(f => ({ freq: f, spl: 77 }));
  const shiftPerceptual = calculatePerceptualRMSError(broadShift, target, 2000, 16000);

  assert.ok(
    ripplePerceptual < 0.8,
    `ondulation fine: ${ripplePerceptual.toFixed(2)} dB attendu < 0.8`,
  );
  assert.ok(
    Math.abs(shiftPerceptual - 2) < 0.05,
    `écart large: ${shiftPerceptual.toFixed(2)} dB attendu ≈ 2`,
  );
});
