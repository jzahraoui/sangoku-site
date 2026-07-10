import { describe, expect, it, vi } from 'vitest';
import {
  createMeasurementOperations,
  getAlignSPLOffsetdBByUUID,
} from '../../src/services/measurement-operations.js';
import { createEmptyFilters } from '../../src/measurement/filter-slots.js';

const ops = createMeasurementOperations();

// Measurements can expose getters (Knockout style) or plain fields (record
// style): both shapes must work (ADR 002 transition).
function record(overrides = {}) {
  return {
    uuid: 'uuid-1',
    title: 'FL_P01',
    notes: '',
    inverted: false,
    haveImpulseResponse: true,
    sampleRate: null,
    isFilter: false,
    timeOfIRPeakSeconds: 0.002,
    displayMeasurementTitle: () => '1: FL_P01',
    update: vi.fn(),
    ...overrides,
  };
}

function koRecord(overrides = {}) {
  return record({
    title: () => 'FL_P01',
    inverted: () => false,
    timeOfIRPeakSeconds: () => 0.002,
    ...overrides,
  });
}

describe('toggleInversion / setInverted', () => {
  it('inverts through REW then writes back the new state', async () => {
    const m = koRecord();
    const rew = { invert: vi.fn().mockResolvedValue({}) };

    await expect(ops.toggleInversion(rew, m)).resolves.toBe(true);

    expect(rew.invert).toHaveBeenCalledWith('uuid-1');
    expect(m.update).toHaveBeenCalledWith({ inverted: true });
  });

  it('setInverted is a no-op when the state already matches', async () => {
    const m = record({ inverted: true });
    const rew = { invert: vi.fn() };

    await ops.setInverted(rew, m, true);

    expect(rew.invert).not.toHaveBeenCalled();
  });

  it('setInverted uses the provided toggle callback', async () => {
    const m = record({ inverted: false });
    const toggle = vi.fn().mockResolvedValue(true);

    await expect(ops.setInverted({}, m, true, { toggle })).resolves.toBe(true);

    expect(toggle).toHaveBeenCalledOnce();
  });
});

