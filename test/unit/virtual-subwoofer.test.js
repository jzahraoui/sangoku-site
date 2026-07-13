import { describe, expect, it, vi } from 'vitest';
import { MeasurementRecord } from '../../src/measurement/measurement-record.js';
import {
  VirtualSubwoofer,
  createVirtualSubwooferService,
} from '../../src/services/virtual-subwoofer.js';

const FREQS = [20, 40, 80];

function makeResponse(magnitudeDb, phaseDeg = 0) {
  return {
    freqs: [...FREQS],
    freqStep: null,
    ppo: 96,
    magnitude: Float32Array.from(FREQS.map(() => magnitudeDb)),
    phase: Float32Array.from(FREQS.map(() => phaseDeg)),
  };
}

function makeSub(uuid, title) {
  const record = new MeasurementRecord({
    uuid,
    title,
    splOffsetdB: 0,
    alignSPLOffsetdB: 0,
    inverted: false,
    cumulativeIRShiftSeconds: 0,
    timeOfIRPeakSeconds: 0,
    shiftDelay: 0,
  });
  return {
    uuid,
    title: () => title,
    record,
    position: () => '1',
    removeWorkingSettings: vi.fn().mockResolvedValue(true),
    applyWorkingSettings: vi.fn().mockResolvedValue(true),
    resetTargetSettings: vi.fn().mockResolvedValue(true),
    setTitle: vi.fn().mockResolvedValue(true),
    addSPLOffsetDB: vi.fn().mockResolvedValue(true),
    addIROffsetSeconds: vi.fn().mockResolvedValue(true),
    setInverted: vi.fn().mockResolvedValue(true),
    resetFilters: vi.fn().mockResolvedValue(true),
    setFilters: vi.fn().mockResolvedValue(true),
  };
}

function harness({ responses = {}, subsByPosition = {} } = {}) {
  const state = {
    imports: [],
    removedUuids: [],
    removedItems: [],
    list: [],
    projCounter: 0,
  };
  const session = {
    rewMeasurements: {
      getPredictedFrequencyResponse: vi
        .fn()
        .mockImplementation(async uuid => responses[uuid] ?? makeResponse(60)),
    },
    rewImport: {
      importImpulseResponseData: vi.fn().mockImplementation(async options => {
        state.imports.push(options);
      }),
    },
    measurements: { get: () => state.list },
    removeMeasurements: vi.fn().mockImplementation(async items => {
      state.removedItems.push(...items);
      state.list = state.list.filter(item => !items.includes(item));
    }),
    removeMeasurementUuid: vi.fn().mockImplementation(async uuid => {
      state.removedUuids.push(uuid);
      state.list = state.list.filter(item => item.uuid !== uuid);
    }),
    findMeasurementByUuid: uuid => state.list.find(item => item.uuid === uuid) ?? null,
    addMeasurementFromRewOperation: vi.fn().mockImplementation(async operation => {
      await operation();
      const projection = {
        uuid: `proj-${++state.projCounter}`,
        title: () => 'imported',
        setTitle: vi.fn().mockResolvedValue(true),
        applyWorkingSettings: vi.fn().mockResolvedValue(true),
        removeWorkingSettings: vi.fn().mockResolvedValue(true),
        resetTargetSettings: vi.fn().mockResolvedValue(true),
      };
      state.list.push(projection);
      return projection;
    }),
  };
  const service = createVirtualSubwooferService({
    session,
    getSubsByPosition: () => subsByPosition,
  });
  return { session, service, state };
}

