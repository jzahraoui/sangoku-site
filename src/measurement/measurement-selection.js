import { DEFAULT_LFE_PREDICTED } from './measurement-info.js';

/**
 * Pure list selection/grouping logic extracted from MeasurementViewModel
 *.
 *
 * [MOTEUR] module. Items are read through `unwrap`, so the functions accept
 * both today's Knockout items (getter observables) and tomorrow's plain
 * records (ADR 002) without modification.
 */

const ALIGN_OFFSET_TOLERANCE = 0.005; // 2-decimal precision tolerance

/** Quantize an SPL value on the AVR's 3 dB steps grid. */
const quantize3dB = v => (Math.round((v * 10) / 3) * 3) / 10;

const unwrap = value => (typeof value === 'function' ? value() : value);

/** Group measurements by channel name: { FL: {items, count}, … }. */
function groupByChannel(items) {
  const groups = {};
  for (const item of items) {
    if (item.isUnknownChannel) continue;

    const channelName = unwrap(item.channelName);
    let group = groups[channelName];
    if (!group) {
      group = { items: [], count: 0 };
      groups[channelName] = group;
    }
    group.items.push(item);
    group.count++;
  }
  return groups;
}

/** Group measurements by listening position: { 1: [...], 2: [...] }. */
function groupByPosition(items) {
  const groups = {};
  for (const item of items) {
    const key = unwrap(item.position);
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(item);
  }
  return groups;
}

/** Sorted, de-duplicated position choices: [{value, text}]. */
function positionChoices(items) {
  const seen = new Map();
  for (const item of items) {
    const pos = unwrap(item.position);
    if (pos && !seen.has(pos)) {
      seen.set(pos, { value: pos, text: unwrap(item.displayPositionText) });
    }
  }
  return [...seen.values()].sort((a, b) => a.text.localeCompare(b.text));
}

function filterPredictedLfe(items) {
  return items.filter(item => unwrap(item?.title)?.startsWith(DEFAULT_LFE_PREDICTED));
}

function findPredictedLfeForPosition(items, position) {
  if (position === undefined || position === null) return undefined;
  const title = `${DEFAULT_LFE_PREDICTED}${position}`;
  return filterPredictedLfe(items).find(item => unwrap(item?.title) === title);
}

/**
 * Validate that measurements are consistent enough to be averaged.
 * `snapshots` are plain objects {title, alignOffset, quantizedSpl, inverted}.
 * Throws with the exact messages historically produced by the viewmodel.
 */
/** Clé la plus fréquente d'une Map de comptages (fallback si vide). */
function mostCommonKey(counts, fallback) {
  let best = fallback;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = value;
    }
  }
  return best;
}

function assertAveragingConsistency(snapshots, tolerance = ALIGN_OFFSET_TOLERANCE) {
  if (snapshots.length < 2) {
    throw new Error('Need at least 2 valid positions to calculate average');
  }

  const referenceAlignOffset = snapshots[0].alignOffset;
  const referenceQuantized = snapshots[0].quantizedSpl;
  const inconsistentAlignOffsets = [];
  const inconsistentInvertedMeasurements = [];
  const inconsistentQuantizedTitles = [];
  const quantizedCounts = new Map();

  for (const s of snapshots) {
    if (
      Math.abs(s.alignOffset - referenceAlignOffset) > tolerance &&
      Math.abs(s.alignOffset) > tolerance
    ) {
      inconsistentAlignOffsets.push(s.title);
    }
    if (s.inverted) {
      inconsistentInvertedMeasurements.push(s.title);
    }

    quantizedCounts.set(s.quantizedSpl, (quantizedCounts.get(s.quantizedSpl) ?? 0) + 1);
    if (s.quantizedSpl !== referenceQuantized) {
      inconsistentQuantizedTitles.push(s.title);
    }
  }

  if (inconsistentAlignOffsets.length > 0) {
    throw new Error(
      `Some measurements have inconsistent SPL alignment offsets: ${inconsistentAlignOffsets.join(
        ', ',
      )}`,
    );
  }

  if (inconsistentInvertedMeasurements.length > 0) {
    throw new Error(
      `Some measurements appear to be inverted: ${inconsistentInvertedMeasurements.join(
        ', ',
      )}`,
    );
  }

  if (quantizedCounts.size > 1) {
    const mostCommonOffset = mostCommonKey(quantizedCounts, referenceQuantized);
    throw new Error(
      `Some measurements have inconsistent SPL offsets: ${inconsistentQuantizedTitles.join(
        ', ',
      )} expected ${mostCommonOffset.toFixed(1)}dB`,
    );
  }
}

export {
  ALIGN_OFFSET_TOLERANCE,
  assertAveragingConsistency,
  filterPredictedLfe,
  findPredictedLfeForPosition,
  groupByChannel,
  groupByPosition,
  positionChoices,
  quantize3dB,
};
