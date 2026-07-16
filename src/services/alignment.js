import { FrequencyResponseAnalyzer } from '../analysis/index.js';
import { alignImpulseResponses, crossoverAlignmentWindowMs } from '../dsp/ir-align.js';
import { excessPhaseArrivalSeconds } from '../dsp/time-alignment.js';
import { cleanFloat32Value } from '../measurement/measurement-calculations.js';
import { getAlignSPLOffsetdBByUUID } from './measurement-operations.js';

/**
 * Time/SPL alignment service extracted from MeasurementViewModel
 *.
 *
 * [ORCHESTRATION] service: peak/SPL alignment sequences, subwoofer SPL
 * adjustment and inversion detection. No Knockout, no DOM.
 *
 * Construction dependencies:
 * - `session`: the RewSession instance (rewMeasurements, rewAlignmentTool,
 *   loadData, removeMeasurements, analyseApiResponse).
 * - `predictedIrPair(lfe, speaker, subs)`: BusinessTools bridge — IR predicted
 *   brutes lues en interne (aucun filtre de raccord, doctrine « mesures sur
 *   courbes brutes »), sans mesure predicted temporaire dans REW.
 * - `setTargetLevelFromMeasurement(measurement)`: target-curve service bridge.
 * - `getPredictedLfeMeasurements()`: current predicted-LFE list.
 * - `operations`: (optional) createMeasurementOperations instance. When absent
 *   (Knockout entry) the service drives the measurement objects through their
 *   own methods — historical behaviour. When provided (ADR 002) the
 *   flat MeasurementRecords carry no methods, so writes route to the operations
 *   functions instead. The context providers below feed the per-item arguments
 *   the KO item methods used to derive from the viewmodel.
 * - `getOtherPositionMeasurements(m)`, `workingSettingsConfig(m)`,
 *   `irWindowWidthsFor(m)`: (operations path) context for the operations bridge.
 */

const SUBWOOFER_SPL_ALIGNMENT_OPTIONS = {
  analysisRangeHz: [10, 500],
  passbandHz: [30, 80],
  thresholdDb: -9,
  smoothing: '1/3',
  pointsPerOctave: 12,
};

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const unwrap = value => (typeof value === 'function' ? value() : value);

const labelOf = m => unwrap(m.displayMeasurementTitle) ?? unwrap(m.title);

async function setSameDelayToAll(measurements) {
  if (measurements.length <= 1) {
    return;
  }
  // align the others sub to first measurement delay
  const mainDelay = unwrap(measurements[0].cumulativeIRShiftSeconds);
  for (const measurement of measurements) {
    await measurement.setcumulativeIRShiftSeconds(mainDelay);
  }
}

/** Pick the target-curve magnitude at the frequency closest to `targetFreq`. */
function magnitudeAtClosestFreq(targetCurveResponse, targetFreq) {
  if (!targetCurveResponse) {
    throw new Error('Failed to get target curve response');
  }
  const freqIndex = targetCurveResponse.freqs.reduce((closestIdx, curr, idx) => {
    const closestFreq = targetCurveResponse.freqs[closestIdx];
    return Math.abs(curr - targetFreq) < Math.abs(closestFreq - targetFreq)
      ? idx
      : closestIdx;
  }, 0);
  return targetCurveResponse.magnitude[freqIndex];
}

function assertTargetLevelInputs(measurement, targetFreq) {
  if (!Number.isFinite(targetFreq) || targetFreq <= 0) {
    throw new Error('Target frequency must be a positive number');
  }
  if (!measurement) {
    throw new Error('No measurements available');
  }
}

async function getTargetLevelAtFreq(measurement, targetFreq = 40) {
  assertTargetLevelInputs(measurement, targetFreq);
  const targetCurveResponse = await measurement.getTargetResponse('SPL', 6);
  return magnitudeAtClosestFreq(targetCurveResponse, targetFreq);
}

/**
 * Measurement write API used by the alignment sequences. Without `operations`
 * every call delegates to the measurement's own method (Knockout MeasurementItem
 * adapter) — bit-for-bit the historical behaviour. With `operations` (ADR 002,
 * ADR 002) the calls route to the createMeasurementOperations functions, and the
 * per-item context the KO methods derived from the viewmodel is supplied by the
 * injected providers.
 */
