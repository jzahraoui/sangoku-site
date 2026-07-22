/**
 * Live AVR data synthesis (RCH 2.0).
 *
 * [ORCHESTRATION] pure functions building the application `jsonAvrData`
 * context from the bridge AVR endpoints (`GET /avr/info` + `GET /avr/status`),
 * replacing the retired `.avr` file import. The produced object has the exact
 * shape of a parsed AVR file so the downstream consumers (viewmodels,
 * services, exports) are untouched; measurement files (.ady/.mqx/.liveproject)
 * only supply measurements — the connected AVR is the configuration
 * authority.
 */
import AvrCaracteristics from '../avr-caracteristics.js';
import { CHANNEL_TYPES } from '../audyssey.js';
import ampAssignType from '../amp-type.js';

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// GET /avr/info EQType wire names → .ady enMultEQType ids.
const EQ_TYPE_BY_NAME = Object.freeze({
  MultEQ: 0,
  MultEQXT: 1,
  MultEQXT32: 2,
});

/**
 * Normalizes an AVR wire channel code (GET_AVRSTS ChSetup) to the generic
 * vocabulary of `CHANNEL_TYPES` : the subwoofer aliases SWMIX1..4 / SWLFE /
 * SWMIX all collapse to the numbered SW1..SW4 ids used across the app.
 * Non-subwoofer codes (FL, SLA, TML, ...) are already the shared vocabulary.
 */
function normalizeChannelCode(wireCode) {
  const upper = String(wireCode).toUpperCase();
  const mix = /^SWMIX([1-4])$/.exec(upper);
  if (mix) return `SW${mix[1]}`;
  if (upper === 'SWLFE' || upper === 'SWMIX' || upper === 'LFE') return 'SW1';
  return upper;
}

function buildDetectedChannels(chSetup, log) {
  const channels = [];
  for (const entry of chSetup) {
    const [wireCode, speakerSize] = Object.entries(entry ?? {})[0] ?? [];
    if (!wireCode) continue;
    const commandId = normalizeChannelCode(wireCode);
    const channelType = CHANNEL_TYPES.getByCode(commandId);
    if (!channelType || channelType === CHANNEL_TYPES.EnChannelType_SWMode) {
      log.warn(`Unknown AVR channel code skipped: ${wireCode}`);
      continue;
    }
    channels.push({
      commandId,
      enChannelType: channelType.channelIndex,
      // Original wire code, required verbatim by GET /measure/response.
      wireCode,
      speakerSize: speakerSize ?? null,
      channelReport: {},
      responseData: {},
    });
  }
  return channels;
}

/**
 * Builds the `jsonAvrData` context from the live bridge payloads.
 *
 * @param {object} input
 * @param {object} input.info - `info` object of `GET /avr/info` (Ifver, DType, EQType).
 * @param {object} input.status - `status` object of `GET /avr/status` (AmpAssign, AssignBin, ChSetup, SWSetup...).
 * @param {string} [input.model] - AVR model name (discovery / user entry) driving the AvrCaracteristics tables.
 * @param {object} [log]
 */
function synthesizeAvrData({ info, status, model }, log = noopLog) {
  if (!info || !status) {
    throw new Error('AVR info and status are both required');
  }
  const enMultEQType = EQ_TYPE_BY_NAME[info.EQType];
  if (enMultEQType === undefined) {
    throw new Error(`Unsupported AVR EQType: ${info.EQType}`);
  }

  const targetModelName = model || 'Unknown AVR';
  const detectedChannels = buildDetectedChannels(status.ChSetup ?? [], log);
  if (detectedChannels.length === 0) {
    throw new Error('The AVR reported no configured channels');
  }

  const ampAssignIndex = ampAssignType.getIndexByValue(status.AmpAssign);
  if (status.AmpAssign && ampAssignIndex < 0) {
    log.warn(`Unknown AVR amp assignment: ${status.AmpAssign}`);
  }

  const subCount = detectedChannels.filter(channel =>
    channel.commandId.startsWith('SW'),
  ).length;

  return {
    source: 'bridge-live',
    targetModelName,
    title: `${targetModelName} (live)`,
    enMultEQType,
    enAmpAssignType: ampAssignIndex >= 0 ? ampAssignIndex : null,
    ampAssignInfo: status.AssignBin ?? null,
    subwooferNum: status.SWSetup?.SWNum ?? subCount,
    subwooferMode: status.SWSetup?.SWMode ?? null,
    subwooferLayout: status.SWSetup?.SWLayout ?? null,
    spPreset: status.SpPreset ?? null,
    interfaceVersion: info.Ifver ?? null,
    dType: info.DType ?? null,
    detectedChannels,
    avr: new AvrCaracteristics(targetModelName, enMultEQType).toJSON(),
  };
}

function channelIdSignature(avrData) {
  return (avrData?.detectedChannels ?? [])
    .map(channel => channel.commandId)
    .sort((a, b) => a.localeCompare(b))
    .join('|');
}

/**
 * Two AVR data contexts share the same identity when they describe the same
 * amplifier setup: model, MultEQ generation and channel set. A re-synthesis
 * with the same identity refreshes the context in place; a different one
 * means another amplifier and calls for an application reset.
 */
function sameAvrIdentity(left, right) {
  return (
    Boolean(left && right) &&
    left.targetModelName === right.targetModelName &&
    left.enMultEQType === right.enMultEQType &&
    channelIdSignature(left) === channelIdSignature(right)
  );
}

/**
 * Non-blocking coherence check between an imported measurement file and the
 * connected AVR (decision: the bridge stays the configuration authority,
 * files only supply measurements).
 * @returns {string[]} human-readable mismatch descriptions (empty = coherent)
 */
function describeFileMismatch(fileData, liveData) {
  const mismatches = [];
  if (!fileData || !liveData) return mismatches;
  if (
    fileData.targetModelName &&
    fileData.targetModelName !== liveData.targetModelName
  ) {
    mismatches.push(
      `model "${fileData.targetModelName}" (file) vs "${liveData.targetModelName}" (connected AVR)`,
    );
  }
  if (
    fileData.enMultEQType !== undefined &&
    fileData.enMultEQType !== liveData.enMultEQType
  ) {
    mismatches.push(
      `MultEQ type ${fileData.enMultEQType} (file) vs ${liveData.enMultEQType} (connected AVR)`,
    );
  }
  return mismatches;
}

export {
  describeFileMismatch,
  normalizeChannelCode,
  sameAvrIdentity,
  synthesizeAvrData,
};