describe('VirtualSubwoofer.refresh', () => {
  it('sums the predicted responses of two subs and projects the result', async () => {
    const sub1 = makeSub('sw1', 'SW1avg');
    const sub2 = makeSub('sw2', 'SW2avg');
    const { session, service, state } = harness({
      responses: { sw1: makeResponse(60, 0), sw2: makeResponse(60, 0) },
      subsByPosition: { 1: [sub1, sub2] },
    });

    const projection = await service.refresh('1');

    // Per-sub sequence: full-range predicted response, working settings restored.
    for (const sub of [sub1, sub2]) {
      expect(sub.removeWorkingSettings).toHaveBeenCalledTimes(1);
      expect(sub.resetTargetSettings).toHaveBeenCalledTimes(1);
      expect(sub.applyWorkingSettings).toHaveBeenCalledTimes(1);
    }
    expect(session.rewMeasurements.getPredictedFrequencyResponse).toHaveBeenCalledTimes(2);

    // Two identical in-phase 60 dB responses sum to +6.02 dB.
    const sum = await service.subwooferFor('1').response([sub1, sub2]);
    expect(sum.magnitude[0]).toBeCloseTo(66.02, 1);

    // The projection is imported as an IMPULSE response (ADR 003).
    expect(state.imports).toHaveLength(1);
    const options = state.imports[0];
    expect(options.identifier).toBe('LFE predicted_P1');
    expect(options.data).toBeInstanceOf(Float32Array);
    expect(options.sampleRate).toBe(48000);
    expect(options.splOffset).toBe(0);
    // Centered impulse + matching negative startTime: physical times are
    // preserved and the pre-t=0 content (negative delays, zero-phase Theo)
    // is not wrapped/discarded by REW.
    expect(options.startTime).toBeCloseTo(-options.data.length / 2 / 48000, 9);

    // The projection is owned, titled, post-processed and flagged (transition).
    expect(projection.uuid).toBe('proj-1');
    expect(projection.setTitle).toHaveBeenCalledWith(
      'LFE predicted_P1',
      expect.stringContaining('SW1avg'),
    );
    expect(projection.applyWorkingSettings).toHaveBeenCalledTimes(1);
    expect(projection.isSubOperationResult).toBe(true);
    expect(service.subwooferFor('1').projectionUuid).toBe('proj-1');
  });

  it('passes through a single sub (N = 1 is not a special case)', async () => {
    const sub = makeSub('sw1', 'SW1avg');
    const { service, state } = harness({
      responses: { sw1: makeResponse(72, 30) },
      subsByPosition: { 1: [sub] },
    });

    await service.refresh('1');
    expect(state.imports).toHaveLength(1);

    const sum = await service.subwooferFor('1').response([sub]);
    expect(sum.magnitude[1]).toBeCloseTo(72, 3);
    expect(sum.phase[1]).toBeCloseTo(30, 3);
  });

  it('replaces its previous projection and legacy same-title measurements', async () => {
    const sub = makeSub('sw1', 'SW1avg');
    const { service, state } = harness({ subsByPosition: { 1: [sub] } });
    const legacy = { uuid: 'legacy', title: () => 'LFE predicted_P1' };
    state.list.push(legacy);

    await service.refresh('1');
    // The same-title survivor is adopted then replaced (removed by uuid).
    expect(state.removedUuids).toContain('legacy');
    expect(state.imports).toHaveLength(1);

    await service.refresh('1', { force: true });
    expect(state.removedUuids).toContain('proj-1');
    expect(state.imports).toHaveLength(2);
    expect(service.subwooferFor('1').projectionUuid).toBe('proj-2');
  });

  it('is a no-op when clean and projected; record changes mark it dirty', async () => {
    const sub = makeSub('sw1', 'SW1avg');
    const { service, state } = harness({ subsByPosition: { 1: [sub] } });

    await service.refresh('1');
    expect(state.imports).toHaveLength(1);

    // Clean + projected → no new import without force.
    const kept = await service.refresh('1');
    expect(state.imports).toHaveLength(1);
    expect(kept.uuid).toBe('proj-1');

    // An API delta on a real sub marks the virtual sub dirty.
    sub.record.update({ splOffsetdB: 3 });
    await service.refresh('1');
    expect(state.imports).toHaveLength(2);
  });

  it('removes the projection when the position has no sub left', async () => {
    const sub = makeSub('sw1', 'SW1avg');
    const groups = { 1: [sub] };
    const { service, state } = harness({ subsByPosition: groups });

    await service.refresh('1');
    expect(state.imports).toHaveLength(1);

    groups['1'] = [];
    const projection = await service.refresh('1');
    expect(projection).toBeNull();
    expect(state.removedUuids).toContain('proj-1');
    expect(service.subwooferFor('1').projectionUuid).toBeNull();
  });

  it('refreshAll covers every position and drops gone positions', async () => {
    const sub1 = makeSub('sw1', 'SW1avg');
    const sub2 = makeSub('sw2', 'SW2avg');
    const groups = { 1: [sub1], 2: [sub2] };
    const { service, state } = harness({ subsByPosition: groups });

    const projections = await service.refreshAll();
    expect(projections).toHaveLength(2);
    expect(state.imports.map(options => options.identifier)).toEqual([
      'LFE predicted_P1',
      'LFE predicted_P2',
    ]);

    delete groups['2'];
    await service.refreshAll({ force: true });
    // P2's projection is removed with its instance.
    expect(state.removedUuids).toContain('proj-2');
  });

  it('routes through the operations functions when injected (ADR 002)', async () => {
    const record = makeSub('sw1', 'SW1avg').record;
    record.position = '1';
    const operations = {
      removeWorkingSettings: vi.fn().mockResolvedValue(true),
      applyWorkingSettings: vi.fn().mockResolvedValue(true),
      resetTargetSettings: vi.fn().mockResolvedValue(true),
      setTitle: vi.fn().mockResolvedValue(true),
    };
    const state = { list: [] };
    const session = {
      rewMeasurements: {
        getPredictedFrequencyResponse: vi.fn().mockResolvedValue(makeResponse(60)),
      },
      rewImport: { importImpulseResponseData: vi.fn().mockResolvedValue(undefined) },
      measurements: { get: () => state.list },
      removeMeasurements: vi.fn().mockResolvedValue(undefined),
      removeMeasurementUuid: vi.fn().mockResolvedValue(undefined),
      findMeasurementByUuid: () => null,
      addMeasurementFromRewOperation: vi.fn().mockImplementation(async operation => {
        await operation();
        return { uuid: 'proj-1' };
      }),
    };
    const irWindowWidthsFor = vi.fn().mockReturnValue({ left: 1, right: 2 });
    const workingSettingsConfig = vi.fn().mockReturnValue({ smoothing: '1/6' });
    const service = createVirtualSubwooferService({
      session,
      operations,
      irWindowWidthsFor,
      workingSettingsConfig,
      getSubsByPosition: () => ({ 1: [record] }),
    });

    await service.refresh('1');

    expect(operations.removeWorkingSettings).toHaveBeenCalledWith(
      session.rewMeasurements,
      record,
      { left: 1, right: 2 },
    );
    expect(operations.applyWorkingSettings).toHaveBeenCalledWith(
      session.rewMeasurements,
      record,
      { smoothing: '1/6' },
    );
    expect(operations.setTitle).toHaveBeenCalledWith(
      session.rewMeasurements,
      { uuid: 'proj-1', isSubOperationResult: true },
      'LFE predicted_P1',
      expect.any(String),
    );
  });
});

