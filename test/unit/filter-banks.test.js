import { describe, expect, it } from 'vitest';
import {
  computeFingerprint,
  createFilterBanks,
  describeFingerprintDifferences,
} from '../../src/services/filter-banks.js';

function channelFixture(overrides = {}) {
  return {
    commandId: 'FL',
    speakerType: 'S',
    distanceInMeters: 3.4567,
    trimAdjustmentInDbs: -1.5,
    filter: [1, 0, 0, 0],
    xover: 80,
    ...overrides,
  };
}

function bankPayload(overrides = {}) {
  return {
    channels: [
      channelFixture(),
      channelFixture({ commandId: 'SW1', speakerType: 'E', xover: undefined }),
    ],
    eqType: 2,
    targetCurve: 'harman.txt',
    tcName: 'Harman',
    savedAt: '2026-07-22T10:00:00Z',
    ...overrides,
  };
}

describe('computeFingerprint', () => {
  it('ignores channel order and filter contents', () => {
    const a = computeFingerprint(
      [channelFixture(), channelFixture({ commandId: 'C', filter: [1] })],
      2,
    );
    const b = computeFingerprint(
      [channelFixture({ commandId: 'C', filter: [9, 9] }), channelFixture()],
      2,
    );
    expect(a).toBe(b);
  });

  it('absorbs float noise below a tenth of a millimeter', () => {
    const a = computeFingerprint([channelFixture({ distanceInMeters: 3.45670001 })], 2);
    const b = computeFingerprint([channelFixture({ distanceInMeters: 3.45670002 })], 2);
    expect(a).toBe(b);
  });

  it('changes with trims, crossovers and eqType', () => {
    const base = computeFingerprint([channelFixture()], 2);
    expect(computeFingerprint([channelFixture({ trimAdjustmentInDbs: -2 })], 2)).not.toBe(base);
    expect(computeFingerprint([channelFixture({ xover: 60 })], 2)).not.toBe(base);
    expect(computeFingerprint([channelFixture()], 1)).not.toBe(base);
  });
});

describe('describeFingerprintDifferences', () => {
  it('lists field changes, missing and added channels', () => {
    const left = computeFingerprint(
      [channelFixture(), channelFixture({ commandId: 'C' })],
      2,
    );
    const right = computeFingerprint(
      [channelFixture({ trimAdjustmentInDbs: -3 }), channelFixture({ commandId: 'SW1' })],
      2,
    );
    const differences = describeFingerprintDifferences(left, right);
    expect(differences.join(' | ')).toContain('FL trim');
    expect(differences.join(' | ')).toContain('channel C missing');
    expect(differences.join(' | ')).toContain('channel SW1 added');
  });
});

describe('createFilterBanks', () => {
  it('saves, reads, clears and reports both-loaded state', () => {
    const banks = createFilterBanks();
    expect(banks.bothLoaded()).toBe(false);

    banks.save('reference', bankPayload());
    expect(banks.get('reference').tcName).toBe('Harman');
    expect(banks.bothLoaded()).toBe(false);

    banks.save('flat', bankPayload({ tcName: 'Flat curve' }));
    expect(banks.bothLoaded()).toBe(true);

    banks.clear('flat');
    expect(banks.get('flat')).toBeNull();
    banks.clearAll();
    expect(banks.get('reference')).toBeNull();
  });

  it('refuses a second bank with different non-filter parameters', () => {
    const banks = createFilterBanks();
    banks.save('reference', bankPayload());

    const drifted = bankPayload();
    drifted.channels[0] = channelFixture({ trimAdjustmentInDbs: -4 });

    expect(() => banks.save('flat', drifted)).toThrow(/only the target curve/);
    expect(() => banks.save('flat', drifted)).toThrow(/FL trim/);
    expect(banks.get('flat')).toBeNull();
  });

  it('allows overwriting a bank and re-saving with the same fingerprint', () => {
    const banks = createFilterBanks();
    banks.save('reference', bankPayload());
    banks.save('flat', bankPayload({ tcName: 'Other curve' }));
    banks.save('reference', bankPayload({ tcName: 'Harman v2' }));
    expect(banks.get('reference').tcName).toBe('Harman v2');
  });

  it('duplicates a bank to the other slot', () => {
    const banks = createFilterBanks();
    banks.save('reference', bankPayload());
    banks.duplicateToOther('reference');
    expect(banks.bothLoaded()).toBe(true);
    expect(banks.get('flat').tcName).toBe('Harman');
    expect(() => createFilterBanks().duplicateToOther('flat')).toThrow(/empty/);
  });

  it('rejects unknown banks and empty channel sets', () => {
    const banks = createFilterBanks();
    expect(() => banks.save('middle', bankPayload())).toThrow(/Unknown filter bank/);
    expect(() => banks.save('flat', bankPayload({ channels: [] }))).toThrow(/empty/);
  });

  it('summarizes without exposing the FIRs and round-trips through JSON', () => {
    const banks = createFilterBanks();
    banks.save('reference', bankPayload());

    const summary = banks.summary();
    expect(summary.reference).toEqual({
      loaded: true,
      channelCount: 2,
      targetCurve: 'harman.txt',
      tcName: 'Harman',
      savedAt: '2026-07-22T10:00:00Z',
    });
    expect(summary.flat).toEqual({ loaded: false });

    const restored = createFilterBanks();
    restored.restore(JSON.parse(JSON.stringify(banks.toJSON())));
    expect(restored.get('reference').channels).toHaveLength(2);
    expect(restored.get('flat')).toBeNull();
    restored.restore(null);
    expect(restored.get('reference')).toBeNull();
  });

  it('discards a restored bank whose channels lost their filters', () => {
    // Corruption historique : l'ancien anti-cycle du store droppait les
    // tableaux de filtres partages (clones de sub mutualise) a la
    // serialisation — une banque sans tous ses FIR est inutilisable.
    const banks = createFilterBanks();
    banks.save('reference', bankPayload());
    banks.save('flat', bankPayload({ tcName: 'Flat curve' }));

    const payload = JSON.parse(JSON.stringify(banks.toJSON()));
    delete payload.reference.channels[1].filter;

    const restored = createFilterBanks();
    restored.restore(payload);
    expect(restored.get('reference')).toBeNull();
    expect(restored.get('flat').channels).toHaveLength(2);
  });
});
