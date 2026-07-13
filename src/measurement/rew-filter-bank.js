/**
 * rew-filter-bank.js — [MOTEUR] module.
 *
 * Convertit un bank de filtres REW (tableau de FilterSetting :
 * { index, type, enabled, frequency, q, gaindB, … }) en cascade de
 * BiquadFilter internes, pour la génération d'IR de l'export OCA.
 *
 * Types réalisés : PK, All pass, LP/HP (12 dB/oct, Q forcé √2/2),
 * LP1/HP1 (6 dB/oct), Notch (Q forcé 30), LS/HS et leurs variantes
 * LS 6dB/LS 12dB/HS 6dB/HS 12dB, Modal (Q dérivé du T60 visé). Chaque type
 * est validé au quantum près contre l'IR générée par REW
 * (test/fixtures/oca/filter-types.json). Tout autre type ACTIF lève une
 * erreur explicite : sur le chemin audio-critique (le fichier chargé dans
 * l'AVR), un type approximé en silence serait pire qu'un échec net.
 */

import { BiquadFilter } from '../dsp/BiquadFilter.js';
import { peakTimeSeconds, processThroughCascade } from '../dsp/impulseResponse.js';

const INERT_TYPES = new Set(['None', 'Text']);

// Valeur par défaut de REW quand un filtre Modal est posé sans t60Target.
const DEFAULT_MODAL_T60_TARGET = 300;

/**
 * @param {Array<object>} bank - FilterSetting[] tels que renvoyés par REW
 * @param {number} sampleRate - Taux d'échantillonnage cible (Hz)
 * @returns {Array<BiquadFilter>} cascade des filtres actifs
 * @throws {Error} Si un filtre actif porte un type non réalisable en interne.
 */
export function buildBiquadCascadeFromRewBank(bank, sampleRate) {
  const cascade = [];

  for (const setting of bank ?? []) {
    if (!setting || setting.enabled === false) continue;
    const type = setting.type;
    if (type === undefined || INERT_TYPES.has(type)) continue;

    const fc = setting.frequency;
    const gain = setting.gaindB ?? 0;
    const gainless = Math.abs(gain) < 0.005;
    const filter = new BiquadFilter(sampleRate);

    switch (type) {
      case 'PK':
        if (gainless) continue;
        filter.setPeaking(fc, setting.q, gain);
        break;
      case 'All pass':
        filter.setAllPass(fc, setting.q);
        break;
      case 'LP':
        filter.setLowPass(fc);
        break;
      case 'HP':
        filter.setHighPass(fc);
        break;
      case 'LP1':
        filter.setLowPass1(fc);
        break;
      case 'HP1':
        filter.setHighPass1(fc);
        break;
      case 'Notch':
        filter.setNotch(fc);
        break;
      case 'LS':
        if (gainless) continue;
        filter.setLowShelf(fc, gain, 'plain');
        break;
      case 'HS':
        if (gainless) continue;
        filter.setHighShelf(fc, gain, 'plain');
        break;
      case 'LS 6dB':
        if (gainless) continue;
        filter.setLowShelf(fc, gain, '6dB');
        break;
      case 'LS 12dB':
        if (gainless) continue;
        filter.setLowShelf(fc, gain, '12dB');
        break;
      case 'HS 6dB':
        if (gainless) continue;
        filter.setHighShelf(fc, gain, '6dB');
        break;
      case 'HS 12dB':
        if (gainless) continue;
        filter.setHighShelf(fc, gain, '12dB');
        break;
      case 'Modal':
        if (gainless) continue;
        filter.setModal(fc, gain, setting.t60Target ?? DEFAULT_MODAL_T60_TARGET);
        break;
      default:
        throw new Error(
          `Unsupported filter type "${type}" at slot ${setting.index}: the ` +
            `internal OCA filter generation realises PK, All pass, LP, HP, ` +
            `LP1, HP1, Notch, LS/HS (plain, 6dB, 12dB) and Modal filters. ` +
            `Replace or disable this filter, or extend the DSP mapping.`,
        );
    }

    cascade.push(filter);
  }

  return cascade;
}

/**
 * Réalise en interne les deux filtres de raccord posés par le bass management
 * simulé (applyCutOffFilter) : « Low pass » L-R 24 dB/oct sur le sub
 * (2 Butterworth LP 12 dB en cascade) et « High pass » BU 12 dB/oct sur
 * l'enceinte. Tout autre couple shape/pente lève une erreur explicite —
 * même philosophie que la génération OCA : sur le chemin audio-critique, un
 * filtre approximé en silence serait pire qu'un échec net.
 *
 * @param {{ type: 'Low pass'|'High pass', frequency: number,
 *           shape: string, slopedBPerOctave: number }} setting
 * @param {number} sampleRate
 * @returns {Array<BiquadFilter>}
 */
export function buildCrossoverCascade(setting, sampleRate) {
  const { type, frequency, shape, slopedBPerOctave } = setting;

  if (type === 'Low pass' && shape === 'L-R' && slopedBPerOctave === 24) {
    const first = new BiquadFilter(sampleRate);
    first.setLowPass(frequency);
    const second = new BiquadFilter(sampleRate);
    second.setLowPass(frequency);
    return [first, second];
  }
  if (type === 'High pass' && shape === 'BU' && slopedBPerOctave === 12) {
    const highPass = new BiquadFilter(sampleRate);
    highPass.setHighPass(frequency);
    return [highPass];
  }

  throw new Error(
    `Unsupported crossover filter "${type}" ${shape} ${slopedBPerOctave}dB/oct: ` +
      `the internal realisation covers Low pass L-R 24 and High pass BU 12 only.`,
  );
}

/**
 * Réponse « predicted + raccord » interne : l'IR mesurée traverse la cascade
 * du bank REW de la mesure puis, le cas échéant, le filtre de raccord —
 * l'équivalent hors REW de eqGenerate + applyCutOffFilter (parité au quantum
 * float32 démontrée sur REW 5.40 B128, y compris flag d'inversion — intégré
 * par REW dans l'export d'IR — et fenêtres MTW — sans effet sur l'IR).
 *
 * @param {{ data: ArrayLike<number>, sampleRate: number, startTime: number }} ir
 *   IR telle que lue par getImpulseResponseInfo (percent, non fenêtrée).
 * @param {Array<object>} bank - Filtres REW de la mesure (GET filters).
 * @param {object|null} crossoverSetting - Filtre de raccord
 *   (buildCrossoverCascade), ou null pour le predicted seul.
 * @returns {{ data: Float64Array, sampleRate: number, startTime: number,
 *             timeOfIRPeakSeconds: number }}
 */
export function applyBankAndCrossoverToIr(ir, bank, crossoverSetting = null) {
  const cascade = buildBiquadCascadeFromRewBank(bank ?? [], ir.sampleRate);
  if (crossoverSetting) {
    cascade.push(...buildCrossoverCascade(crossoverSetting, ir.sampleRate));
  }

  const filtered = {
    data: processThroughCascade(ir.data, cascade),
    sampleRate: ir.sampleRate,
    startTime: ir.startTime ?? 0,
  };
  return { ...filtered, timeOfIRPeakSeconds: peakTimeSeconds(filtered) };
}