function buildMeasurementApi({
  operations,
  session,
  getOtherPositionMeasurements = () => [],
  workingSettingsConfig = () => undefined,
  irWindowWidthsFor = () => undefined,
}) {
  // rewMeasurements is only wired after connect — read it lazily.
  const rew = () => session.rewMeasurements;
  if (!operations) {
    return {
      setZeroAtIrPeak: m => m.setZeroAtIrPeak(),
      getImpulseResponseInfo: m => m.getImpulseResponseInfo(),
      addIROffsetSeconds: (m, value) => m.addIROffsetSeconds(value),
      setcumulativeIRShiftSeconds: (m, value) => m.setcumulativeIRShiftSeconds(value),
      removeWorkingSettings: m => m.removeWorkingSettings(),
      applyWorkingSettings: m => m.applyWorkingSettings(),
      resetTargetSettings: m => m.resetTargetSettings(),
      resetIrWindows: m => m.resetIrWindows(),
      setTargetSettings: (m, settings) => m.setTargetSettings(settings),
      getFrequencyResponse: (m, unit, smoothing, ppo) =>
        m.getFrequencyResponse(unit, smoothing, ppo),
      getTargetResponse: (m, unit, ppo) => m.getTargetResponse(unit, ppo),
      copySplOffsetDeltadBToOther: m => m.copySplOffsetDeltadBToOther(),
      producePredictedMeasurement: m => m.producePredictedMeasurement(),
      toggleInversion: m => m.toggleInversion(),
    };
  }
  const sessionContext = {
    analyseApiResponse: result => session.analyseApiResponse(result),
    removeMeasurements: items => session.removeMeasurements(items),
    removeMeasurementUuid: uuid => session.removeMeasurementUuid(uuid),
    findMeasurementByUuid: uuid => session.findMeasurementByUuid(uuid),
  };
  return {
    setZeroAtIrPeak: m => operations.setZeroAtIrPeak(rew(), m),
    getImpulseResponseInfo: m => operations.getImpulseResponseInfo(rew(), m),
    addIROffsetSeconds: (m, value) => operations.addIROffsetSeconds(rew(), m, value),
    setcumulativeIRShiftSeconds: (m, value) =>
      operations.setcumulativeIRShiftSeconds(rew(), m, value),
    removeWorkingSettings: m =>
      operations.removeWorkingSettings(rew(), m, irWindowWidthsFor(m)),
    applyWorkingSettings: m =>
      operations.applyWorkingSettings(rew(), m, workingSettingsConfig(m)),
    resetTargetSettings: m => operations.resetTargetSettings(rew(), m),
    resetIrWindows: m => operations.resetIrWindows(rew(), m, irWindowWidthsFor(m)),
    setTargetSettings: (m, settings) => operations.setTargetSettings(rew(), m, settings),
    getFrequencyResponse: (m, unit, smoothing, ppo) =>
      operations.getFrequencyResponse(rew(), m, { unit, smoothing, ppo }),
    getTargetResponse: (m, unit, ppo) =>
      operations.getTargetResponse(rew(), m, { unit, ppo }),
    copySplOffsetDeltadBToOther: m =>
      operations.copySplOffsetDeltadBToOther(rew(), m, getOtherPositionMeasurements(m)),
    producePredictedMeasurement: m =>
      operations.producePredictedMeasurement(rew(), m, sessionContext),
    toggleInversion: m => operations.toggleInversion(rew(), m),
  };
}

