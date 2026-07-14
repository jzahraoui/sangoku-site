/**
 * Decontaminated BusinessTools (ADR 002). The Knockout
 * BusinessTools drives the measurement objects through their methods; here the
 * same sequences run over the flat MeasurementRecords by routing writes to the
 * operations service. The internally-created measurements (predicted sums,
 * divisions) are records too, so ops keep working down the chain.
 *
 * [ORCHESTRATION] service — no Knockout, no DOM.
 *
 * Dependencies:
 * - `operations`: createMeasurementOperations instance.
 * - `session`: RewSession (rewMeasurements, analyseApiResponse, removeMeasurements,
 *   removeMeasurement, removeMeasurementUuid, findMeasurementByUuid).
 * - `workingSettingsConfig()`, `irWindowWidthsFor(m)`: per-item working-settings
 *   context (same values the KO item methods derived from the viewmodel).
 * - `displayTitleOf(m)`: label used in the sum's notes (defaults to the title).
 */

import {
  LPF_REVERTED_SUFFIX,
  RESULT_PREFIX,
} from '../measurement/measurement-info.js';
import {
  splForAvrOf,
  splOffsetDeltadB,
} from '../measurement/measurement-export.js';
import {
  metersToSeconds,
  secondsToMeters,
} from '../measurement/measurement-calculations.js';
import {
  applyBankAndCrossoverToIr,
  buildCrossoverCascade,
} from '../measurement/rew-filter-bank.js';
import { combineImpulseResponses } from '../dsp/impulseResponse.js';
import {
  alignImpulseResponses,
  crossoverAlignmentWindowMs,
} from '../dsp/ir-align.js';
import { complexSpectrumAt, logSpacedFrequencies } from '../dsp/spectrum.js';
import { getCascadeComplexResponse } from '../dsp/biquadResponse.js';

const unwrap = value => (typeof value === 'function' ? value() : value);

// Bande d'évaluation de la sommation LFE + fronts : le contenu LFE des pistes
// de films s'arrête à 120 Hz (borne haute de la bande utile) ; sous 20 Hz le
// passe-bas candidat n'a plus d'effet discriminant.
const LFE_EVALUATION_MIN_HZ = 20;
const LFE_EVALUATION_MAX_HZ = 120;
const LFE_EVALUATION_POINTS_PER_OCTAVE = 16;
// Plancher numérique des magnitudes avant passage au log — les IR predicted
// ne sont jamais nulles sur la bande, le garde ne sert qu'aux cas dégénérés.
const MAGNITUDE_EPSILON = 1e-12;