describe('VirtualSubwoofer.watch', () => {
  it('unsubscribes from subs that leave the group and on dispose', async () => {
    const sub1 = makeSub('sw1', 'SW1avg');
    const sub2 = makeSub('sw2', 'SW2avg');
    const virtualSub = new VirtualSubwoofer({
      position: 'P1',
      session: { measurements: { get: () => [] } },
      mops: {},
      log: { info: () => {} },
    });

    virtualSub.watch([sub1, sub2]);
    virtualSub.dirty = false;
    sub2.record.update({ splOffsetdB: 1 });
    expect(virtualSub.dirty).toBe(true);

    virtualSub.watch([sub1]);
    virtualSub.dirty = false;
    sub2.record.update({ splOffsetdB: 2 });
    expect(virtualSub.dirty).toBe(false);

    virtualSub.dispose();
    sub1.record.update({ splOffsetdB: 2 });
    expect(virtualSub.dirty).toBe(false);
  });

  it('ignores derived time-field echoes but keeps real changes', () => {
    const sub1 = makeSub('sw1', 'SW1avg');
    const virtualSub = new VirtualSubwoofer({
      position: 'P1',
      session: { measurements: { get: () => [] } },
      mops: {},
      log: { info: () => {} },
    });

    virtualSub.watch([sub1]);
    virtualSub.dirty = false;

    // Poll echo after a fractional offsetTZero: REW recomputes the derived
    // time fields — the sum did not change.
    sub1.record.update({ timeOfIRPeakSeconds: 0.123, timeOfIRStartSeconds: 0.1 });
    expect(virtualSub.dirty).toBe(false);

    // A real delay change (cumulative shift) still marks dirty.
    sub1.record.update({ cumulativeIRShiftSeconds: 0.005, timeOfIRPeakSeconds: 0.118 });
    expect(virtualSub.dirty).toBe(true);
  });

  it('markConsistent clears the dirty flag left by the caller own writes', () => {
    const sub1 = makeSub('sw1', 'SW1avg');
    const virtualSub = new VirtualSubwoofer({
      position: 'P1',
      session: { measurements: { get: () => [] } },
      mops: {},
      log: { info: () => {} },
    });

    virtualSub.watch([sub1]);
    sub1.record.update({ splOffsetdB: 1 });
    expect(virtualSub.dirty).toBe(true);

    virtualSub.markConsistent();
    expect(virtualSub.dirty).toBe(false);

    // A later change marks it dirty again.
    sub1.record.update({ splOffsetdB: 2 });
    expect(virtualSub.dirty).toBe(true);
  });
});

