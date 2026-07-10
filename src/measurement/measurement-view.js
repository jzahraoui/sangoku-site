import {
  DEFAULT_LFE_PREDICTED,
  UNKNOWN_GROUP_NAME,
  channelDetailsFor,
  channelNameFromTitle,
  isSubChannel,
} from './measurement-info.js';

/**
 * Pure list-level derivations extracted from MeasurementViewModel /
 * MeasurementItem (lot É4a — portage Vue). Given the flat MeasurementRecords
 * (ADR 002), the detected AVR channels and the currently selected listening
 * position, this rebuilds every grouped/filtered list the KO viewmodel exposed
 * as pureComputeds (validMeasurements, uniqueMeasurements, grouped, …) — the
 * arguments the averaging/alignment services consume.
 *
 * [MOTEUR] module: no Knockout, no DOM, no Vue. Records are read through
 * `titleOf`, so KO items (title observable) and plain records (title string)
 * both work.
 */

// Mirror of BusinessTools.RESULT_PREFIX / AVERAGE_SUFFIX (kept here to avoid
// importing the Knockout-coupled BusinessTools into a moteur module — same
// mirroring precedent as DEFAULT_LFE_PREDICTED in measurement-info.js).
const RESULT_PREFIX = 'final ';
const AVERAGE_SUFFIX = 'avg';

const titleOf = record =>
  typeof record?.title === 'function' ? record.title() : record?.title;

const isAverageTitle = title => String(title ?? '').endsWith(AVERAGE_SUFFIX);
const isPredictedTitle = title => String(title ?? '').startsWith(RESULT_PREFIX);
const isLfePredictedTitle = title =>
  String(title ?? '').startsWith(DEFAULT_LFE_PREDICTED);

/**
 * Per-record derived identity — the counterpart of MeasurementItem's
 * channelName/isSub/isAverage/isPredicted/isLfePredicted getters.
 */
function deriveIdentity(record, detectedChannels) {
  const title = titleOf(record);
  const channelName = channelNameFromTitle(title);
  const channelDetails = channelDetailsFor(
    channelName,
    detectedChannels,
    record?.haveImpulseResponse,
  );
  return {
    record,
    title,
    channelName,
    channelDetails,
    isSub: isSubChannel(channelDetails),
    isUnknownChannel: channelName === UNKNOWN_GROUP_NAME,
    isAverage: isAverageTitle(title),
    isPredicted: isPredictedTitle(title),
    isLfePredicted: isLfePredictedTitle(title),
  };
}

/**
 * Group descriptors by channel (order-preserving, unknown channels excluded) —
 * the basis for the per-position index, like MeasurementViewModel.groupedMeasurements.
 */
function groupByChannelName(descriptors) {
  const grouped = {};
  for (const descriptor of descriptors) {
    if (descriptor.isUnknownChannel) continue;
    const group = (grouped[descriptor.channelName] ??= { items: [], count: 0 });
    group.items.push(descriptor.record);
    group.count++;
  }
  return grouped;
}

/** Assigns position / validity / selection onto each descriptor in place. */
function assignPositionAndFlags(descriptor, grouped, currentSelectedPosition) {
  const group = grouped[descriptor.channelName];
  if (group) {
    const position = group.items.indexOf(descriptor.record) + 1;
    descriptor.position = position;
    descriptor.displayPositionText = descriptor.isAverage
      ? 'Average'
      : `Pos. ${position}/${group.count}`;
  } else {
    descriptor.position = 0;
    descriptor.displayPositionText = '';
  }
  descriptor.isValidPosition = Boolean(descriptor.position);
  descriptor.isValid =
    descriptor.isValidPosition &&
    !descriptor.isPredicted &&
    !descriptor.isUnknownChannel &&
    !descriptor.isLfePredicted;
  descriptor.isSelected = currentSelectedPosition === descriptor.position;
}

/** Sorted, de-duplicated position choices (parity with positionChoices). */
function buildPositionList(descriptors) {
  const seen = new Map();
  for (const descriptor of descriptors) {
    if (descriptor.position && !seen.has(descriptor.position)) {
      seen.set(descriptor.position, {
        value: descriptor.position,
        text: descriptor.displayPositionText,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.text.localeCompare(b.text));
}

/**
 * Full derivation pass over the measurement list.
 *
 * @param {Array} records - MeasurementRecords (or KO items).
 * @param {Object} options
 * @param {Array}  options.detectedChannels - AVR detected channels.
 * @param {*}      options.currentSelectedPosition - selected listening position.
 * @returns derived lists + a per-record descriptor map.
 */
function deriveMeasurements(
  records = [],
  { detectedChannels = [], currentSelectedPosition = null } = {},
) {
  const descriptors = records.map(record => deriveIdentity(record, detectedChannels));
  const grouped = groupByChannelName(descriptors);
  for (const descriptor of descriptors) {
    assignPositionAndFlags(descriptor, grouped, currentSelectedPosition);
  }

  const pick = predicate =>
    descriptors.filter(descriptor => predicate(descriptor)).map(d => d.record);
  const uniqueSpeakersMeasurements = pick(d => d.isSelected && !d.isSub);

  return {
    descriptors,
    byRecord: new Map(descriptors.map(d => [d.record, d])),
    grouped,
    validMeasurements: pick(d => d.isValid),
    uniqueMeasurements: pick(d => d.isSelected),
    uniqueSpeakersMeasurements,
    uniqueSubsMeasurements: pick(d => d.isSelected && d.isSub),
    subsMeasurements: pick(d => d.isSub),
    // subs + sub-operation results (parity with VM.subsLikeMeasurements)
    subsLikeMeasurements: pick(d => d.isSub || d.record.isSubOperationResult),
    allPredictedLfeMeasurement: pick(d => d.isLfePredicted),
    positionList: buildPositionList(descriptors),
    firstMeasurement: uniqueSpeakersMeasurements[0] ?? null,
  };
}

/**
 * Same-channel measurements at other listening positions (parity with
 * MeasurementItem.otherPositionMeasurements): valid measurements sharing the
 * channel, excluding the record itself and its own position.
 */
function otherPositionMeasurements(record, derived) {
  const self = derived.byRecord.get(record);
  if (!self) {
    return [];
  }
  return derived.validMeasurements.filter(other => {
    const descriptor = derived.byRecord.get(other);
    return (
      descriptor.channelName === self.channelName &&
      other.uuid !== record.uuid &&
      descriptor.position !== self.position
    );
  });
}

export {
  AVERAGE_SUFFIX,
  RESULT_PREFIX,
  deriveIdentity,
  deriveMeasurements,
  otherPositionMeasurements,
  isAverageTitle,
  isLfePredictedTitle,
  isPredictedTitle,
};