function createBusinessTools({
  operations,
  session,
  workingSettingsConfig = () => undefined,
  irWindowWidthsFor = () => undefined,
  displayTitleOf = m => unwrap(m.title),
  // produceAligned context (Find Sub Alignment / align-sub). Providers mirror the
  // per-item values the KO BusinessTools read from the item/viewmodel: the group
  // crossover, the position's predicted LFE, the remaining distance headroom, the
  // AVR speed of sound and the alignment-tool search (alignment service).
  crossoverForSpeaker = m => unwrap(m.crossover),
  relatedLfeFor = m => unwrap(m.relatedLfeMeasurement),
  subDistanceLeftBeforeError = () => Infinity,
  speedOfSound = () => 343,
  findAligment = async () => {
    throw new Error('findAligment is not wired');
  },
  // createMeasurementPreview context (per-speaker preview). Providers mirror the
  // KO item getters used in the title / sub guards.
  positionFor = m => unwrap(m.position),
  isSubOf = m => unwrap(m.isSub),
  isUnknownOf = m => Boolean(m.isUnknownChannel),
  log = { info() {}, warn() {}, debug() {} },
}) {
  const rew = () => session.rewMeasurements;
  const sessionContext = {
    analyseApiResponse: result => session.analyseApiResponse(result),
    removeMeasurements: items => session.removeMeasurements(items),
    removeMeasurementUuid: uuid => session.removeMeasurementUuid(uuid),
    findMeasurementByUuid: uuid => session.findMeasurementByUuid(uuid),
  };

  /**
   * Sum a list of measurements into a single predicted response (parity with
   * BusinessTools.createsSum). Generates one predicted measurement per input,
   * folds them with arithmetic sums, titles the result and cleans up.
   */
  async function createsSum(itemList, title, deletePredicted = true) {
    if (!Array.isArray(itemList) || !itemList.length) {
      throw new Error('Parameter must be a non-empty array');
    }

    const generatedPredicted = [];
    const intermediateSums = [];

    try {
      for (const item of itemList) {
        await operations.removeWorkingSettings(rew(), item, irWindowWidthsFor(item));
        await operations.resetTargetSettings(rew(), item);
        generatedPredicted.push(
          await operations.producePredictedMeasurement(rew(), item, sessionContext),
        );
        await operations.applyWorkingSettings(rew(), item, workingSettingsConfig());
      }

      let result = generatedPredicted[0];
      for (let index = 1; index < generatedPredicted.length; index++) {
        intermediateSums.push(result);
        result = await operations.arithmeticSum(
          rew(),
          result,
          generatedPredicted[index],
          sessionContext,
        );
      }

      const titles = itemList.map(item => displayTitleOf(item));
      await operations.setTitle(rew(), result, title, `sum from:\n${titles.join('\n')}`);
      await operations.applyWorkingSettings(rew(), result, workingSettingsConfig());

      return result;
    } finally {
      await session.removeMeasurements(intermediateSums);
      if (deletePredicted && generatedPredicted.length > 1) {
        await session.removeMeasurements(generatedPredicted);
      }
    }
  }

  /**
   * Create a temporary Low-pass filter measurement from a sub (parity with
   * BusinessTools.createLowPassFilter): set an LR24 low-pass at index 21,
   * generate the filter measurement, then restore the original filters.
   */
  async function createLowPassFilter(measurement, freq) {
    const originalFilters = await operations.getFilters(rew(), measurement);

    const lowPassFilterSet = Array.from({ length: 20 }, (_, index) => ({
      index: index + 1,
      type: 'None',
      enabled: true,
      isAuto: false,
    }));
    lowPassFilterSet.push(
      {
        index: 21,
        type: 'Low pass',
        enabled: true,
        isAuto: false,
        frequency: freq,
        shape: 'L-R',
        slopedBPerOctave: 24,
      },
      { index: 22, type: 'None', enabled: true, isAuto: false },
    );

    await operations.setFilters(rew(), measurement, lowPassFilterSet);

    // ops.generateFilterMeasurement reads MeasurementItem-derived fields
    // (splresidual/crossover); supply them for the record.
    const filterSource = {
      uuid: measurement.uuid,
      title: measurement.title,
      splOffsetdB: measurement.splOffsetdB,
      splresidual: splOffsetDeltadB(measurement) - splForAvrOf(measurement),
      crossover: 0, // subs have no crossover
    };
    const filter = await operations.generateFilterMeasurement(
      rew(),
      filterSource,
      sessionContext,
    );

    await operations.setFilters(rew(), measurement, originalFilters);

    return filter;
  }

  /**
   * Divide each sub by a shared low-pass filter to cancel the AVR LFE filter
   * (parity with BusinessTools.revertLfeFilterProccessList).
   */
  async function revertLfeFilterProccessList(subResponses, freq, replaceOriginal = false) {
    if (!subResponses?.length) {
      throw new Error('No subwoofer measurements found');
    }
    if (!freq || typeof freq !== 'number') {
      throw new TypeError('Frequency must be a number');
    }

    const lowPassFilter = await createLowPassFilter(subResponses[0], freq);
    const resultsUuids = [];

    for (const subResponse of subResponses) {
      const originalState = {
        inverted: unwrap(subResponse.inverted),
        delay: unwrap(subResponse.cumulativeIRShiftSeconds),
        filters: await operations.getFilters(rew(), subResponse),
      };

      await operations.setInverted(rew(), subResponse, false);
      await operations.setcumulativeIRShiftSeconds(rew(), subResponse, 0);

      const division = await operations.arithmeticADividedByB(
        rew(),
        subResponse,
        lowPassFilter,
        sessionContext,
        null,
        null,
        freq * 2,
      );

      if (!replaceOriginal) {
        await operations.setInverted(rew(), subResponse, originalState.inverted);
        await operations.setcumulativeIRShiftSeconds(rew(), subResponse, originalState.delay);
      }

      const newTitle = replaceOriginal
        ? unwrap(subResponse.title)
        : unwrap(subResponse.title) + LPF_REVERTED_SUFFIX;
      await operations.setTitle(rew(), division, newTitle);
      await operations.setInverted(rew(), division, originalState.inverted);
      await operations.setcumulativeIRShiftSeconds(rew(), division, originalState.delay);
      await operations.setFilters(rew(), division, originalState.filters);
      division.revertLfeFrequency = freq;

      resultsUuids.push(division.uuid);
    }

    await session.removeMeasurement(lowPassFilter);
    if (replaceOriginal) {
      await session.removeMeasurements(subResponses);
    }
    return resultsUuids;
  }

  /**
   * Revert the AVR low-pass filter on the subs (parity with
   * BusinessTools.revertLfeFilterProccess): drop previous reverted results, then
   * process the original subs.
   */
  async function revertLfeFilterProccess(
    subsMeasurements,
    freq,
    replaceOriginal = false,
    deletePrevious = true,
  ) {
    const previous = subsMeasurements.filter(response =>
      unwrap(response.title).includes(LPF_REVERTED_SUFFIX),
    );
    if (deletePrevious) {
      await session.removeMeasurements(previous);
    }
    const originals = subsMeasurements.filter(
      response => !unwrap(response.title).includes(LPF_REVERTED_SUFFIX),
    );
    await revertLfeFilterProccessList(originals, freq, replaceOriginal);
  }

  /**
   * Apply the crossover pair (LR24 low-pass on the sub, BU12 high-pass on the
   * speaker) and return the predicted filtered responses (parity with
   * BusinessTools.applyCutOffFilter). The filters are restored to None in the
   * finally block; a 0 crossover falls back to plain response copies.
   */
  async function applyCutOffFilter(sub, speaker, cutOffFrequency) {
    if (cutOffFrequency === 0) {
      return {
        PredictedLfeFiltered: await operations.responseCopy(rew(), sub),
        predictedSpeakerFiltered: await operations.responseCopy(rew(), speaker),
      };
    }

    // make sure the equaliser is Generic to allow Low pass and High pass filters
    // (defaults mirror the KO item's rewEq.defaultEqtSettings).
    const equaliserDefaults = session.rewEq?.defaultEqtSettings;
    await operations.resetEqualiser(rew(), sub, equaliserDefaults);
    await operations.resetEqualiser(rew(), speaker, equaliserDefaults);

    const subIndex = await operations.getFreeXFilterIndex(rew(), sub, equaliserDefaults);
    const speakerIndex = await operations.getFreeXFilterIndex(
      rew(),
      speaker,
      equaliserDefaults,
    );
    if (subIndex === -1 || speakerIndex === -1) {
      throw new Error('Cannot find free filter index');
    }

    try {
      await operations.setSingleFilter(
        rew(),
        sub,
        {
          index: subIndex,
          enabled: true,
          isAuto: false,
          type: 'Low pass',
          frequency: cutOffFrequency,
          shape: 'L-R',
          slopedBPerOctave: 24,
        },
      );
      await operations.setSingleFilter(
        rew(),
        speaker,
        {
          index: speakerIndex,
          enabled: true,
          isAuto: false,
          type: 'High pass',
          frequency: cutOffFrequency,
          shape: 'BU',
          slopedBPerOctave: 12,
        },
      );

      const PredictedLfeFiltered = await operations.producePredictedMeasurement(
        rew(),
        sub,
        sessionContext,
      );
      const predictedSpeakerFiltered = await operations.producePredictedMeasurement(
        rew(),
        speaker,
        sessionContext,
      );

      return { PredictedLfeFiltered, predictedSpeakerFiltered };
    } finally {
      await operations.setSingleFilter(
        rew(),
        sub,
        { index: subIndex, type: 'None', enabled: true, isAuto: false },
      );
      await operations.setSingleFilter(
        rew(),
        speaker,
        { index: speakerIndex, type: 'None', enabled: true, isAuto: false },
      );
    }
  }

  function validateInputs(PredictedLfe, speakerItem, cuttOffFrequency) {
    if (!speakerItem) throw new Error(`Please select a speaker item`);
    if (!PredictedLfe) throw new Error(`Cannot find predicted LFE`);
    if (cuttOffFrequency === 0) {
      log.debug('Speaker are full range, no cuttoff frequency');
    }
    if (cuttOffFrequency < 20 || cuttOffFrequency > 250) {
      throw new Error('CuttOffFrequency must be between 20Hz and 250Hz');
    }
    if (!PredictedLfe.haveImpulseResponse) {
      throw new Error('Invalid PredictedLfe object or missing cumulativeIRShiftSeconds');
    }
  }

  async function applyTimeOffsetToSubs(offset, subResponses, mustBeInverted) {
    if (!subResponses || subResponses.length < 1) {
      return;
    }
    for (const subResponse of subResponses) {
      await operations.addIROffsetSeconds(rew(), subResponse, offset);
      if (mustBeInverted) {
        await operations.toggleInversion(rew(), subResponse);
      }
    }
  }

  // Filtres de raccord du bass management simulé (mêmes valeurs que
  // applyCutOffFilter) — réalisés en interne par buildCrossoverCascade.
  const subLowPassSetting = frequency => ({
    type: 'Low pass',
    frequency,
    shape: 'L-R',
    slopedBPerOctave: 24,
  });
  const speakerHighPassSetting = frequency => ({
    type: 'High pass',
    frequency,
    shape: 'BU',
    slopedBPerOctave: 12,
  });

  /**
   * IR filtrées au raccord de l'enceinte et du LFE, calculées en interne —
   * plus aucune mesure predicted temporaire dans REW. L'IR predicted de
   * chaque mesure est lue telle que REW la calcule (/eq/impulse-response,
   * identique bit à bit au eqGenerate) ; seul le raccord est réalisé en
   * local. Côté LFE : la « somme vraie » pondérée des subs réels quand la
   * liste est fournie (référentiel canonique — le même état des subs donne
   * toujours le même résultat, quelle que soit l'histoire de la projection),
   * sinon la projection. Parité golden REW réel : npm run
   * test:align-sub-parity.
   */
  async function crossoverFilteredIrPair(
    PredictedLfe,
    speakerItem,
    cuttOffFrequency,
    subResponses = null,
  ) {
    // 0 Hz (enceinte full range) : pas de filtre de raccord, IR predicted
    // seules — parité avec le court-circuit à 0 de applyCutOffFilter
    // (responseCopy).
    const speakerCrossover = cuttOffFrequency
      ? speakerHighPassSetting(cuttOffFrequency)
      : null;
    const subCrossover = cuttOffFrequency ? subLowPassSetting(cuttOffFrequency) : null;
    const speakerFiltered = await operations.getCrossoverFilteredIr(
      rew(),
      speakerItem,
      speakerCrossover,
    );
    const PredictedLfeFiltered = subResponses?.length
      ? await operations.getCombinedSubsCrossoverFilteredIr(
          rew(),
          subResponses,
          subCrossover,
        )
      : await operations.getCrossoverFilteredIr(rew(), PredictedLfe, subCrossover);
    return { PredictedLfeFiltered, speakerFiltered };
  }

  /**
   * Balaie une liste de crossovers candidats et renvoie, pour UNE enceinte, le
   * required shift à chacun. Les IR predicted (enceinte + « somme vraie »
   * pondérée des subs, ou LFE prédictif en repli) sont lues **une seule fois** ;
   * seul le filtre de raccord (BU12 HP / LR24 LP) est réappliqué localement par
   * candidat (cascade de biquads) — donc pas de régénération de filtres ni
   * d'aller-retour REW par crossover (perf). Aucune écriture REW, aucune mutation
   * (ni inversion, ni filtres). Même calcul que checkAlignment :
   * `alignImpulseResponses(subFiltered, speakerFiltered, {frequency, fenêtre ±T/4})`
   * (via crossoverAlignmentWindowMs, source unique partagée).
   * La valeur de référence pour le classement est le **`delayMs` borné** (identique
   * à ce que checkAlignment / l'UI affiche) — PAS `requiredDelayMs`, le pic libre
   * non borné, sujet aux sauts de cycle (REGLES-METIER §2). `requiredDelayMs` est
   * renvoyé à titre indicatif. `withinBounds === false` = « Delay too large » ⇒
   * l'appelant traite le membre comme Infinity (écarté).
   *
   * @returns {Promise<Array<{ frequency:number, requiredDelayMs:number,
   *   delayMs:number, withinBounds:boolean, invertB:boolean }>>}
   */
  /**
   * IR predicted brute de la voie LFE : « somme vraie » pondérée splOffsetdB
   * des subs réels quand la liste est fournie (référentiel canonique), sinon
   * la projection LFE predicted. Partagée par les deux sweeps (crossover et
   * passe-bas LFE).
   */
  async function predictedSubSumIr(lfe, subs) {
    if (subs?.length) {
      const irs = [];
      const weightsDb = [];
      for (const sub of subs) {
        irs.push(await operations.getPredictedImpulseResponseInfo(rew(), sub));
        weightsDb.push(unwrap(sub.splOffsetdB) ?? 0);
      }
      return combineImpulseResponses(irs, weightsDb);
    }
    if (!lfe) {
      throw new Error('Cannot find predicted LFE for the sweep');
    }
    // Même convention de niveau que la somme vraie : l'export d'IR REW
    // n'intègre pas le SPL offset, on remet la projection à son niveau
    // affiché. Sans effet sur l'alignement (xcorr, invariant d'échelle),
    // nécessaire au critère de sommation du passe-bas LFE.
    const ir = await operations.getPredictedImpulseResponseInfo(rew(), lfe);
    const weightDb = unwrap(lfe.splOffsetdB) ?? 0;
    return weightDb === 0 ? ir : combineImpulseResponses([ir], [weightDb]);
  }

  async function crossoverRequiredShiftSweep(speaker, lfe, subs, candidateFrequencies) {
    // Lecture UNE fois des IR predicted brutes (avant raccord).
    const speakerRaw = await operations.getPredictedImpulseResponseInfo(rew(), speaker);
    const subSumRaw = await predictedSubSumIr(lfe, subs);

    const results = [];
    for (const frequency of candidateFrequencies) {
      let requiredDelayMs = Infinity;
      let delayMs = Infinity;
      let withinBounds = false;
      let invertB = false;
      try {
        const speakerFiltered = applyBankAndCrossoverToIr(
          speakerRaw,
          [],
          speakerHighPassSetting(frequency),
        );
        const subFiltered = applyBankAndCrossoverToIr(
          subSumRaw,
          [],
          subLowPassSetting(frequency),
        );
        // Même ordre A=sub, B=enceinte et MÊME fenêtre centrée ±T/4 que
        // checkAlignment (source unique crossoverAlignmentWindowMs) — évite toute
        // divergence bouton/auto et les sauts de cycle du grave.
        const { minMs, maxMs } = crossoverAlignmentWindowMs(frequency);
        const res = alignImpulseResponses(subFiltered, speakerFiltered, {
          frequency,
          minDelayMs: minMs,
          maxDelayMs: maxMs,
        });
        requiredDelayMs = res.requiredDelayMs;
        delayMs = res.delayMs;
        withinBounds = res.withinBounds;
        // Inversion que checkAlignment appliquerait à CETTE enceinte à ce raccord —
        // remontée pour le garde-fou d'inversion cohérente du groupe (findBestCrossover).
        invertB = res.invertB;
      } catch (error) {
        log.warn(
          `Crossover sweep: alignment failed at ${frequency}Hz for ` +
            `${unwrap(speaker.title)} (${error.message})`,
        );
      }
      results.push({ frequency, requiredDelayMs, delayMs, withinBounds, invertB });
    }
    return results;
  }

  /**
   * Perte de sommation moyenne (dB) d'un candidat : la voie LFE (spectre des
   * subs × LR24 candidat) est sommée en complexe avec la voie du canal front
   * complet, puis comparée point à point à la référence cohérente non filtrée.
   */
  function candidateSummationLoss(fc, grid, sampleRate, frontSpec, subSpec, refDb) {
    const cascade = buildCrossoverCascade(subLowPassSetting(fc), sampleRate);
    let lossSum = 0;
    let worstLossDb = 0;
    for (let i = 0; i < grid.length; i++) {
      const lp = getCascadeComplexResponse(cascade, grid[i], sampleRate);
      const lfeRe = subSpec.re[i] * lp.re - subSpec.im[i] * lp.im;
      const lfeIm = subSpec.re[i] * lp.im + subSpec.im[i] * lp.re;
      const sumMagnitude = Math.hypot(frontSpec.re[i] + lfeRe, frontSpec.im[i] + lfeIm);
      const lossDb = refDb[i] - 20 * Math.log10(sumMagnitude + MAGNITUDE_EPSILON);
      lossSum += lossDb;
      worstLossDb = Math.max(worstLossDb, lossDb);
    }
    return { summationLossDb: lossSum / grid.length, worstLossDb };
  }

  /**
   * Balaie les fréquences candidates du passe-bas LFE (« LPF for LFE » de
   * l'AVR — LR24, même topologie que le LP sub du bass management,
   * REGLES-METIER §3) et mesure, pour UN canal front, la qualité de la
   * sommation LFE + canal front COMPLET (enceinte HP + grave redirigé) sur la
   * bande utile du LFE (20–120 Hz, le contenu des pistes de films s'arrête à
   * 120 Hz).
   *
   * Tout est réalisé en fréquentiel sur la grille d'évaluation : spectres
   * complexes des IR predicted (référentiel absolu, donc directement
   * sommables), filtres du bass management (HP BW12 enceinte + LR24 du grave
   * redirigé au crossover du groupe ; 0 = Large : réponse complète seule) et
   * LR24 candidat appliqués analytiquement (réponse exacte des mêmes biquads
   * que le chemin IR). Les IR sont lues UNE fois ; aucune écriture REW,
   * aucune mutation.
   *
   * Critère par candidat : perte de sommation moyenne (dB) sur la grille,
   * référence = |canal front| + |LFE non filtré| (sommation parfaitement
   * cohérente ET contenu intégralement préservé). Un candidat bas paie sa
   * perte de contenu sous 120 Hz exactement comme une annulation — le
   * compromis contenu/addition du plan tient dans un seul critère.
   * `groupDelayMs` est le retard de groupe du LR24 dans sa bande passante
   * (2 × √2/ω0), le « décalage pris en compte » — purement informatif.
   *
   * @returns {Promise<Array<{ frequency:number, summationLossDb:number,
   *   worstLossDb:number, groupDelayMs:number }>>}
   */
  async function lfeLowPassSummationSweep(speaker, lfe, subs, candidateFrequencies) {
    const frequencies = (candidateFrequencies ?? []).filter(
      f => Number.isFinite(f) && f > 0,
    );
    if (!frequencies.length) {
      throw new Error('No candidate LFE low-pass frequencies');
    }

    // Lecture UNE fois des IR predicted brutes.
    const speakerRaw = await operations.getPredictedImpulseResponseInfo(rew(), speaker);
    const subSumRaw = await predictedSubSumIr(lfe, subs);
    if (speakerRaw.sampleRate !== subSumRaw.sampleRate) {
      throw new Error(
        `Sample rates differ: ${speakerRaw.sampleRate} vs ${subSumRaw.sampleRate}`,
      );
    }
    const sampleRate = speakerRaw.sampleRate;

    const grid = logSpacedFrequencies(
      LFE_EVALUATION_MIN_HZ,
      LFE_EVALUATION_MAX_HZ,
      LFE_EVALUATION_POINTS_PER_OCTAVE,
    );

    // Voie du canal front COMPLET — ce que le canal fait réellement entendre
    // en bass management (décision 2026-07-15, simulation REW à l'appui) :
    // enceinte predicted (égalisée) × HP BW12 au crossover du groupe + grave
    // redirigé (somme des subs × LR24 au MÊME crossover). Une enceinte Large
    // (crossover 0) joue sa réponse complète, sans redirection. Dans le grave
    // profond, le grave redirigé sort des mêmes subs que le LFE : un candidat
    // égal au crossover y est en phase à l'identique — l'intuition
    // « le passe-bas confirme le crossover » est ainsi portée par le modèle,
    // et arbitrée contre la préservation du contenu.
    // L'export d'IR REW n'intégrant pas le SPL offset, l'enceinte est remise
    // à son niveau affiché (même convention que la somme vraie des subs) :
    // c'est cet équilibre front/LFE qui donne son sens au critère.
    const frontSpec = complexSpectrumAt(speakerRaw, grid);
    const subSpec = complexSpectrumAt(subSumRaw, grid);
    const speakerGain = 10 ** ((unwrap(speaker.splOffsetdB) ?? 0) / 20);
    const crossover = crossoverForSpeaker(speaker) ?? 0;
    const hpCascade = crossover
      ? buildCrossoverCascade(speakerHighPassSetting(crossover), sampleRate)
      : [];
    const redirectCascade = crossover
      ? buildCrossoverCascade(subLowPassSetting(crossover), sampleRate)
      : null;
    for (let i = 0; i < grid.length; i++) {
      const hp = getCascadeComplexResponse(hpCascade, grid[i], sampleRate);
      let re = speakerGain * (frontSpec.re[i] * hp.re - frontSpec.im[i] * hp.im);
      let im = speakerGain * (frontSpec.re[i] * hp.im + frontSpec.im[i] * hp.re);
      if (redirectCascade) {
        const lp = getCascadeComplexResponse(redirectCascade, grid[i], sampleRate);
        re += subSpec.re[i] * lp.re - subSpec.im[i] * lp.im;
        im += subSpec.re[i] * lp.im + subSpec.im[i] * lp.re;
      }
      frontSpec.re[i] = re;
      frontSpec.im[i] = im;
    }

    const refDb = grid.map((_, i) => {
      const frontMagnitude = Math.hypot(frontSpec.re[i], frontSpec.im[i]);
      const subMagnitude = Math.hypot(subSpec.re[i], subSpec.im[i]);
      return 20 * Math.log10(frontMagnitude + subMagnitude + MAGNITUDE_EPSILON);
    });

    return frequencies.map(frequency => ({
      frequency,
      ...candidateSummationLoss(frequency, grid, sampleRate, frontSpec, subSpec, refDb),
      groupDelayMs: (1000 * Math.SQRT2) / (Math.PI * frequency),
    }));
  }

  /**
   * Measured alignment gap (seconds) between the predicted LFE and a speaker,
   * both crossover-filtered — the exact quantity produceAligned starts from.
   * Used to size the optimizer's alignment reserve. Returns null when the
   * context (predicted LFE, crossover) is not available.
   */
  async function alignmentGapSeconds(speakerItem) {
    const cuttOffFrequency = crossoverForSpeaker(speakerItem);
    const PredictedLfe = relatedLfeFor(speakerItem);
    if (!PredictedLfe || !cuttOffFrequency) return null;

    const { PredictedLfeFiltered, speakerFiltered } = await crossoverFilteredIrPair(
      PredictedLfe,
      speakerItem,
      cuttOffFrequency,
    );
    return (
      PredictedLfeFiltered.timeOfIRPeakSeconds - speakerFiltered.timeOfIRPeakSeconds
    );
  }

  /**
   * Align a subwoofer (predicted LFE) with a speaker by computing and applying
   * the optimal time offset (parity with BusinessTools.produceAligned). The
   * filtered responses are computed internally: the only REW writes left are
   * the final offsets/inversion on the real measurements.
   */
  async function produceAligned(speakerItem, subResponses) {
    const cuttOffFrequency = crossoverForSpeaker(speakerItem);
    const PredictedLfe = relatedLfeFor(speakerItem);
    validateInputs(PredictedLfe, speakerItem, cuttOffFrequency);

    const speed = speedOfSound();
    const { PredictedLfeFiltered, speakerFiltered } = await crossoverFilteredIrPair(
      PredictedLfe,
      speakerItem,
      cuttOffFrequency,
      subResponses,
    );

    const cutoffPeriod = 1 / cuttOffFrequency; // for 100Hz, period is 10ms
    const delay = cutoffPeriod / 16; // for 100Hz, delay is 0.625ms
    // Fenêtre de recherche avant [0, T/2] dérivée du crossover (source unique
    // crossoverAlignmentWindowMs, partagée avec checkAlignment / le sweep).
    // Arrondi 0.01 ms conservé ici → parité golden align-sub inchangée.
    const { maxMs } = crossoverAlignmentWindowMs(cuttOffFrequency, { forward: true });
    const maxForwardSearchMs = Math.round(maxMs * 100) / 100;

    // get the sub impulse closer to the front left, better method than cross corr align
    const distanceToSpeakerPeak =
      PredictedLfeFiltered.timeOfIRPeakSeconds - speakerFiltered.timeOfIRPeakSeconds;
    let finalDistance = distanceToSpeakerPeak - delay;

    const neededDistanceMeter = secondsToMeters(finalDistance, speed);
    // Calculate and apply adjustment to stay within maximum distance
    const overheadOffset = subDistanceLeftBeforeError() - neededDistanceMeter;

    if (overheadOffset < 0) {
      log.warn(
        `Adjusting alignment by ${-overheadOffset.toFixed(
          2,
        )}m to stay within max distance limit.`,
      );
      finalDistance += metersToSeconds(overheadOffset, speed);
    }

    // Équivalent interne de l'offsetTZero temporaire sur la mesure filtrée.
    PredictedLfeFiltered.startTime -= finalDistance;

    const speakerLabel = `predicted ${unwrap(speakerItem.title)}`;
    const { shiftDelay, isBInverted } = await findAligment(
      { ir: speakerFiltered, title: speakerLabel },
      { ir: PredictedLfeFiltered, title: unwrap(PredictedLfe.title) },
      cuttOffFrequency,
      maxForwardSearchMs,
      false,
      `${RESULT_PREFIX}${speakerLabel} X@${cuttOffFrequency}Hz_P${positionFor(speakerItem)}`,
      0,
    );

    if (isBInverted) {
      await operations.toggleInversion(rew(), PredictedLfe);
    }

    finalDistance -= shiftDelay;

    await operations.addIROffsetSeconds(rew(), PredictedLfe, finalDistance);
    await applyTimeOffsetToSubs(finalDistance, subResponses, isBInverted);

    const shiftDistance = secondsToMeters(finalDistance, speed).toFixed(2);
    log.info(
      `Subwoofer deplaced by: ${shiftDistance}m (alignment:${(
        (delay + shiftDelay) *
        1000
      ).toFixed(2)}ms)`,
    );
    // Applied alignment, so callers can carry it to other positions' subs.
    return { offsetSeconds: finalDistance, inverted: isBInverted };
  }

  /**
   * Build the "final ..." predicted preview of one speaker (parity with
   * BusinessTools.createMeasurementPreview): predict the channel, fold in the
   * position's crossover-filtered predicted LFE when a crossover is set, title
   * and smooth the result. Skips subs / unknown channels.
   */
  async function createMeasurementPreview(item) {
    if (isSubOf(item)) return;
    if (isUnknownOf(item)) return;

    await operations.removeWorkingSettings(rew(), item, irWindowWidthsFor(item));

    const predictedChannel = await operations.producePredictedMeasurement(
      rew(),
      item,
      sessionContext,
    );

    const crossover = crossoverForSpeaker(item);
    let finalPredcition;
    if (crossover === 0) {
      finalPredcition = predictedChannel;
    } else {
      const relatedLfe = relatedLfeFor(item);
      if (!relatedLfe) {
        await session.removeMeasurement(predictedChannel);
        // LFE predicted must be done by the user to ensure filters are correct.
        throw new Error(`Cannot find predicted LFE for position ${positionFor(item)}`);
      }

      await operations.removeWorkingSettings(rew(), relatedLfe, irWindowWidthsFor(relatedLfe));

      const { PredictedLfeFiltered, predictedSpeakerFiltered } =
        await applyCutOffFilter(relatedLfe, predictedChannel, crossover);

      await session.removeMeasurement(predictedChannel);

      finalPredcition = await operations.arithmeticSum(
        rew(),
        PredictedLfeFiltered,
        predictedSpeakerFiltered,
        sessionContext,
      );
      await session.removeMeasurements([PredictedLfeFiltered, predictedSpeakerFiltered]);

      await operations.applyWorkingSettings(rew(), relatedLfe, workingSettingsConfig());
    }

    const cxText = crossover ? `X@${crossover}Hz` : 'FB';
    const finalTitle = `${RESULT_PREFIX}${unwrap(item.title)} ${cxText}_P${positionFor(item)}`;
    await operations.setTitle(rew(), finalPredcition, finalTitle);
    await operations.setSmoothing(rew(), finalPredcition, 'Psy');
    await operations.applyWorkingSettings(rew(), item, workingSettingsConfig());

    return finalPredcition;
  }

  return {
    alignmentGapSeconds,
    createsSum,
    createLowPassFilter,
    revertLfeFilterProccess,
    revertLfeFilterProccessList,
    applyCutOffFilter,
    crossoverFilteredIrPair,
    crossoverRequiredShiftSweep,
    lfeLowPassSummationSweep,
    produceAligned,
    createMeasurementPreview,
  };
}

export { createBusinessTools };