describe('VirtualSubwoofer — adoption et refreshProjected', () => {
  it('adopts a restored same-title projection and replaces it', async () => {
    const sub = makeSub('sw1', 'SW1avg');
    const { service, state } = harness({ subsByPosition: { 1: [sub] } });
    const restored = { uuid: 'restored', title: () => 'LFE predicted_P1' };
    state.list.push(restored);

    const projections = await service.refreshProjected({ force: true });

    expect(projections).toHaveLength(1);
    expect(state.removedUuids).toContain('restored');
    expect(state.imports).toHaveLength(1);
    expect(service.subwooferFor('1').projectionUuid).toBe('proj-1');
  });

  it('refreshProjected leaves positions without projection untouched', async () => {
    const sub = makeSub('sw1', 'SW1avg');
    const { service, state } = harness({ subsByPosition: { 1: [sub] } });

    const projections = await service.refreshProjected({ force: true });

    expect(projections).toHaveLength(0);
    expect(state.imports).toHaveLength(0);
  });

  it('normalizes position keys between string and number callers', async () => {
    const sub = makeSub('sw1', 'SW1avg');
    const { service, state } = harness({ subsByPosition: { 1: [sub] } });

    await service.refresh(1, { force: true });
    expect(service.subwooferFor('1').projectionUuid).toBe('proj-1');
    expect(service.subwooferFor(1)).toBe(service.subwooferFor('1'));
    expect(state.imports).toHaveLength(1);
  });
});

