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
  // Mutualised sweep codes without a numbered alias, then the shared alias
  // table (SW1..4, SWMIXn, SWL/SWR, SWFL/SWFR/SWBL/SWBR...).
  if (upper === 'SWLFE' || upper === 'SWMIX' || upper === 'LFE') return 'SW1';
  if (upper.startsWith('SW')) return CHANNEL_TYPES.getStandardSubwooferName(upper);
  return upper;
}

// GET_AVRSTS speaker status codes → CHANNEL_TYPES entries, transcribed from
// the official analyzer's exhaustive dispatch
// (GetAVRStatusAnalyzer.createDetectedChannelListjson:176-392 — the table the
// bridge channel plan is built from). Exact-match and total, so the wire
// codes carried by several CHANNEL_TYPES entries (SLA/SRA/SBL, historic .ady
// vocabulary) resolve deterministically — never through a scan of the table.
const STATUS_CODE_CHANNEL_TYPES = Object.freeze({
  FL: 'EnChannelType_FrontLeft',
  FR: 'EnChannelType_FrontRight',
  C: 'EnChannelType_Center',
  SLA: 'EnChannelType_SurrLeftA',
  SRA: 'EnChannelType_SurrRightA',
  SLB: 'EnChannelType_SurrLeftB',
  SRB: 'EnChannelType_SurrRightB',
  SBL: 'EnChannelType_SBackLeft',
  SBR: 'EnChannelType_SBackRight',
  FHL: 'EnChannelType_FrontHeightLeft',
  FHR: 'EnChannelType_FrontHeightRight',
  FWL: 'EnChannelType_FrontWideLeft',
  FWR: 'EnChannelType_FrontWideRight',
  TFL: 'EnChannelType_TopFrontLeft',
  TFR: 'EnChannelType_TopFrontRight',
  TML: 'EnChannelType_TopMiddleLeft',
  TMR: 'EnChannelType_TopMiddleRight',
  TRL: 'EnChannelType_TopBackLeft',
  TRR: 'EnChannelType_TopBackRight',
  RHL: 'EnChannelType_RearHeightLeft',
  RHR: 'EnChannelType_RearHeightRight',
  FDL: 'EnChannelType_FrontDolbyLeft',
  FDR: 'EnChannelType_FrontDolbyRight',
  SDL: 'EnChannelType_SurrDolbyLeft',
  SDR: 'EnChannelType_SurrDolbyRight',
  BDL: 'EnChannelType_SBDolbyLeft',
  BDR: 'EnChannelType_SBDolbyRight',
  SHL: 'EnChannelType_SurrHeightLeft',
  SHR: 'EnChannelType_SurrHeightRight',
  CH: 'EnChannelType_FrontHeightCenter',
  TS: 'EnChannelType_Overhead',
});

// Official single-back-speaker rule (GetAVRStatusAnalyzer
// convJsonArrtoChannelArr:157-167): a connected SBL without a connected SBR
// is a back CENTER speaker, forced Small. The wire code stays SBL.
function reclassifySingleSBack(channels) {
  const left = channels.find(
    channel =>
      channel.enChannelType === CHANNEL_TYPES.EnChannelType_SBackLeft.channelIndex,
  );
  if (!left || (left.speakerSize ?? 'N') === 'N') return;
  const right = channels.find(channel => channel.commandId === 'SBR');
  if (right && (right.speakerSize ?? 'N') !== 'N') return;
  left.enChannelType = CHANNEL_TYPES.EnChannelType_SBackCenter.channelIndex;
  left.speakerSize = 'S';
}

// Every ChSetup subwoofer is kept REGARDLESS of the SWMode (decision
// 2026-07-23, REGLES-METIER): even in Standard mode the AVR exposes its
// subwoofers and accepts per-sub filters/gains/delays (A1Evo lineage —
// Directional is a MEASUREMENT mode; SET_SETDAT echoes the live SWSetup).
// Never collapse SW2..SW4 outside Directional: it would strip the per-sub
// calibration the Standard end state relies on.
function buildDetectedChannels(chSetup, log) {
  const channels = [];
  for (const entry of chSetup) {
    const [wireCode, speakerSize] = Object.entries(entry ?? {})[0] ?? [];
    if (!wireCode) continue;
    const commandId = normalizeChannelCode(wireCode);
    // Subwoofer SW1..4 ids resolve through the deterministic SW branch of
    // getByCode; every speaker code must be in the official table.
    const channelType =
      CHANNEL_TYPES[STATUS_CODE_CHANNEL_TYPES[commandId]] ??
      (commandId.startsWith('SW') ? CHANNEL_TYPES.getByCode(commandId) : null);
    if (!channelType) {
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
  reclassifySingleSBack(channels);
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
/**
 * File-import SPL convention of a model (`AvrCaracteristics.splOffset`:
 * 105 dB on Cirrus-DSP models, 80 dB otherwise). Also applied to the
 * bridge-measured IRs — same GET_RESPONSE domain as the `.ady` responseData:
 * a deconvolved transfer function whose digital scale is NOT the raw ADC
 * capture, so the capture-domain anchor `levelReference.dbSplAtFullScale`
 * must never be used at import (decision 2026-07-23).
 *
 * @param {string} [model] AVR model name (empty/unknown → 80 dB).
 * @param {string} [eqTypeName] `GET /avr/info` EQType wire name.
 */
function modelSplOffset(model, eqTypeName) {
  const enMultEQType = EQ_TYPE_BY_NAME[eqTypeName] ?? 2;
  try {
    return new AvrCaracteristics(model || 'Unknown AVR', enMultEQType).splOffset;
  } catch {
    return 80;
  }
}

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
  modelSplOffset,
  normalizeChannelCode,
  sameAvrIdentity,
  synthesizeAvrData,
};