function createAlignmentService({
  session,
  predictedIrPair,
  // Balayage du required shift sur les crossovers candidats (une enceinte) —
  // pont BusinessTools (crossoverRequiredShiftSweep). Injecté par la couche UI ;
  // le stub échoue à l'appel si non câblé (chemins de tests sans find-best-crossover).
  crossoverRequiredShiftSweep = async () => {
    throw new Error('crossoverRequiredShiftSweep is not wired');
  },
  // Balayage de la sommation LFE + enceinte sur les passe-bas LFE candidats
  // (une enceinte) — pont BusinessTools (lfeLowPassSummationSweep). Injecté par
  // la couche UI ; le stub échoue à l'appel si non câblé.
  lfeLowPassSummationSweep = async () => {
    throw new Error('lfeLowPassSummationSweep is not wired');
  },
  setTargetLevelFromMeasurement,
  getPredictedLfeMeasurements = () => [],
  operations = null,
  getOtherPositionMeasurements,
  workingSettingsConfig,
  irWindowWidthsFor,
  // Per-item context for checkAlignment. Defaults call the item's own getters
  // (KO path); record-based callers inject derivation-based providers.
  crossoverFor = m => unwrap(m.crossover),
  relatedLfeFor = m => unwrap(m.relatedLfeMeasurement),
  // Real subs at the speaker's position — their weighted « somme vraie » is the
  // deterministic référentiel checkAlignment aligns against (voir predictedIrPair).
  // Empty → fallback sur la projection LFE predicted.
  relatedSubsFor = () => [],
  log = noopLog,
}) {
  const mops = buildMeasurementApi({
    operations,
    session,
    getOtherPositionMeasurements,
    workingSettingsConfig,
    irWindowWidthsFor,
  });

  // getTargetLevelAtFreq routed through the measurement API (mops) so it works
  // on records; the module-level export keeps the item-method form for the KO
  // viewmodel wrapper and sub-optimization.
  async function getTargetLevelAtFreqVia(measurement, targetFreq = 40) {
    assertTargetLevelInputs(measurement, targetFreq);
    const targetCurveResponse = await mops.getTargetResponse(measurement, 'SPL', 6);
    return magnitudeAtClosestFreq(targetCurveResponse, targetFreq);
  }
  async function analyzeSubwooferSPLAlignment(
    measurement,
    options = SUBWOOFER_SPL_ALIGNMENT_OPTIONS,
  ) {
    const { analysisRangeHz, passbandHz, thresholdDb, smoothing, pointsPerOctave } =
      options;
    const title = labelOf(measurement);

    await mops.removeWorkingSettings(measurement);
    try {
      await mops.resetTargetSettings(measurement);
      const frequencyResponse = {
        ...(await mops.getFrequencyResponse(measurement, 'SPL', 'None', pointsPerOctave)),
        measurement: measurement.uuid,
        name: title,
        position: unwrap(measurement.position),
      };
      const bandwidth = FrequencyResponseAnalyzer.detectBandwidth(frequencyResponse, {
        rangeHz: analysisRangeHz,
        passbandHz,
        thresholdDb,
        smoothing,
      });

      if (bandwidth.status !== 'ok') {
        throw new Error(
          `Unable to detect subwoofer bandwidth for ${title}: ${bandwidth.reason ?? 'indeterminate response'}`,
        );
      }

      if (bandwidth.warnings?.length) {
        log.debug(
          `Bandwidth detection warnings for ${title}: ${bandwidth.warnings.join('; ')}`,
        );
      }

      const lowCutoff = Math.ceil(Math.max(analysisRangeHz[0], bandwidth.lowCutoffHz));
      const highCutoff = Math.floor(Math.min(analysisRangeHz[1], bandwidth.highCutoffHz));
      const centerFrequency = Math.round(bandwidth.centerFrequencyHz);
      const octaves = cleanFloat32Value(bandwidth.bandwidthOctaves, 2);

      if (
        [lowCutoff, highCutoff, centerFrequency, octaves].some(
          value => !Number.isFinite(value),
        ) ||
        lowCutoff >= highCutoff ||
        octaves <= 0
      ) {
        throw new Error(`Invalid subwoofer bandwidth for ${title}`);
      }

      return {
        measurement,
        title,
        lowCutoff,
        highCutoff,
        centerFrequency,
        octaves,
        bandwidth,
      };
    } finally {
      await mops.applyWorkingSettings(measurement);
    }
  }

  async function adjustSubwooferSPLLevels(subsMeasurements, targetLevelFreq = 40) {
    if (!subsMeasurements?.length) {
      return;
    }

    const targetLevelAtFreq = await getTargetLevelAtFreqVia(
      subsMeasurements[0],
      targetLevelFreq,
    );
    if (!Number.isFinite(targetLevelAtFreq)) {
      throw new TypeError(`Invalid target level at ${targetLevelFreq}Hz`);
    }

    const targetLevel = targetLevelAtFreq - 20 * Math.log10(subsMeasurements.length);

    const subwooferAnalyses = [];
    for (const measurement of subsMeasurements) {
      subwooferAnalyses.push(await analyzeSubwooferSPLAlignment(measurement));
    }

    const lowFrequency = Math.min(...subwooferAnalyses.map(({ lowCutoff }) => lowCutoff));
    const highFrequency = Math.max(
      ...subwooferAnalyses.map(({ highCutoff }) => highCutoff),
    );

    await session.removeMeasurements(getPredictedLfeMeasurements());

    for (const analysis of subwooferAnalyses) {
      const { measurement, title, lowCutoff, highCutoff, centerFrequency, octaves } =
        analysis;

      const alignResult = await session.rewMeasurements.alignSPL(
        [measurement.uuid],
        targetLevel,
        centerFrequency,
        octaves,
      );

      const alignOffset = getAlignSPLOffsetdBByUUID(alignResult, measurement.uuid);
      measurement.update({
        alignSPLOffsetdB: alignOffset,
        splOffsetdB: cleanFloat32Value(measurement.initialSplOffsetdB + alignOffset, 2),
      });
      // The absolute re-anchor absorbs any pending joint gain trim: clear its
      // bookkeeping so the optimizer's next preamble does not revert it twice.
      measurement.jointGainDb = 0;
      log.info(
        `\nAdjust ${title} SPL levels to ${targetLevel.toFixed(1)}dB` +
          `(center: ${centerFrequency}Hz, ${octaves} octaves, ${lowCutoff}Hz - ${highCutoff}Hz)` +
          ` => ${alignOffset}dB`,
      );
      await mops.copySplOffsetDeltadBToOther(measurement);
    }

    return {
      lowFrequency,
      highFrequency,
      targetLevelAtFreq,
    };
  }

  /** Give every sub the first sub's delay (mops-aware internal variant). */
  async function setSameDelayToAllVia(measurements) {
    if (measurements.length <= 1) {
      return;
    }
    const mainDelay = unwrap(measurements[0].cumulativeIRShiftSeconds);
    for (const measurement of measurements) {
      await mops.setcumulativeIRShiftSeconds(measurement, mainDelay);
    }
  }

  /**
   * Place t=0 sur le temps d'arrivée estimé par la phase en excès
   * (dsp/time-alignment.js) plutôt que sur le pic de l'IR : le pic peut
   * s'accrocher sur une réflexion plus forte que le son direct (mesuré sur le
   * corpus ADY : +19 ms → +6.5 m de distance AVR sur un canal). Repli sur le
   * pic si l'IR est indisponible.
   */
  async function setZeroAtArrival(measurement) {
    try {
      const { data, sampleRate, startTime } = await mops.getImpulseResponseInfo(measurement);
      const arrivalSeconds =
        startTime + excessPhaseArrivalSeconds(data, { sampleRate });
      // Trace les arrivées nettement avant le pic : son direct devançant une
      // réflexion dominante (choix voulu), ou fuite directe d'une enceinte
      // Atmos à réflexion plafond (à vérifier par l'utilisateur — pour ces
      // enceintes la distance doit suivre le rebond, qui domine normalement).
      const peakSeconds = unwrap(measurement.timeOfIRPeakSeconds);
      if (Number.isFinite(peakSeconds) && peakSeconds - arrivalSeconds > 0.002) {
        log.info(
          `${labelOf(measurement)}: arrival ${(arrivalSeconds * 1000).toFixed(2)}ms ` +
            `kept, IR peak ${(peakSeconds * 1000).toFixed(2)}ms ` +
            `(+${((peakSeconds - arrivalSeconds) * 1000).toFixed(1)}ms later)`,
        );
      }
      await mops.addIROffsetSeconds(measurement, arrivalSeconds);
    } catch (error) {
      log.warn(
        `${labelOf(measurement)}: excess-phase arrival unavailable ` +
          `(${error.message}), falling back to the IR peak`,
      );
      await mops.setZeroAtIrPeak(measurement);
    }
  }

  /** Align every speaker on its estimated arrival, then give all subs the same delay. */
  async function alignArrivals(speakerMeasurements, subMeasurements) {
    for (const measurement of speakerMeasurements) {
      await setZeroAtArrival(measurement);
    }

    if (subMeasurements.length > 0) {
      const sub = subMeasurements[0];
      await setZeroAtArrival(sub);
      await setSameDelayToAllVia(subMeasurements);
    }
  }

  /**
   * Full SPL alignment sequence: level speakers against each other, derive
   * the target level, propagate it, then adjust the subwoofer levels.
   * Returns the aggregate subwoofer frequency bands.
   */
  async function alignSPL({ speakerMeasurements, uniqueMeasurements, subMeasurements }) {
    if (speakerMeasurements.length === 0) {
      throw new Error('No measurements found for SPL alignment');
    } else if (speakerMeasurements.length === 1) {
      throw new Error('Only one measurement found for SPL alignment');
    }
    const firstWorkingMeasurement = speakerMeasurements[0];

    await mops.resetTargetSettings(firstWorkingMeasurement);
    // working settings must match filter settings
    for (const work of uniqueMeasurements) {
      await mops.resetIrWindows(work);
    }
    const uuids = uniqueMeasurements.map(m => m.uuid);
    await session.rewMeasurements.smoothMeasurements(uuids, '1/1');

    await session.rewMeasurements.alignSPL(
      speakerMeasurements.map(m => m.uuid),
      'average',
      2500,
      5,
    );

    // take the new aligned measurements into account
    await session.loadData();

    // must be calculated before removing working settings
    await mops.setTargetSettings(firstWorkingMeasurement, {
      shape: 'Bass limited',
      bassManagementSlopedBPerOctave: 24,
      bassManagementCutoffHz: 150,
    });
    // TODO check target level calculation sometime is too high
    await session.rewMeasurements.calculateTargetLevel(firstWorkingMeasurement.uuid);
    await mops.resetTargetSettings(firstWorkingMeasurement);

    // working settings must match filter settings
    for (const work of speakerMeasurements) {
      await mops.applyWorkingSettings(work);
    }

    // set target level to all measurements including subs
    await setTargetLevelFromMeasurement(firstWorkingMeasurement);

    // copy SPL alignment level to other measurements positions
    for (const measurement of uniqueMeasurements) {
      await mops.copySplOffsetDeltadBToOther(measurement);
    }

    // ajust subwoofer levels
    const subsFrequencyBands = await adjustSubwooferSPLLevels(subMeasurements);

    for (const sub of subMeasurements) {
      await mops.applyWorkingSettings(sub);
    }

    return subsFrequencyBands;
  }

  /**
   * Align channel B against channel A — implémentation INTERNE de la
   * commande « Align IRs » (src/dsp/ir-align.js), à parité démontrée contre
   * l'alignment tool de REW (test:ir-align-parity : Δ ≤ 0.062 ms, mêmes
   * inversions, mêmes refus sur 2 systèmes du corpus). Plus d'allers-retours
   * REW (~ms au lieu de secondes) et le « Delay too large » devient un
   * message exploitable portant le délai requis. Le client
   * rewAlignmentTool est conservé pour le harnais de parité.
   */
  async function findAligment(
    channelA,
    channelB,
    frequency,
    maxSearchRange = 3,
    createSum = false,
    sumTitle = null,
    minSearchRange = -0.5,
  ) {
    if (createSum) {
      // Jamais utilisé en production (tous les appelants passent false) ;
      // la somme alignée se fait via l'arithmétique REW au besoin.
      throw new Error(
        `Aligned sum is not supported by the internal aligner (requested for ${sumTitle})`,
      );
    }

    try {
      // Les canaux peuvent porter une IR précalculée (chemin interne des
      // mesures filtrées, business-tools) au lieu d'une mesure REW à lire.
      const irA = channelA.ir ?? (await mops.getImpulseResponseInfo(channelA));
      const irB = channelB.ir ?? (await mops.getImpulseResponseInfo(channelB));
      const result = alignImpulseResponses(irA, irB, {
        frequency,
        minDelayMs: minSearchRange,
        maxDelayMs: maxSearchRange,
      });

      if (!result.withinBounds) {
        // Même contrat d'erreur que l'outil REW, mais avec le délai requis
        // toujours présent et exploitable par l'appelant. Garde devenue
        // défensive : depuis le clamp du repli contraint (ir-align,
        // 2026-07-16), l'aligneur ne rend plus de résultat hors bornes.
        throw new Error(
          `Delay too large. The delay required to align the responses at ` +
            `${frequency} Hz is too large, ${result.requiredDelayMs.toFixed(2)} ms`,
        );
      }

      const shiftDelayMs = result.delayMs;
      if (
        Math.abs(shiftDelayMs - maxSearchRange) < 0.005 ||
        Math.abs(shiftDelayMs - minSearchRange) < 0.005
      ) {
        log.warn('alignment-tool: Shift is maxed out to the limit: ' + shiftDelayMs);
      }
      if (result.invertB) {
        log.warn('alignment-tool: Results provided were with toggled polarity');
      }
      return { shiftDelay: shiftDelayMs / 1000, isBInverted: result.invertB };
    } catch (error) {
      throw new Error(`Alignment tool failed: ${error.message}`, { cause: error });
    }
  }

  /**
   * Detect whether a speaker needs its polarity toggled against the predicted
   * LFE, and record the measured shift delay. Tolerant: on failure the shift
   * delay is reset and a warning is logged.
   */
  async function checkAlignment(speakerItem) {
    try {
      const cuttOffFrequency = crossoverFor(speakerItem);
      const PredictedLfe = relatedLfeFor(speakerItem);

      if (!PredictedLfe) {
        throw new Error(`No LFE found, please use sum subs button`);
      }

      // IR predicted BRUTES lues en interne — aucune mesure temporaire dans
      // REW, aucun filtre de raccord (doctrine « mesures sur courbes brutes » :
      // la paire LR24|LR24 réalisée par l'OCA + l'ampli est en phase partout ;
      // la sélectivité au crossover vient du passe-bande zéro-phase interne de
      // l'aligneur). Côté LFE : la « somme vraie » pondérée splOffsetdB des
      // subs réels de la position (référentiel canonique déterministe), avec
      // repli sur la projection LFE predicted si la liste est vide. Mécanique
      // à parité golden REW : test:ir-align-parity / test:align-sub-parity.
      const { lfeRaw, speakerRaw } = await predictedIrPair(
        PredictedLfe,
        speakerItem,
        relatedSubsFor(speakerItem),
      );

      // channelB = enceinte → isBInverted porte l'inversion de l'enceinte.
      // Fenêtre centrée ±T/4 dérivée du crossover (source unique partagée avec le
      // sweep « find best crossover ») — un demi-cycle de large, sans saut de cycle.
      const { minMs, maxMs } = crossoverAlignmentWindowMs(cuttOffFrequency);
      const { shiftDelay, isBInverted } = await findAligment(
        { ir: lfeRaw, title: unwrap(PredictedLfe.title) },
        { ir: speakerRaw, title: `predicted ${labelOf(speakerItem)}` },
        cuttOffFrequency,
        maxMs,
        false,
        null,
        minMs,
      );

      speakerItem.update({ shiftDelay });

      if (isBInverted) {
        await mops.toggleInversion(speakerItem);
        log.info(`Inversion toggled for ${labelOf(speakerItem)}`);
      } else {
        log.info(`No inversion needed for ${labelOf(speakerItem)}`);
      }
    } catch {
      log.warn(`Unable to determine inversion for ${labelOf(speakerItem)}`);
      speakerItem.update({ shiftDelay: Infinity });
    }
  }

  async function autoAdjustInversion(speakerMeasurements) {
    for (const speakerItem of speakerMeasurements) {
      await checkAlignment(speakerItem);
    }
  }

  /**
   * Cherche le meilleur crossover pour un groupe d'enceintes (le crossover est
   * partagé au niveau du groupe). Pour chaque membre, balaie les crossovers
   * candidats et mesure le required shift à chacun (crossoverRequiredShiftSweep,
   * IR lues une fois). Le crossover retenu minimise la **moyenne des
   * |required shift|** des membres, en prenant le **shift borné** `delayMs`
   * (identique à checkAlignment / l'UI, fenêtre ±T/4) — pas le pic libre
   * `requiredDelayMs`, sujet aux sauts de cycle. Un membre hors bornes vaut
   * Infinity (comme le « Delay too large » de checkAlignment) → candidat écarté.
   *
   * Pourquoi le shift ABSOLU (et non un désaccord entre enceintes) : les
   * enceintes sont déjà alignées temporellement entre elles (figées après le Time
   * align) et le bloc des subs est aligné à UNE enceinte de référence puis figé —
   * il ne suit PAS chaque groupe. Le required shift absolu d'un groupe face au sub
   * (fixe) est donc un résidu réel et non corrigeable : on choisit le crossover
   * qui le minimise. On prend la **valeur absolue avant** de moyenner → deux
   * shifts de signe opposé ne s'annulent pas (moyenne signée jamais utilisée).
   *
   * Garde-fou d'inversion (REGLES-METIER §6) : un candidat où les membres du
   * groupe ne partagent PAS la même inversion (l'un inversé, l'autre non) est
   * **rejeté** (moyenne Infinity) — le crossover retenu garantit une inversion
   * cohérente sur toute la paire.
   *
   * Un candidat dont un membre est non fini (Infinity/NaN) est écarté. Si aucun
   * candidat n'est exploitable, `bestFrequency` vaut `null` (échec — l'appelant
   * logue et ne touche à rien). Ne mute rien (pas d'écriture, pas d'inversion).
   *
   * @returns {Promise<{ bestFrequency: number|null, table: Array<{ fc:number,
   *   perMember: Array<{uuid, id, shiftMs, delayMs, requiredDelayMs, withinBounds,
   *   invertB}>, mean:number, inversionConsistent:boolean }> }>}
   */
  async function findBestCrossover(groupSpeakerItems, candidateFrequencies) {
    if (!groupSpeakerItems?.length) {
      throw new Error('No speaker measurements for the crossover search');
    }
    const frequencies = (candidateFrequencies ?? []).filter(
      f => Number.isFinite(f) && f > 0,
    );
    if (!frequencies.length) {
      throw new Error('No candidate crossover frequencies');
    }

    // Balayage par membre (IR predicted lues une seule fois par membre).
    const perMemberSweeps = [];
    for (const member of groupSpeakerItems) {
      const lfe = relatedLfeFor(member);
      const subs = relatedSubsFor(member);
      const sweep = await crossoverRequiredShiftSweep(member, lfe, subs, frequencies);
      const byFreq = new Map(sweep.map(entry => [entry.frequency, entry]));
      perMemberSweeps.push({ member, byFreq });
    }

    // Agrégation par candidat : moyenne des |required shift| sur les membres, en
    // utilisant la MÊME valeur que checkAlignment / l'UI — le `delayMs` **borné**
    // (fenêtre ±T/4) et non le pic libre `requiredDelayMs` (sujet aux sauts de
    // cycle, REGLES-METIER §2). Un membre hors bornes (`withinBounds === false`,
    // = le « Delay too large » qui met checkAlignment à Infinity) rend la moyenne
    // non finie → candidat écarté — cas devenu défensif depuis le clamp du
    // repli contraint de l'aligneur (2026-07-16).
    const table = frequencies.map(fc => {
      const perMember = perMemberSweeps.map(({ member, byFreq }) => {
        const entry = byFreq.get(fc) ?? {};
        const shiftMs = entry.withinBounds ? entry.delayMs : Infinity;
        return {
          uuid: member.uuid,
          id: labelOf(member),
          shiftMs,
          delayMs: entry.delayMs,
          requiredDelayMs: entry.requiredDelayMs,
          withinBounds: entry.withinBounds,
          invertB: Boolean(entry.invertB),
        };
      });
      // Garde-fou d'inversion (REGLES-METIER §6) : les membres d'un groupe doivent
      // partager la même inversion. Si à ce crossover l'un serait inversé et pas
      // l'autre, on REJETTE le candidat — le crossover retenu garantit alors que le
      // checkAlignment ultérieur appliquera la même décision aux deux membres.
      const inversionConsistent = perMember.every(
        m => m.invertB === perMember[0].invertB,
      );
      const absShifts = perMember.map(m => Math.abs(m.shiftMs));
      const shiftsFinite = absShifts.every(v => Number.isFinite(v));
      let mean = shiftsFinite
        ? absShifts.reduce((sum, v) => sum + v, 0) / absShifts.length
        : Infinity;
      if (shiftsFinite && !inversionConsistent) {
        mean = Infinity; // rejeté : inversion incohérente dans le groupe
      }
      return { fc, perMember, mean, inversionConsistent };
    });

    let bestFrequency = null;
    let bestMean = Infinity;
    for (const row of table) {
      if (Number.isFinite(row.mean) && row.mean < bestMean) {
        bestMean = row.mean;
        bestFrequency = row.fc;
      }
    }

    return { bestFrequency, table };
  }

  /**
   * Cherche la fréquence du passe-bas LFE (« LPF for LFE » de l'AVR) qui donne
   * la sommation la plus constructive entre la voie LFE et les enceintes
   * frontales LCR. Pour chaque front, balaie les candidats
   * (lfeLowPassSummationSweep : IR lues une fois, LR24 appliqué
   * analytiquement) ; le candidat retenu minimise la **moyenne des pertes de
   * sommation** (dB, bande 20–120 Hz) sur les fronts. La perte de contenu d'un
   * candidat bas est déjà pénalisée par le critère du sweep (référence non
   * filtrée) — aucune borne sur les candidats : toutes les valeurs de l'AVR
   * sont jugées (plan auto-select LPF LFE, décisions 2026-07-14).
   *
   * Un candidat dont un membre est non fini est écarté. Si aucun candidat
   * n'est exploitable, `bestFrequency` vaut `null` (échec — l'appelant logue
   * et ne touche à rien). Fonction pure : aucune écriture REW, aucune
   * mutation (le réglage lpfForLFE est appliqué par le handler UI).
   *
   * @returns {Promise<{ bestFrequency: number|null, table: Array<{ fc:number,
   *   perMember: Array<{uuid, id, lossDb, worstLossDb}>, mean:number,
   *   groupDelayMs:number }> }>}
   */
  async function findBestLfeLowPass(frontItems, candidateFrequencies) {
    if (!frontItems?.length) {
      throw new Error('No front speaker measurements for the LFE low-pass search');
    }
    const frequencies = (candidateFrequencies ?? []).filter(
      f => Number.isFinite(f) && f > 0,
    );
    if (!frequencies.length) {
      throw new Error('No candidate LFE low-pass frequencies');
    }

    // Balayage par front (IR predicted lues une seule fois par membre).
    const perMemberSweeps = [];
    for (const member of frontItems) {
      const lfe = relatedLfeFor(member);
      const subs = relatedSubsFor(member);
      const sweep = await lfeLowPassSummationSweep(member, lfe, subs, frequencies);
      const byFreq = new Map(sweep.map(entry => [entry.frequency, entry]));
      perMemberSweeps.push({ member, byFreq });
    }

    // Agrégation par candidat : moyenne des pertes de sommation sur les fronts
    // présents (même logique de groupe que findBestCrossover). Pas de garde-fou
    // d'inversion ici : rien n'est muté, aucune décision d'inversion n'est prise.
    const table = frequencies.map(fc => {
      const perMember = perMemberSweeps.map(({ member, byFreq }) => {
        const entry = byFreq.get(fc) ?? {};
        return {
          uuid: member.uuid,
          id: labelOf(member),
          lossDb: Number.isFinite(entry.summationLossDb)
            ? entry.summationLossDb
            : Infinity,
          worstLossDb: entry.worstLossDb,
        };
      });
      const losses = perMember.map(m => m.lossDb);
      const mean = losses.every(v => Number.isFinite(v))
        ? losses.reduce((sum, v) => sum + v, 0) / losses.length
        : Infinity;
      const groupDelayMs = perMemberSweeps[0].byFreq.get(fc)?.groupDelayMs;
      return { fc, perMember, mean, groupDelayMs };
    });

    let bestFrequency = null;
    let bestMean = Infinity;
    for (const row of table) {
      if (Number.isFinite(row.mean) && row.mean < bestMean) {
        bestMean = row.mean;
        bestFrequency = row.fc;
      }
    }

    return { bestFrequency, table };
  }

  return {
    adjustSubwooferSPLLevels,
    alignArrivals,
    alignSPL,
    analyzeSubwooferSPLAlignment,
    autoAdjustInversion,
    checkAlignment,
    findAligment,
    findBestCrossover,
    findBestLfeLowPass,
    getTargetLevelAtFreq,
    setSameDelayToAll,
  };
}

export {
  SUBWOOFER_SPL_ALIGNMENT_OPTIONS,
  createAlignmentService,
  getTargetLevelAtFreq,
  setSameDelayToAll,
};