describe('setTitle', () => {
  it('returns false without calling REW when nothing changes', async () => {
    const m = koRecord();
    const rew = { update: vi.fn() };

    await expect(ops.setTitle(rew, m, 'FL_P01', undefined)).resolves.toBe(false);

    expect(rew.update).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  it('updates REW and writes back title and notes', async () => {
    const m = record();
    const rew = { update: vi.fn().mockResolvedValue({}) };

    await expect(ops.setTitle(rew, m, 'FL_P02', 'hello')).resolves.toBe(true);

    expect(rew.update).toHaveBeenCalledWith('uuid-1', {
      title: 'FL_P02',
      notes: 'hello',
    });
    expect(m.update).toHaveBeenCalledWith({ title: 'FL_P02', notes: 'hello' });
  });
});

describe('IR windows', () => {
  const wanted = {
    leftWindowType: 'Rectangular',
    rightWindowType: 'Rectangular',
    leftWindowWidthms: 125,
    rightWindowWidthms: 1000,
    refTimems: 2,
    addFDW: false,
    addMTW: false,
  };

  it('skips measurements without impulse response', async () => {
    const m = record({ haveImpulseResponse: false });
    const rew = { getIRWindows: vi.fn() };

    await expect(ops.setIrWindows(rew, m, wanted)).resolves.toBeUndefined();
    expect(rew.getIRWindows).not.toHaveBeenCalled();
  });

  it('does not rewrite identical windows', async () => {
    const m = record();
    const rew = {
      getIRWindows: vi.fn().mockResolvedValue({ ...wanted }),
      setIRWindows: vi.fn(),
    };

    await expect(ops.setIrWindows(rew, m, wanted)).resolves.toBe(true);
    expect(rew.setIRWindows).not.toHaveBeenCalled();
  });

  it('resetIrWindows posts a rectangular config anchored on the IR peak', async () => {
    const m = koRecord();
    const rew = {
      getIRWindows: vi.fn().mockResolvedValue({}),
      setIRWindows: vi.fn().mockResolvedValue('posted'),
    };

    await expect(
      ops.resetIrWindows(rew, m, { leftWindowWidthms: 125, rightWindowWidthms: 1000 }),
    ).resolves.toBe('posted');

    expect(rew.setIRWindows).toHaveBeenCalledWith('uuid-1', wanted);
  });
});

describe('room curve settings', () => {
  it('rejects invalid settings', async () => {
    await expect(ops.setRoomCurveSettings({}, record(), null)).rejects.toThrow(
      'Invalid room curve settings',
    );
  });

  it('resets when addRoomCurve is disabled', async () => {
    const rew = { resetRoomCurveSettings: vi.fn().mockResolvedValue({}) };

    await ops.setRoomCurveSettings(rew, record(), { addRoomCurve: false });

    expect(rew.resetRoomCurveSettings).toHaveBeenCalledWith('uuid-1');
  });

  it('posts the settings when addRoomCurve is enabled', async () => {
    const rew = { setRoomCurveSettings: vi.fn().mockResolvedValue({}) };
    const settings = { addRoomCurve: true, slope: -1 };

    await ops.setRoomCurveSettings(rew, record(), settings);

    expect(rew.setRoomCurveSettings).toHaveBeenCalledWith('uuid-1', settings);
  });
});

describe('equaliser', () => {
  const defaults = { manufacturer: 'Generic', model: 'Generic' };

  it('detects the default equaliser', async () => {
    const rew = { getEqualiser: vi.fn().mockResolvedValue({ ...defaults }) };

    await expect(ops.isDefaultEqualiser(rew, record(), defaults)).resolves.toBe(true);
  });

  it('resetEqualiser skips when already default', async () => {
    const rew = {
      getEqualiser: vi.fn().mockResolvedValue({ ...defaults }),
      setEqualiser: vi.fn(),
    };

    await expect(ops.resetEqualiser(rew, record(), defaults)).resolves.toBe(true);
    expect(rew.setEqualiser).not.toHaveBeenCalled();
  });

  it('resetEqualiser applies the default settings otherwise', async () => {
    const rew = {
      getEqualiser: vi.fn().mockResolvedValue({ manufacturer: 'X', model: 'Y' }),
      setEqualiser: vi.fn().mockResolvedValue({}),
    };

    await ops.resetEqualiser(rew, record(), defaults);

    expect(rew.setEqualiser).toHaveBeenCalledWith('uuid-1', defaults);
  });
});

describe('target level', () => {
  it('rounds the level read from REW', async () => {
    const rew = { getTargetLevel: vi.fn().mockResolvedValue(75.128888) };

    await expect(ops.getTargetLevel(rew, record())).resolves.toBe(75.13);
  });

  it('rejects null levels', async () => {
    await expect(ops.setTargetLevel({}, record(), null)).rejects.toThrow(
      'Invalid level',
    );
  });

  it('is a no-op when the level already matches', async () => {
    const rew = {
      getTargetLevel: vi.fn().mockResolvedValue(75),
      setTargetLevel: vi.fn(),
    };

    await expect(ops.setTargetLevel(rew, record(), 75.001)).resolves.toBe(true);
    expect(rew.setTargetLevel).not.toHaveBeenCalled();
  });

  it('writes the level then resets filters', async () => {
    const session = { invalidateAssociatedFilter: vi.fn() };
    const rew = {
      getTargetLevel: vi.fn().mockResolvedValue(75),
      setTargetLevel: vi.fn().mockResolvedValue({}),
      getFilters: vi.fn().mockResolvedValue(createEmptyFilters()),
    };

    // empty bank == empty bank → resetFilters short-circuits to false
    await expect(ops.setTargetLevel(rew, record(), 70, session)).resolves.toBe(false);

    expect(rew.setTargetLevel).toHaveBeenCalledWith('uuid-1', 70);
    expect(session.invalidateAssociatedFilter).toHaveBeenCalled();
  });
});

describe('filters', () => {
  it('getFilters force-disables auto on crossover-type filters', async () => {
    const rew = {
      getFilters: vi.fn().mockResolvedValue([
        { index: 1, type: 'PK', isAuto: true },
        { index: 2, type: 'LP', isAuto: true },
        { index: 3, type: 'All pass', isAuto: true },
      ]),
    };

    const filters = await ops.getFilters(rew, record());

    expect(filters.map(f => f.isAuto)).toEqual([true, false, false]);
  });

  it('setFilters returns false when banks are identical', async () => {
    const bank = createEmptyFilters();
    const rew = { getFilters: vi.fn().mockResolvedValue(createEmptyFilters()) };

    await expect(ops.setFilters(rew, record(), bank)).resolves.toBe(false);
  });

  it('setFilters posts only changed filters and invalidates the associated filter', async () => {
    const current = createEmptyFilters();
    const wanted = createEmptyFilters();
    wanted[0] = { index: 1, type: 'PK', enabled: true, isAuto: true, gaindB: -3 };
    const invalidateAssociatedFilter = vi.fn();
    const rew = {
      getFilters: vi.fn().mockResolvedValue(current),
      postFilters: vi.fn().mockResolvedValue('posted'),
    };

    await expect(
      ops.setFilters(rew, record(), wanted, { invalidateAssociatedFilter }),
    ).resolves.toBe('posted');

    expect(invalidateAssociatedFilter).toHaveBeenCalledOnce();
    expect(rew.postFilters).toHaveBeenCalledWith('uuid-1', {
      filters: [wanted[0]],
    });
  });

  it('setFilters skips indexes missing from the current bank', async () => {
    const rew = {
      getFilters: vi.fn().mockResolvedValue([{ index: 1, type: 'PK', isAuto: true }]),
      postFilters: vi.fn(),
    };
    const wanted = [{ index: 99, type: 'PK', isAuto: true, gaindB: -3 }];

    await expect(ops.setFilters(rew, record(), wanted)).resolves.toBe(true);
    expect(rew.postFilters).not.toHaveBeenCalled();
  });

  it('setSingleFilter throws when the slot does not exist', async () => {
    const rew = { getFilters: vi.fn().mockResolvedValue(createEmptyFilters()) };

    await expect(
      ops.setSingleFilter(rew, record(), { index: 99, type: 'PK' }),
    ).rejects.toThrow('Filter with index 99 not found');
  });

  it('setSingleFilter writes a changed filter and invalidates', async () => {
    const invalidateAssociatedFilter = vi.fn();
    const rew = {
      getFilters: vi.fn().mockResolvedValue(createEmptyFilters()),
      setFilters: vi.fn().mockResolvedValue({}),
    };
    const filter = { index: 1, type: 'PK', enabled: true, isAuto: true, gaindB: -2 };

    await expect(
      ops.setSingleFilter(rew, record(), filter, { invalidateAssociatedFilter }),
    ).resolves.toBe(true);

    expect(rew.setFilters).toHaveBeenCalledWith('uuid-1', filter);
    expect(invalidateAssociatedFilter).toHaveBeenCalledOnce();
  });

  it('getFreeXFilterIndex returns the first manual slot with no filter', async () => {
    const bank = createEmptyFilters();
    bank[20].type = 'PK';
    const rew = {
      getEqualiser: vi
        .fn()
        .mockResolvedValue({ manufacturer: 'Generic', model: 'Generic' }),
      getFilters: vi.fn().mockResolvedValue(bank),
    };

    await expect(
      ops.getFreeXFilterIndex(rew, record(), {
        manufacturer: 'Generic',
        model: 'Generic',
      }),
    ).resolves.toBe(22);
  });

  it('setAllFiltersAuto flips PK auto slots only', async () => {
    const bank = createEmptyFilters();
    bank[0] = { index: 1, type: 'PK', enabled: true, isAuto: true, gaindB: -2 };
    bank[21] = { index: 22, type: 'PK', enabled: true, isAuto: false, gaindB: -1 };
    const rew = {
      getFilters: vi.fn().mockResolvedValue(bank),
      postFilters: vi.fn().mockResolvedValue('posted'),
    };

    await expect(ops.setAllFiltersAuto(rew, record(), false)).resolves.toBe(true);

    // Bank is compared against itself after mutation → no post needed
    expect(bank[0].isAuto).toBe(false);
    expect(bank[21].isAuto).toBe(false); // index 22 > 20 → forced manual
  });
});

describe('working settings', () => {
  const workingConfig = {
    smoothingMethod: '1/6',
    roomCurveSettings: { addRoomCurve: false },
    irWindows: { leftWindowType: 'Rectangular' },
  };

  it('applyWorkingSettings refuses filters', async () => {
    await expect(
      ops.applyWorkingSettings({}, record({ isFilter: true }), workingConfig),
    ).rejects.toThrow('Operation not permitted on a filter');
  });

  it('applyWorkingSettings chains smoothing, room curve and IR windows', async () => {
    const rew = {
      smoothMeasurements: vi.fn().mockResolvedValue({}),
      resetRoomCurveSettings: vi.fn().mockResolvedValue({}),
      getIRWindows: vi.fn().mockResolvedValue({}),
      setIRWindows: vi.fn().mockResolvedValue({}),
    };

    await ops.applyWorkingSettings(rew, record(), workingConfig);

    expect(rew.smoothMeasurements).toHaveBeenCalledWith(['uuid-1'], '1/6');
    expect(rew.resetRoomCurveSettings).toHaveBeenCalledWith('uuid-1');
    expect(rew.setIRWindows).toHaveBeenCalled();
  });

  it('restoreWorkingSettings returns the operation error untouched when skipped', async () => {
    const operationError = new Error('boom');

    await expect(
      ops.restoreWorkingSettings({}, record(), workingConfig, true, operationError),
    ).resolves.toBe(operationError);
  });

  it('restoreWorkingSettings surfaces a restoration failure without prior error', async () => {
    const rew = {
      smoothMeasurements: vi.fn().mockRejectedValue(new Error('rew down')),
    };

    const result = await ops.restoreWorkingSettings(
      rew,
      record(),
      workingConfig,
      false,
      null,
    );

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/Phase match filter restoration failed: rew down/);
  });

  it('restoreWorkingSettings keeps the operation error when restoration also fails', async () => {
    const operationError = new Error('operation failed');
    const rew = {
      smoothMeasurements: vi.fn().mockRejectedValue(new Error('rew down')),
    };

    await expect(
      ops.restoreWorkingSettings(rew, record(), workingConfig, false, operationError),
    ).resolves.toBe(operationError);
  });
});

describe('reads', () => {
  it('getFrequencyResponse omits ppo when not provided', async () => {
    const rew = { getFrequencyResponse: vi.fn().mockResolvedValue({}) };

    await ops.getFrequencyResponse(rew, record());

    expect(rew.getFrequencyResponse).toHaveBeenCalledWith('uuid-1', {
      unit: 'SPL',
      smoothing: 'None',
    });
  });

  it('getImpulseResponse forwards options and unwraps data', async () => {
    const rew = {
      getImpulseResponse: vi.fn().mockResolvedValue({ data: [1, 2, 3] }),
    };

    await expect(ops.getImpulseResponse(rew, record(), { freq: 48000 })).resolves.toEqual([
      1, 2, 3,
    ]);

    expect(rew.getImpulseResponse).toHaveBeenCalledWith('uuid-1', {
      unit: 'percent',
      windowed: true,
      normalised: true,
      samplerate: 48000,
    });
  });

  it('getFilterImpulseResponse validates its inputs', async () => {
    await expect(ops.getFilterImpulseResponse({}, record(), {})).rejects.toThrow(
      'Invalid frequency or sample count',
    );
  });

  it('resolveSampleRate returns the cached value without calling REW', async () => {
    const rew = { getImpulseResponse: vi.fn() };

    await expect(
      ops.resolveSampleRate(rew, record({ sampleRate: 48000 })),
    ).resolves.toBe(48000);
    expect(rew.getImpulseResponse).not.toHaveBeenCalled();
  });

  it('resolveSampleRate reads REW and writes the value back', async () => {
    const m = record();
    const rew = {
      getImpulseResponse: vi.fn().mockResolvedValue({ sampleRate: 44100 }),
    };

    await expect(ops.resolveSampleRate(rew, m)).resolves.toBe(44100);
    expect(m.update).toHaveBeenCalledWith({ sampleRate: 44100 });
  });

  it('resolveSampleRate throws without impulse response', async () => {
    await expect(
      ops.resolveSampleRate({}, record({ haveImpulseResponse: false })),
    ).rejects.toThrow('Sample rate unavailable');
  });
});

// --- Lot I4: sequences ---------------------------------------------------------

function session(overrides = {}) {
  return {
    analyseApiResponse: vi.fn(),
    removeMeasurements: vi.fn(),
    removeMeasurementUuid: vi.fn(),
    findMeasurementByUuid: vi.fn(),
    ...overrides,
  };
}

describe('IR shift sequences', () => {
  it('addIROffsetSeconds skips measurements without impulse response', async () => {
    const rew = { offsetTZero: vi.fn() };

    await expect(
      ops.addIROffsetSeconds(rew, record({ haveImpulseResponse: false }), 0.01),
    ).resolves.toBeUndefined();
    expect(rew.offsetTZero).not.toHaveBeenCalled();
  });

  it('addIROffsetSeconds returns false on a zero offset', async () => {
    const rew = { offsetTZero: vi.fn() };

    await expect(ops.addIROffsetSeconds(rew, record(), 0)).resolves.toBe(false);
    expect(rew.offsetTZero).not.toHaveBeenCalled();
  });

  it('addIROffsetSeconds shifts t=0 and accumulates the offset', async () => {
    const m = record({ cumulativeIRShiftSeconds: () => 0.001 });
    const rew = { offsetTZero: vi.fn().mockResolvedValue({}) };

    await expect(ops.addIROffsetSeconds(rew, m, 0.002)).resolves.toBe(true);

    expect(rew.offsetTZero).toHaveBeenCalledWith('uuid-1', 0.002);
    expect(m.update).toHaveBeenCalledWith({ cumulativeIRShiftSeconds: 0.003 });
  });

  it('setcumulativeIRShiftSeconds applies the delta to the current shift', async () => {
    const m = record({ cumulativeIRShiftSeconds: () => 0.004 });
    const rew = { offsetTZero: vi.fn().mockResolvedValue({}) };

    await ops.setcumulativeIRShiftSeconds(rew, m, 0.001);

    expect(rew.offsetTZero).toHaveBeenCalledWith('uuid-1', -0.003);
  });

  it('setZeroAtIrPeak shifts by the IR peak time', async () => {
    const m = record({ timeOfIRPeakSeconds: () => 0.005, cumulativeIRShiftSeconds: () => 0 });
    const rew = { offsetTZero: vi.fn().mockResolvedValue({}) };

    await expect(ops.setZeroAtIrPeak(rew, m)).resolves.toBe(true);
    expect(rew.offsetTZero).toHaveBeenCalledWith('uuid-1', 0.005);
  });
});

describe('SPL offset sequence', () => {
  const alignResponse = (uuid, alignSPLOffsetdB) => ({
    results: { [uuid]: { UUID: uuid, alignSPLOffsetdB } },
  });

  it('getAlignSPLOffsetdBByUUID extracts and validates the offset', () => {
    expect(getAlignSPLOffsetdBByUUID(alignResponse('uuid-1', 2.5), 'uuid-1')).toBe(2.5);
    expect(() => getAlignSPLOffsetdBByUUID({}, 'uuid-1')).toThrow(
      'Failed to get align SPL offset',
    );
  });

  it('aligns twice and writes back both SPL offsets', async () => {
    const m = record({
      initialSplOffsetdB: 10,
      splOffsetDeltadB: () => 1,
      cachedBandwidth: { centerFrequencyHz: 80 },
    });
    const rew = {
      alignSPL: vi
        .fn()
        .mockResolvedValueOnce(alignResponse('uuid-1', 1.25))
        .mockResolvedValueOnce(alignResponse('uuid-1', 2.5)),
    };

    await expect(ops.setSPLOffsetDB(rew, m, 2.5)).resolves.toBe(true);

    expect(rew.alignSPL).toHaveBeenNthCalledWith(1, ['uuid-1'], 75, 80, 0);
    expect(rew.alignSPL).toHaveBeenNthCalledWith(2, ['uuid-1'], 76.25, 80, 0);
    expect(m.update).toHaveBeenCalledWith({ alignSPLOffsetdB: 2.5, splOffsetdB: 12.5 });
  });

  it('is a no-op when the offset already matches', async () => {
    const m = record({ splOffsetDeltadB: () => 2.5 });
    const rew = { alignSPL: vi.fn() };

    await expect(ops.setSPLOffsetDB(rew, m, 2.5)).resolves.toBe(true);
    expect(rew.alignSPL).not.toHaveBeenCalled();
  });
});

describe('associated filter lifecycle', () => {
  it('deleteAssociatedFilter removes the linked measurement and clears the uuid', async () => {
    const s = session();
    const m = record({
      associatedFilter: 'filter-1',
      associatedFilterItem: () => ({ uuid: 'filter-1' }),
    });

    await expect(ops.deleteAssociatedFilter(m, s)).resolves.toBe(true);

    expect(s.removeMeasurementUuid).toHaveBeenCalledWith('filter-1');
    expect(m.associatedFilter).toBeNull();
  });

  it('deleteAssociatedFilter is a no-op without association', async () => {
    const s = session();

    await expect(
      ops.deleteAssociatedFilter(record({ associatedFilter: null }), s),
    ).resolves.toBe(true);
    expect(s.removeMeasurementUuid).not.toHaveBeenCalled();
  });

  it('setAssociatedFilter rejects non-filters and replaces the previous one', async () => {
    const s = session();
    const m = record({
      associatedFilter: 'old-filter',
      associatedFilterItem: () => ({ uuid: 'old-filter' }),
    });

    await expect(ops.setAssociatedFilter(m, { isFilter: false }, s)).rejects.toThrow(
      'Invalid filter',
    );

    await expect(
      ops.setAssociatedFilter(m, { isFilter: true, uuid: 'new-filter' }, s),
    ).resolves.toBe(true);
    expect(s.removeMeasurementUuid).toHaveBeenCalledWith('old-filter');
    expect(m.associatedFilter).toBe('new-filter');
  });

  it('setAssociatedFilterUuid resolves the filter through the session', async () => {
    const filter = { isFilter: true, uuid: 'filter-9' };
    const s = session({ findMeasurementByUuid: vi.fn().mockReturnValue(filter) });
    const m = record({ associatedFilter: null, associatedFilterItem: () => null });

    await ops.setAssociatedFilterUuid(m, 'filter-9', s);
    expect(m.associatedFilter).toBe('filter-9');

    await expect(
      ops.setAssociatedFilterUuid(m, 'ghost', session()),
    ).rejects.toThrow('filter do not exists: ghost');
  });
});

describe('predicted / filter measurement sequences', () => {
  it('producePredictedMeasurement refuses filters and titles the result', async () => {
    await expect(
      ops.producePredictedMeasurement({}, record({ isFilter: true }), session()),
    ).rejects.toThrow('action can not be done on a Filter');

    const predicted = record({ uuid: 'predicted-1', title: () => 'old' });
    const s = session({ analyseApiResponse: vi.fn().mockResolvedValue(predicted) });
    const rew = {
      generatePredictedMeasurement: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn().mockResolvedValue({}),
    };

    await expect(ops.producePredictedMeasurement(rew, record(), s)).resolves.toBe(
      predicted,
    );
    expect(rew.update).toHaveBeenCalledWith('predicted-1', {
      title: 'predicted FL_P01',
      notes: undefined,
    });
  });

  it('generateFilterMeasurement returns the existing associated filter', async () => {
    const existing = { uuid: 'filter-1' };
    const m = record({ associatedFilterItem: () => existing });

    await expect(ops.generateFilterMeasurement({}, m, session())).resolves.toBe(existing);
  });

  it('createUserFilter refuses filters', async () => {
    await expect(
      ops.createUserFilter({}, record({ isFilter: true }), session()),
    ).rejects.toThrow('Already a Filter');
  });
});

describe('checkFilterGain', () => {
  it('rejects PK gains and Q outside limits', async () => {
    const rew = {
      getFilters: vi
        .fn()
        .mockResolvedValueOnce([{ index: 1, type: 'PK', gaindB: -30, q: 1 }])
        .mockResolvedValueOnce([{ index: 2, type: 'PK', gaindB: -3, q: 42 }])
        .mockResolvedValueOnce([{ index: 3, type: 'LP', gaindB: -99, q: 99 }]),
    };

    await expect(ops.checkFilterGain(rew, record())).rejects.toThrow(
      /gain is out of limits: -30dB/,
    );
    await expect(ops.checkFilterGain(rew, record())).rejects.toThrow(
      /Q is out of limits: 42/,
    );
    // non-PK filters are ignored
    await expect(ops.checkFilterGain(rew, record())).resolves.toBeUndefined();
  });
});

describe('arithmetic operations', () => {
  it('run the REW command then register the result through the session', async () => {
    const created = { uuid: 'sum-1' };
    const s = session({ analyseApiResponse: vi.fn().mockResolvedValue(created) });
    const rew = { arithmeticAPlusB: vi.fn().mockResolvedValue({ ok: true }) };

    await expect(
      ops.arithmeticSum(rew, record(), { uuid: 'uuid-2' }, s),
    ).resolves.toBe(created);
    expect(rew.arithmeticAPlusB).toHaveBeenCalledWith('uuid-1', 'uuid-2');
    expect(s.analyseApiResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('arithmeticADividedByB forwards gain and limits', async () => {
    const s = session({ analyseApiResponse: vi.fn().mockResolvedValue({}) });
    const rew = { arithmeticADividedByB: vi.fn().mockResolvedValue({}) };

    await ops.arithmeticADividedByB(rew, record(), { uuid: 'uuid-2' }, s, 6, 20, 200);
    expect(rew.arithmeticADividedByB).toHaveBeenCalledWith('uuid-1', 'uuid-2', 6, 20, 200);
  });
});

describe('trimIRToWindows', () => {
  it('skips without impulse response and throws when analysis fails', async () => {
    await expect(
      ops.trimIRToWindows({}, record({ haveImpulseResponse: false }), session()),
    ).resolves.toBeUndefined();

    const rew = { trimIRToWindows: vi.fn().mockResolvedValue({}) };
    const s = session({ analyseApiResponse: vi.fn().mockResolvedValue(null) });
    await expect(ops.trimIRToWindows(rew, record(), s)).rejects.toThrow(
      'trimIRToWindows failed',
    );
  });
});

describe('resetAll', () => {
  it('wraps any failure with the measurement label', async () => {
    const rew = { removeSmoothing: vi.fn().mockRejectedValue(new Error('rew down')) };

    await expect(
      ops.resetAll(rew, record(), {
        irWindowWidths: { leftWindowWidthms: 125, rightWindowWidthms: 1000 },
        equaliserDefaults: { manufacturer: 'Generic', model: 'Generic' },
        session: session(),
      }),
    ).rejects.toThrow('Failed to reset for response 1: FL_P01: rew down');
  });
});

describe('createFilter', () => {
  const ctx = overrides => ({
    session: session(),
    rewEq: { setMatchTargetSettings: vi.fn() },
    workingConfig: {
      smoothingMethod: '1/6',
      roomCurveSettings: { addRoomCurve: false },
      irWindows: {},
    },
    irWindowWidths: { leftWindowWidthms: 125, rightWindowWidthms: 1000 },
    smoothingMethod: '1/6',
    optimizedMtwWindows: () => ({}),
    bounds: { lower: 20, upper: 20000 },
    boosts: { individual: 6, overall: 3 },
    createCalculator: vi.fn(),
    setTargetLevelFromMeasurement: vi.fn(),
    otherTargets: () => [],
    ...overrides,
  });

  it('refuses filters and subs', async () => {
    await expect(
      ops.createFilter({}, record({ isFilter: true }), ctx(), 'standard', true, false),
    ).rejects.toThrow('Operation not permitted on a filter');

    await expect(
      ops.createFilter({}, record({ isSub: () => true }), ctx(), 'standard', true, false),
    ).rejects.toThrow('Operation not permitted on a sub');
  });

  it('rejects unknown filter types after restoring settings', async () => {
    // resetFilters/detectFallOff/applyWorkingSettings need a working REW mock
    const rew = {
      getFilters: vi.fn().mockResolvedValue(createEmptyFilters()),
      resetTargetSettings: vi.fn().mockResolvedValue({}),
      getFrequencyResponse: vi.fn().mockResolvedValue({
        freqs: [20, 100, 1000],
        magnitude: [75, 75, 75],
      }),
      getTargetResponse: vi.fn().mockResolvedValue({
        freqs: [20, 100, 1000],
        magnitude: [75, 75, 75],
      }),
      smoothMeasurements: vi.fn().mockResolvedValue({}),
      resetRoomCurveSettings: vi.fn().mockResolvedValue({}),
      getIRWindows: vi.fn().mockResolvedValue({}),
      setIRWindows: vi.fn().mockResolvedValue({}),
      removeSmoothing: vi.fn().mockResolvedValue({}),
    };

    await expect(
      ops.createFilter(rew, record({ isSub: () => false }), ctx(), 'bogus', true, false),
    ).rejects.toThrow('Filter creation failed: Unknown filter type: bogus');
  });
});