describe('Theo — somme idéale à phase nulle (ADR 003 v2)', () => {
  it('projects Theo alongside the predicted sum once enabled', async () => {
    // Two identical responses in ANTI-phase: the real sum cancels out, the
    // zero-phase (ideal) sum adds up to +6.02 dB.
    const sub1 = makeSub('sw1', 'SW1avg');
    const sub2 = makeSub('sw2', 'SW2avg');
    const { service, state } = harness({
      responses: { sw1: makeResponse(60, 0), sw2: makeResponse(60, 180) },
      subsByPosition: { 1: [sub1, sub2] },
    });

    await service.refresh('1', { force: true, withTheo: true });

    expect(state.imports).toHaveLength(2);
    const [predicted, theo] = state.imports;
    expect(predicted.identifier).toBe('LFE predicted_P1');
    expect(theo.identifier).toBe('LFE Max Sum Theo_P1');
    // Anti-phase: the real sum cancels, the zero-phase Theo impulse carries
    // far more energy than the predicted one.
    const rms = data => Math.hypot(...data) / Math.sqrt(data.length);
    expect(rms(theo.data)).toBeGreaterThan(rms(predicted.data) * 1000);
    expect(service.subwooferFor('1').theoUuid).toBe('proj-2');
  });

  it('recomputes Theo at every subsequent refresh and removes it with the projection', async () => {
    const sub = makeSub('sw1', 'SW1avg');
    const groups = { 1: [sub] };
    const { service, state } = harness({ subsByPosition: groups });

    await service.refresh('1', { force: true, withTheo: true });
    expect(state.imports).toHaveLength(2);

    // A plain forced refresh recomputes BOTH projections.
    await service.refresh('1', { force: true });
    expect(state.imports).toHaveLength(4);
    expect(state.removedUuids).toEqual(expect.arrayContaining(['proj-1', 'proj-2']));

    // No sub left: both projections are removed.
    groups['1'] = [];
    await service.refresh('1');
    expect(state.removedUuids).toEqual(expect.arrayContaining(['proj-3', 'proj-4']));
    expect(service.subwooferFor('1').theoUuid).toBeNull();
  });

  it('adopts a restored Theo and re-enables its recomputation', async () => {
    const sub = makeSub('sw1', 'SW1avg');
    const { service, state } = harness({ subsByPosition: { 1: [sub] } });
    state.list.push({ uuid: 'old-theo', title: () => 'LFE Max Sum Theo_P1' });
    state.list.push({ uuid: 'old-pred', title: () => 'LFE predicted_P1' });

    await service.refreshProjected({ force: true });

    expect(state.removedUuids).toEqual(expect.arrayContaining(['old-theo', 'old-pred']));
    expect(state.imports.map(options => options.identifier)).toEqual([
      'LFE predicted_P1',
      'LFE Max Sum Theo_P1',
    ]);
  });
});

describe('Commandes de groupe (ADR 003 v2)', () => {
  it('addSPLOffset fans out to every sub then recomputes projected positions', async () => {
    const sub1 = makeSub('sw1', 'SW1avg');
    const sub2 = makeSub('sw2', 'SW2avg');
    const { service, state } = harness({ subsByPosition: { 1: [sub1, sub2] } });
    await service.refresh('1', { force: true });
    expect(state.imports).toHaveLength(1);

    await service.addSPLOffset(0.5);

    expect(sub1.addSPLOffsetDB).toHaveBeenCalledWith(0.5);
    expect(sub2.addSPLOffsetDB).toHaveBeenCalledWith(0.5);
    expect(state.imports).toHaveLength(2);
  });

  it('commands do not create projections for unprojected positions', async () => {
    const sub = makeSub('sw1', 'SW1avg');
    const { service, state } = harness({ subsByPosition: { 1: [sub] } });

    await service.addDelay(0.001);

    expect(sub.addIROffsetSeconds).toHaveBeenCalledWith(0.001);
    expect(state.imports).toHaveLength(0);
    // The instance is marked dirty: the next non-forced refresh recomputes.
    expect(service.subwooferFor('1').dirty).toBe(true);
  });

  it('setFilters preserves the all-pass slot by default and scopes by position', async () => {
    const sub1 = makeSub('sw1', 'SW1avg');
    const sub2 = makeSub('sw2', 'SW2avg');
    const filters = [{ index: 1, type: 'PK' }];
    const { service } = harness({ subsByPosition: { 1: [sub1], 2: [sub2] } });

    await service.setFilters(filters, { position: '1' });

    expect(sub1.setFilters).toHaveBeenCalledWith(filters, false);
    expect(sub2.setFilters).not.toHaveBeenCalled();
  });

  it('forEachSub batches a generic command with a single recompute', async () => {
    const sub1 = makeSub('sw1', 'SW1avg');
    const sub2 = makeSub('sw2', 'SW2avg');
    const { service, state } = harness({ subsByPosition: { 1: [sub1, sub2] } });
    await service.refresh('1', { force: true });

    const seen = [];
    await service.forEachSub(async (mops, sub) => {
      seen.push(sub.uuid);
      await mops.setInverted(sub, false);
    });

    expect(seen).toEqual(['sw1', 'sw2']);
    expect(sub1.setInverted).toHaveBeenCalledWith(false);
    expect(state.imports).toHaveLength(2);
  });
});
