import { afterEach, describe, expect, it, vi } from 'vitest';
import PersistentStore from '../../src/PersistentStore.js';
import { createFilterBanks } from '../../src/services/filter-banks.js';
import { createPersistenceService } from '../../src/services/persistence.js';
import { createRewSession } from '../../src/services/rew-session.js';
import {
  SESSION_FILE_SCHEMA_VERSION,
  SessionFileError,
  createSessionFile,
} from '../../src/services/session-file.js';

const APP_VERSION = '2.0.0';
const REFERENCE_BANK = 'reference';

function sampleBankChannels() {
  return [
    {
      commandId: 'FL',
      speakerType: 'S',
      distanceInMeters: 3.2,
      trimAdjustmentInDbs: -1.5,
      xover: 80,
      filter: [0.1, 0.2, 0.3],
    },
  ];
}

/**
 * Full persistence + banks + session-file stack over in-memory fakes —
 * the same wiring shape as the viewmodel.
 */
function createHarness({ stored = null, settings: initial = {}, items = [], store } = {}) {
  const effectiveStore = store ?? {
    save: vi.fn().mockReturnValue(true),
    load: vi.fn().mockReturnValue(stored),
    clear: vi.fn(),
  };
  const values = {
    selectedSpeaker: 'uuid-fl',
    targetCurve: 'harman',
    rewVersion: '5.40',
    selectedLfeFrequency: 120,
    selectedAverageMethod: 'Vector average',
    maxBoostIndividualValue: 0,
    maxBoostOverallValue: 0,
    jsonAvrData: { targetModelName: 'X3800H' },
    loadedFileName: 'session.ady',
    isPolling: true,
    selectedSmoothingMethod: '1/6',
    selectedIrWindows: 'Optimized MTW',
    individualMaxBoostValue: 3,
    overallBoostValue: 0,
    upperFrequencyBound: 16000,
    lowerFrequencyBound: 20,
    upperFrequencyBoundSub: 500,
    lowerFrequencyBoundSub: 10,
    apiBaseUrl: 'http://localhost:4735',
    avrIpAddress: '',
    bridgeBaseUrl: 'http://127.0.0.1:7735',
    avrModelName: 'Denon AVR-X3800H',
    bridgeConnected: true,
    inhibitGraphUpdates: true,
    selectedRoomCurve: 'None',
    mainTargetLevel: 75,
    SubsFrequencyBands: null,
    selectedMeasurementsFilter: true,
    ...initial,
  };
  let list = [...items];
  const banks = createFilterBanks();
  const crossovers = {
    toJSON: vi.fn().mockReturnValue({ FL: { crossover: 80 } }),
    restore: vi.fn(),
  };
  const autoEq = {
    toJSON: vi.fn().mockReturnValue({ numFilters: 20 }),
    apply: vi.fn(),
  };
  const applyPolling = vi.fn();
  const applyBridgeConnection = vi.fn();
  const onMeasurementsRestored = vi.fn();
  const onAutoSaveBanksDropped = vi.fn();
  const createMeasurement = vi.fn(saved => ({ ...saved, restored: true }));
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const persistence = createPersistenceService({
    store: effectiveStore,
    settings: {
      get: name => values[name],
      set: (name, value) => {
        values[name] = value;
      },
    },
    measurements: {
      get: () => list,
      set: next => {
        list = next;
      },
    },
    createMeasurement,
    crossovers,
    autoEq,
    applyPolling,
    applyBridgeConnection,
    banks,
    onMeasurementsRestored,
    onAutoSaveBanksDropped,
    log,
  });

  const sessionFile = createSessionFile({
    persistence,
    appVersion: APP_VERSION,
    log,
    now: () => new Date(2026, 6, 22, 9, 5, 0),
  });

  return {
    applyBridgeConnection,
    applyPolling,
    autoEq,
    banks,
    createMeasurement,
    crossovers,
    list: () => list,
    log,
    onAutoSaveBanksDropped,
    onMeasurementsRestored,
    persistence,
    sessionFile,
    store: effectiveStore,
    values,
  };
}

