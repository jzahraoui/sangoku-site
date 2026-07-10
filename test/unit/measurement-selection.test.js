import { describe, expect, it } from 'vitest';
import {
  assertAveragingConsistency,
  filterPredictedLfe,
  findPredictedLfeForPosition,
  groupByChannel,
  groupByPosition,
  positionChoices,
  quantize3dB,
} from '../../src/measurement/measurement-selection.js';

// Items can expose getters (Knockout style) or plain fields (record style):
// both shapes must work (ADR 002 transition).
const koItem = (channelName, position, title = `${channelName}_P0${position}`) => ({
  channelName: () => channelName,
  position: () => position,
  displayPositionText: () => `Pos. ${position}/3`,
  title: () => title,
});

describe('groupByChannel', () => {
  it('groups items by channel and counts them', () => {
    const groups = groupByChannel([koItem('FL', 1), koItem('FL', 2), koItem('C', 1)]);
    expect(groups.FL.count).toBe(2);
    expect(groups.C.count).toBe(1);
  });

  it('skips unknown channels', () => {
    const unknown = { ...koItem('UNKNOWN', 1), isUnknownChannel: true };
    expect(groupByChannel([unknown])).toEqual({});
  });

  it('accepts plain-record items', () => {
    const groups = groupByChannel([{ channelName: 'SW1', position: 1 }]);
    expect(groups.SW1.count).toBe(1);
  });
});

describe('groupByPosition', () => {
  it('groups by listening position', () => {
    const groups = groupByPosition([koItem('SW1', 1), koItem('SW2', 1), koItem('SW1', 2)]);
    expect(groups[1]).toHaveLength(2);
    expect(groups[2]).toHaveLength(1);
  });
});

describe('positionChoices', () => {
  it('deduplicates and sorts positions', () => {
    const choices = positionChoices([
      koItem('FL', 2),
      koItem('C', 1),
      koItem('FR', 1),
    ]);
    expect(choices).toEqual([
      { value: 1, text: 'Pos. 1/3' },
      { value: 2, text: 'Pos. 2/3' },
    ]);
  });

  it('ignores falsy positions', () => {
    expect(positionChoices([koItem('FL', 0)])).toEqual([]);
  });
});

describe('predicted LFE selectors', () => {
  const items = [
    koItem('FL', 1),
    koItem('SW1', 1, 'LFE predicted_P1'),
    koItem('SW1', 2, 'LFE predicted_P2'),
  ];

  it('filters predicted LFE measurements', () => {
    expect(filterPredictedLfe(items)).toHaveLength(2);
  });

  it('finds the predicted LFE for a position', () => {
    expect(findPredictedLfeForPosition(items, 2).title()).toBe('LFE predicted_P2');
    expect(findPredictedLfeForPosition(items, 9)).toBeUndefined();
    expect(findPredictedLfeForPosition(items, null)).toBeUndefined();
  });
});

describe('quantize3dB', () => {
  it('quantizes on 0.3 dB steps', () => {
    expect(quantize3dB(0.4)).toBeCloseTo(0.3);
    expect(quantize3dB(-0.44)).toBeCloseTo(-0.3);
    expect(quantize3dB(0)).toBe(0);
  });
});

describe('assertAveragingConsistency', () => {
  const snapshot = (title, alignOffset = 0, quantizedSpl = 0, inverted = false) => ({
    title,
    alignOffset,
    quantizedSpl,
    inverted,
  });

  it('accepts consistent snapshots', () => {
    expect(() =>
      assertAveragingConsistency([snapshot('FL_P01'), snapshot('FL_P02')]),
    ).not.toThrow();
  });

  it('requires at least two snapshots', () => {
    expect(() => assertAveragingConsistency([snapshot('FL_P01')])).toThrow(
      'Need at least 2 valid positions',
    );
  });

  it('rejects inconsistent align offsets', () => {
    expect(() =>
      assertAveragingConsistency([snapshot('FL_P01', 0), snapshot('FL_P02', 1.5)]),
    ).toThrow(/inconsistent SPL alignment offsets: FL_P02/);
  });

  it('rejects inverted measurements', () => {
    expect(() =>
      assertAveragingConsistency([
        snapshot('FL_P01'),
        snapshot('FL_P02', 0, 0, true),
      ]),
    ).toThrow(/appear to be inverted: FL_P02/);
  });

  it('rejects inconsistent SPL offsets, reporting the dominant value', () => {
    expect(() =>
      assertAveragingConsistency([
        snapshot('FL_P01', 0, 0.3),
        snapshot('FL_P02', 0, 0.3),
        snapshot('FL_P03', 0, 0.6),
      ]),
    ).toThrow(/inconsistent SPL offsets: FL_P03 expected 0.3dB/);
  });
});
