import { CHANNEL_TYPES } from '../audyssey.js';

/**
 * Pure measurement-identity derivations extracted from MeasurementItem
 *.
 *
 * [MOTEUR] module: every function maps plain inputs to a value; reactive
 * wiring stays in the viewmodels (or any future UI layer).
 */

const UNKNOWN_GROUP_NAME = 'UNKNOWN';
const AVR_MAX_GAIN = 12;
const DEFAULT_LFE_PREDICTED = 'LFE predicted_P';
const SUB_GROUP_NAME = 'Subwoofer';
const FEET_PER_METER = 3.28084;

/** Channel code (FL, C, SW1…) inferred from a measurement title. */
function channelNameFromTitle(title) {
  return CHANNEL_TYPES.getBestMatchCode(title) || UNKNOWN_GROUP_NAME;
}

/** AVR channel details for a channel code, from the detected-channels list. */
function channelDetailsFor(channelName, detectedChannels, haveImpulseResponse = true) {
  if (!haveImpulseResponse) return null;
  const foundChannel = detectedChannels?.find(
    channel => channel.commandId === channelName,
  );
  return CHANNEL_TYPES.getByChannelIndex(foundChannel?.enChannelType);
}

function groupNameFor(channelDetails) {
  return channelDetails?.group || 'Unknown';
}

function isSubChannel(channelDetails) {
  return channelDetails?.group === SUB_GROUP_NAME;
}

/** AVR speaker type: E = sub, L = large (full range), S = small (crossover). */
function speakerTypeFor(isSub, crossover) {
  if (isSub) return 'E';
  return crossover === 0 ? 'L' : 'S';
}

/** IR left-window width used by working settings (ms). */
function leftWindowWidthMilliseconds(isSub) {
  return isSub ? 70 : 30;
}

/** SPL trim as sent to the AVR: rounded to 0.5 dB steps. */
function splForAvr(splOffsetDeltadB) {
  return Math.round(splOffsetDeltadB * 2) / 2;
}

function splIsAboveLimit(splForAvrValue, maxGain = AVR_MAX_GAIN) {
  return Math.abs(splForAvrValue) > maxGain;
}

/** Distance expressed in the display unit ('M' | 'ms' | 'ft'). */
function distanceInUnit(unit, distanceInMeters, cumulativeIRShiftSeconds) {
  if (unit === 'M') return distanceInMeters;
  if (unit === 'ms') return cumulativeIRShiftSeconds * 1000;
  if (unit === 'ft') return distanceInMeters * FEET_PER_METER;
  throw new Error(`Unknown distance unit: ${unit}`);
}

/** 'normal' | 'warning' | 'error' against the AVR distance limits. */
function distanceSeverity(currentDistance, maxWarningDistance, maxErrorDistance) {
  if (Number.isNaN(maxErrorDistance) || Number.isNaN(maxWarningDistance)) {
    return 'normal';
  }
  if (currentDistance > maxErrorDistance || currentDistance < 0) {
    return 'error';
  }
  if (currentDistance > maxWarningDistance) {
    return 'warning';
  }
  return 'normal';
}

/** Title of the predicted-LFE measurement for a listening position. */
function predictedLfeTitle(position) {
  return `${DEFAULT_LFE_PREDICTED}${position}`;
}

export {
  AVR_MAX_GAIN,
  DEFAULT_LFE_PREDICTED,
  FEET_PER_METER,
  SUB_GROUP_NAME,
  UNKNOWN_GROUP_NAME,
  channelDetailsFor,
  channelNameFromTitle,
  distanceInUnit,
  distanceSeverity,
  groupNameFor,
  isSubChannel,
  leftWindowWidthMilliseconds,
  predictedLfeTitle,
  speakerTypeFor,
  splForAvr,
  splIsAboveLimit,
};