describe('exportSessionFile', () => {
  it('wraps the shared payload with version, schema and date, and names the file', () => {
    const item = {
      uuid: 'uuid-a',
      toJSON: () => ({ uuid: 'uuid-a', title: 'FL_P01', position: 1 }),
    };
    const harness = createHarness({ items: [item] });
    harness.banks.save(REFERENCE_BANK, {
      channels: sampleBankChannels(),
      eqType: 2,
      targetCurve: 'curve-a',
      tcName: 'Target A',
      savedAt: '2026-07-22T08:00:00.000Z',
    });

    const { file, json, filename } = harness.sessionFile.exportSessionFile();

    expect(file.rchVersion).toBe(APP_VERSION);
    expect(file.schemaVersion).toBe(SESSION_FILE_SCHEMA_VERSION);
    expect(new Date(file.savedAt).getTime()).not.toBeNaN();
    expect(filename).toBe('rch-session-2026-07-22-0905.json');
    expect(file.payload.measurements).toEqual([
      { uuid: 'uuid-a', title: 'FL_P01', position: 1 },
    ]);
    expect(file.payload.targetCurve).toBe('harman');
    expect(file.payload.bridgeBaseUrl).toBe('http://127.0.0.1:7735');
    expect(file.payload.isBridgeConnected).toBe(true);
    expect(file.payload.measurementsByGroup).toEqual({ FL: { crossover: 80 } });
    expect(file.payload.autoEqConfig).toEqual({ numFilters: 20 });
    expect(file.payload.filterBanks.reference.tcName).toBe('Target A');
    expect(file.payload.filterBanks.flat).toBeNull();
    expect(JSON.parse(json)).toEqual(file);
  });

  it('strips the signal data from the exported avrFileContent (ADR 002)', () => {
    const harness = createHarness({
      settings: {
        jsonAvrData: {
          targetModelName: 'AVC-A1H',
          detectedChannels: [{ commandId: 'FL', responseData: { 0: [0.1, 0.2] } }],
        },
      },
    });

    const { file } = harness.sessionFile.exportSessionFile();

    expect(file.payload.avrFileContent.detectedChannels[0].responseData).toEqual({});
  });
});

