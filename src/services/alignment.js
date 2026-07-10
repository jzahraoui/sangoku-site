import { FrequencyResponseAnalyzer } from '../analysis/index.js';
import { cleanFloat32Value } from '../measurement/measurement-calculations.js';
import { getAlignSPLOffsetdBByUUID } from './measurement-operations.js';

/**
 * Time/SPL alignment service extracted from MeasurementViewModel
 * (décontamination lot V4 — docs/reverse/03-vm-decontamination.md).
 *
 * [ORCHESTRATION] service: peak/SPL alignment sequences, subwoofer SPL
 * adjustment and inversion detection. No Knockout, no DOM.
 *
 * Construction dependencies:
 * - `session`: the RewSession instance (rewMeasurements, rewAlignmentTool,
 *   loadData, removeMeasurements, analyseApiResponse).
 * - `applyCutOffFilter(lfe, speaker, frequency)`: BusinessTools bridge.
 * - `setTargetLevelFromMeasurement(measurement)`: target-curve service bridge.
 * - `getPredictedLfeMeasurements()`: current predicted-LFE list.
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

async function getTargetLevelAtFreq(measurement, targetFreq = 40) {
  // Input validation
  if (!Number.isFinite(targetFreq) || targetFreq <= 0) {
    throw new Error('Target frequency must be a positive number');
  }

  if (!measurement) {
    throw new Error('No measurements available');
  }

  // Find the level of target curve at 40Hz

  const targetCurveResponse = await measurement.getTargetResponse('SPL', 6);
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

function createAlignmentService({
  session,
  applyCutOffFilter,
  setTargetLevelFromMeasurement,
  getPredictedLfeMeasurements = () => [],
  log = noopLog,
}) {
  async function analyzeSubwooferSPLAlignment(
    measurement,
    options = SUBWOOFER_SPL_ALIGNMENT_OPTIONS,
  ) {
    const { analysisRangeHz, passbandHz, thresholdDb, smoothing, pointsPerOctave } =
      options;
    const title = labelOf(measurement);

    await measurement.removeWorkingSettings();
    try {
      await measurement.resetTargetSettings();
      const frequencyResponse = {
        ...(await measurement.getFrequencyResponse('SPL', 'None', pointsPerOctave)),
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
      await measurement.applyWorkingSettings();
    }
  }

  async function adjustSubwooferSPLLevels(subsMeasurements, targetLevelFreq = 40) {
    if (!subsMeasurements?.length) {
      return;
    }

    const targetLevelAtFreq = await getTargetLevelAtFreq(
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
      log.info(
        `\nAdjust ${title} SPL levels to ${targetLevel.toFixed(1)}dB` +
          `(center: ${centerFrequency}Hz, ${octaves} octaves, ${lowCutoff}Hz - ${highCutoff}Hz)` +
          ` => ${alignOffset}dB`,
      );
      await measurement.copySplOffsetDeltadBToOther();
    }

    return {
      lowFrequency,
      highFrequency,
      targetLevelAtFreq,
    };
  }

  /** Align every speaker on its IR peak, then give all subs the same delay. */
  async function alignPeaks(speakerMeasurements, subMeasurements) {
    for (const measurement of speakerMeasurements) {
      await measurement.setZeroAtIrPeak();
    }

    if (subMeasurements.length > 0) {
      const sub = subMeasurements[0];
      await sub.setZeroAtIrPeak();
      await setSameDelayToAll(subMeasurements);
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

    await firstWorkingMeasurement.resetTargetSettings();
    // working settings must match filter settings
    for (const work of uniqueMeasurements) {
      await work.resetIrWindows();
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
    await firstWorkingMeasurement.setTargetSettings({
      shape: 'Bass limited',
      bassManagementSlopedBPerOctave: 24,
      bassManagementCutoffHz: 150,
    });
    // TODO check target level calculation sometime is too high
    await session.rewMeasurements.calculateTargetLevel(firstWorkingMeasurement.uuid);
    await firstWorkingMeasurement.resetTargetSettings();

    // working settings must match filter settings
    for (const work of speakerMeasurements) {
      await work.applyWorkingSettings();
    }

    // set target level to all measurements including subs
    await setTargetLevelFromMeasurement(firstWorkingMeasurement);

    // copy SPL alignment level to other measurements positions
    for (const measurement of uniqueMeasurements) {
      await measurement.copySplOffsetDeltadBToOther();
    }

    // ajust subwoofer levels
    const subsFrequencyBands = await adjustSubwooferSPLLevels(subMeasurements);

    for (const sub of subMeasurements) {
      await sub.applyWorkingSettings();
    }

    return subsFrequencyBands;
  }

  /** Drive the REW alignment tool to align channel B against channel A. */
  async function findAligment(
    channelA,
    channelB,
    frequency,
    maxSearchRange = 3,
    createSum = false,
    sumTitle = null,
    minSearchRange = -0.5,
  ) {
    if (createSum && !sumTitle) {
      throw new Error('sumTitle is required when createSum is true');
    }

    try {
      await session.rewAlignmentTool.setRemoveTimeDelay(false);
      await session.rewAlignmentTool.resetAll();
      await session.rewAlignmentTool.setMaxNegativeDelay(minSearchRange);
      await session.rewAlignmentTool.setMaxPositiveDelay(maxSearchRange);

      const AlignResults = await session.rewAlignmentTool.alignIRsBatch(
        channelA.uuid,
        channelB.uuid,
        frequency,
      );

      if (!AlignResults.results) {
        throw new Error('alignment-tool: Invalid AlignResults object or missing results');
      }

      const AlignResultsDetails = AlignResults.results[0];

      if (AlignResultsDetails.Error?.length > 0) {
        throw new Error(AlignResultsDetails.Error);
      }

      const shiftDelayMs = Number(AlignResultsDetails['Delay B ms']);
      if (!Number.isFinite(shiftDelayMs)) {
        throw new TypeError(
          'alignment-tool: Invalid AlignResults object or missing Delay B ms',
        );
      }
      if (shiftDelayMs === maxSearchRange || shiftDelayMs === minSearchRange) {
        log.warn('alignment-tool: Shift is maxed out to the limit: ' + shiftDelayMs);
      }
      const isBInverted = AlignResultsDetails['Invert B'] === 'true';

      if (isBInverted) {
        log.warn('alignment-tool: Results provided were with toggled polarity');
      }
      if (createSum) {
        const alignedSum = await session.rewAlignmentTool.alignedSum();
        const alignedSumObject = await session.analyseApiResponse(alignedSum);
        await alignedSumObject.setTitle(sumTitle);
      }
      return { shiftDelay: shiftDelayMs / 1000, isBInverted };
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
    const mustBeDeleted = [];
    try {
      const cuttOffFrequency = unwrap(speakerItem.crossover);
      const PredictedLfe = unwrap(speakerItem.relatedLfeMeasurement);

      if (!PredictedLfe) {
        throw new Error(`No LFE found, please use sum subs button`);
      }

      const predictedFrontLeft = await speakerItem.producePredictedMeasurement();
      mustBeDeleted.push(predictedFrontLeft);

      const { PredictedLfeFiltered, predictedSpeakerFiltered } = await applyCutOffFilter(
        PredictedLfe,
        predictedFrontLeft,
        cuttOffFrequency,
      );
      mustBeDeleted.push(PredictedLfeFiltered, predictedSpeakerFiltered);

      const { shiftDelay, isBInverted } = await findAligment(
        PredictedLfeFiltered,
        predictedSpeakerFiltered,
        cuttOffFrequency,
        1,
        false,
        null,
        -1,
      );

      speakerItem.update({ shiftDelay });

      if (isBInverted) {
        await speakerItem.toggleInversion();
        log.info(`Inversion toggled for ${labelOf(speakerItem)}`);
      } else {
        log.info(`No inversion needed for ${labelOf(speakerItem)}`);
      }
    } catch {
      log.warn(`Unable to determine inversion for ${labelOf(speakerItem)}`);
      speakerItem.update({ shiftDelay: Infinity });
    } finally {
      await session.removeMeasurements(mustBeDeleted);
    }
  }

  async function autoAdjustInversion(speakerMeasurements) {
    for (const speakerItem of speakerMeasurements) {
      await checkAlignment(speakerItem);
    }
  }

  return {
    adjustSubwooferSPLLevels,
    alignPeaks,
    alignSPL,
    analyzeSubwooferSPLAlignment,
    autoAdjustInversion,
    checkAlignment,
    findAligment,
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