describe('importSessionFile', () => {
  it('roundtrips a full session: settings, measurements, banks, crossovers, autoEq', () => {
    const item = {
      uuid: 'uuid-a',
      toJSON: () => ({ uuid: 'uuid-a', title: 'FL_P01', position: 1 }),
    };
    const source = createHarness({ items: [item] });
    source.banks.save(REFERENCE_BANK, {
      channels: sampleBankChannels(),
      eqType: 2,
      targetCurve: 'curve-a',
      tcName: 'Target A',
      savedAt: '2026-07-22T08:00:00.000Z',
    });
    const { json } = source.sessionFile.exportSessionFile();

    const target = createHarness({
      settings: {
        targetCurve: '',
        jsonAvrData: null,
        selectedLfeFrequency: 250,
        bridgeConnected: false,
      },
    });
    target.sessionFile.importSessionFile(json);

    // Settings
    expect(target.values.targetCurve).toBe('harman');
    expect(target.values.selectedLfeFrequency).toBe(120);
    expect(target.values.jsonAvrData).toEqual({ targetModelName: 'X3800H' });
    expect(target.applyPolling).toHaveBeenCalledWith(true);
    expect(target.applyBridgeConnection).toHaveBeenCalledWith(true);
    // Measurements (no signal, re-created from records)
    expect(target.list()).toEqual([
      { uuid: 'uuid-a', title: 'FL_P01', position: 1, restored: true },
    ]);
    expect(target.onMeasurementsRestored).toHaveBeenCalledWith(target.list());
    // Crossovers / AutoEQ
    expect(target.crossovers.restore).toHaveBeenCalledWith({ FL: { crossover: 80 } });
    expect(target.autoEq.apply).toHaveBeenCalledWith({ numFilters: 20 });
    // Banks
    expect(target.banks.get(REFERENCE_BANK)?.tcName).toBe('Target A');
    expect(target.banks.get('flat')).toBeNull();
    // The imported session becomes the persisted one
    expect(target.store.save).toHaveBeenCalled();
    const persisted = target.store.save.mock.calls[0][0];
    expect(persisted.targetCurve).toBe('harman');
    expect(persisted.filterBanks.reference.tcName).toBe('Target A');
  });

  it('clears existing banks when the payload carries none', () => {
    const source = createHarness();
    const { json } = source.sessionFile.exportSessionFile(); // both banks empty

    const target = createHarness();
    target.banks.save(REFERENCE_BANK, {
      channels: sampleBankChannels(),
      eqType: 2,
      tcName: 'Stale',
    });
    target.sessionFile.importSessionFile(json);

    expect(target.banks.get(REFERENCE_BANK)).toBeNull();
  });

  it('rejects invalid JSON with a translated error code', () => {
    const harness = createHarness();

    expect(() => harness.sessionFile.importSessionFile('{not json')).toThrowError(
      SessionFileError,
    );
    try {
      harness.sessionFile.importSessionFile('{not json');
    } catch (error) {
      expect(error.code).toBe('session_import_invalid_json');
    }
    expect(harness.store.save).not.toHaveBeenCalled();
  });

  it.each([
    ['a JSON array', '[1,2,3]'],
    ['a JSON scalar', '42'],
    ['null', 'null'],
    ['a missing schemaVersion', JSON.stringify({ payload: {} })],
    ['a non-integer schemaVersion', JSON.stringify({ schemaVersion: 'x', payload: {} })],
    ['a schemaVersion below 1', JSON.stringify({ schemaVersion: 0, payload: {} })],
    ['a missing payload', JSON.stringify({ schemaVersion: 1 })],
    ['an array payload', JSON.stringify({ schemaVersion: 1, payload: [] })],
  ])('rejects %s as an invalid format', (_label, text) => {
    const harness = createHarness();

    try {
      harness.sessionFile.importSessionFile(text);
      expect.unreachable('import should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionFileError);
      expect(error.code).toBe('session_import_invalid_format');
    }
    expect(harness.store.save).not.toHaveBeenCalled();
  });

  it('refuses a file newer than the supported schema', () => {
    const harness = createHarness();
    const text = JSON.stringify({
      schemaVersion: SESSION_FILE_SCHEMA_VERSION + 1,
      payload: {},
    });

    try {
      harness.sessionFile.importSessionFile(text);
      expect.unreachable('import should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionFileError);
      expect(error.code).toBe('session_import_unsupported_schema');
    }
    expect(harness.store.save).not.toHaveBeenCalled();
  });

  it('accepts a different rchVersion (informative only, logged)', () => {
    const source = createHarness();
    const { file } = source.sessionFile.exportSessionFile();
    file.rchVersion = '1.9.99';

    const target = createHarness();
    target.sessionFile.importSessionFile(JSON.stringify(file));

    expect(target.store.save).toHaveBeenCalled();
    expect(
      target.log.info.mock.calls.some(call => call[0].includes('1.9.99')),
    ).toBe(true);
  });
});

describe('auto-save quota guard (localStorage channel)', () => {
  const quotaError = () => {
    const error = new Error('quota exceeded');
    error.name = 'QuotaExceededError';
    return error;
  };

  /** localStorage stub whose setItem rejects values carrying the banks. */
  function stubLocalStorage({ rejectBanks = true } = {}) {
    const backing = new Map();
    const stub = {
      rejectBanks,
      setItem: vi.fn((key, value) => {
        if (stub.rejectBanks && value.includes('"filterBanks":')) {
          throw quotaError();
        }
        backing.set(key, value);
      }),
      getItem: vi.fn(key => backing.get(key) ?? null),
      removeItem: vi.fn(key => backing.delete(key)),
    };
    vi.stubGlobal('localStorage', stub);
    // PersistentStore's circular-reference filter checks `instanceof Node`
    // (DOM class, absent from the node test environment).
    vi.stubGlobal('Node', class {});
    return { stub, backing };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries the auto-save without the banks and warns once', () => {
    const { backing } = stubLocalStorage();
    const store = new PersistentStore('myAppData');
    const harness = createHarness({ store });
    harness.banks.save(REFERENCE_BANK, {
      channels: sampleBankChannels(),
      eqType: 2,
      tcName: 'Target A',
    });

    harness.persistence.saveMeasurements();

    const saved = JSON.parse(backing.get('myAppData'));
    expect(saved.filterBanks).toBeUndefined();
    expect(saved.targetCurve).toBe('harman'); // the rest of the auto-save survives
    expect(harness.onAutoSaveBanksDropped).toHaveBeenCalledTimes(1);

    // Still over quota on the next save: no repeated warning.
    harness.persistence.saveMeasurements();
    expect(harness.onAutoSaveBanksDropped).toHaveBeenCalledTimes(1);
  });

  it('resumes saving the banks (and re-arms the warning) once the quota clears', () => {
    const { stub, backing } = stubLocalStorage();
    const store = new PersistentStore('myAppData');
    const harness = createHarness({ store });
    harness.banks.save(REFERENCE_BANK, {
      channels: sampleBankChannels(),
      eqType: 2,
      tcName: 'Target A',
    });

    harness.persistence.saveMeasurements();
    expect(harness.onAutoSaveBanksDropped).toHaveBeenCalledTimes(1);

    stub.rejectBanks = false;
    harness.persistence.saveMeasurements();
    expect(JSON.parse(backing.get('myAppData')).filterBanks.reference.tcName).toBe(
      'Target A',
    );

    stub.rejectBanks = true;
    harness.persistence.saveMeasurements();
    expect(harness.onAutoSaveBanksDropped).toHaveBeenCalledTimes(2);
  });

  it('restores banks saved in localStorage when present', () => {
    const source = createHarness();
    source.banks.save(REFERENCE_BANK, {
      channels: sampleBankChannels(),
      eqType: 2,
      tcName: 'Target A',
    });
    const payload = source.persistence.buildSessionPayload();

    const target = createHarness({ stored: payload });
    target.persistence.restore();

    expect(target.banks.get(REFERENCE_BANK)?.tcName).toBe('Target A');
  });
});

describe('restore sync report (rew-session)', () => {
  class FakeItem {
    constructor({ uuid, title, position = 0 }) {
      this.uuid = uuid;
      this.title = title;
      this.position = () => position;
      this.displayMeasurementTitle = () => title;
    }

    update() {
      return this;
    }

    dispose() {
      this.disposed = true;
    }
  }

  function createSyncHarness(initial) {
    let list = [...initial];
    const onRestoredMeasurementsDiscarded = vi.fn();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const session = createRewSession({
      state: { isPolling: true, isProcessing: false, isLoading: false, hasError: false },
      measurements: {
        get: () => list,
        set: next => {
          list = next;
        },
        push: item => list.push(item),
        removeWhere: predicate => {
          list = list.filter(item => !predicate(item));
        },
      },
      createMeasurement: apiItem => new FakeItem(apiItem),
      adoptMeasurement: item => item,
      createApi: vi.fn(),
      onRestoredMeasurementsDiscarded,
      log,
    });
    return { session, list: () => list, log, onRestoredMeasurementsDiscarded };
  }

  it('reports the restored measurements missing from REW, once, with their labels', () => {
    const kept = new FakeItem({ uuid: 'a', title: 'FL_P01', position: 1 });
    const ghost = new FakeItem({ uuid: 'ghost', title: 'C_P02', position: 2 });
    const { session, log, onRestoredMeasurementsDiscarded } = createSyncHarness([
      kept,
      ghost,
    ]);
    session.trackRestoredMeasurements([kept, ghost]);

    // First REW sync: only `a` exists in REW.
    session.mergeMeasurements({ 1: { uuid: 'a', title: 'FL_P01' } });

    expect(onRestoredMeasurementsDiscarded).toHaveBeenCalledTimes(1);
    expect(onRestoredMeasurementsDiscarded).toHaveBeenCalledWith([
      'C_P02 (position 2)',
    ]);
    expect(
      log.warn.mock.calls.some(call => call[0].includes('C_P02 (position 2)')),
    ).toBe(true);

    // Later syncs (normal user deletions) never re-report.
    session.mergeMeasurements({});
    expect(onRestoredMeasurementsDiscarded).toHaveBeenCalledTimes(1);
  });

  it('stays silent when every restored measurement is re-attached', () => {
    const kept = new FakeItem({ uuid: 'a', title: 'FL_P01', position: 1 });
    const { session, onRestoredMeasurementsDiscarded } = createSyncHarness([kept]);
    session.trackRestoredMeasurements([kept]);

    session.mergeMeasurements({ 1: { uuid: 'a', title: 'FL_P01' } });
    // The tracking is consumed by the first sync either way.
    session.mergeMeasurements({});

    expect(onRestoredMeasurementsDiscarded).not.toHaveBeenCalled();
  });
});
