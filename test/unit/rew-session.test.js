import { describe, expect, it, vi } from 'vitest';
import { createRewSession } from '../../src/services/rew-session.js';

// Plain record items (ADR 002 shape) — the service must not depend on Knockout.
class FakeMeasurement {
  constructor(item) {
    this.uuid = item.uuid;
    this.title = item.title;
    this.associatedFilter = item.associatedFilter ?? null;
    this.disposed = false;
    // arrow: the service reads it through `unwrap`, detached from the
    // instance (like a KO computed on the real MeasurementItem)
    this.displayMeasurementTitle = () => `${this.uuid}: ${this.title}`;
  }

  update(apiItem) {
    if (Object.hasOwn(apiItem, 'title')) this.title = apiItem.title;
    return this;
  }

  dispose() {
    this.disposed = true;
  }
}

function apiData(...items) {
  return Object.fromEntries(items.map((item, itemIndex) => [String(itemIndex + 1), item]));
}

function createHarness({ initial = [], state: stateOverrides = {} } = {}) {
  let list = [...initial];
  const set = vi.fn(next => {
    list = next;
  });
  const state = {
    isPolling: true,
    isProcessing: false,
    isLoading: false,
    hasError: false,
    rewVersion: '',
    maxMeasurements: 0,
    inhibitGraphUpdates: false,
    apiBaseUrl: 'http://localhost:4735',
    ...stateOverrides,
  };
  const onError = vi.fn();
  const onProcessingEnded = vi.fn();
  const onApiServicesChanged = vi.fn();

  const session = createRewSession({
    state,
    measurements: {
      get: () => list,
      set,
      push: item => list.push(item),
      removeWhere: predicate => {
        list = list.filter(item => !predicate(item));
      },
    },
    createMeasurement: apiItem => new FakeMeasurement(apiItem),
    adoptMeasurement: item =>
      item instanceof FakeMeasurement ? item : new FakeMeasurement(item),
    createApi: vi.fn(),
    onError,
    onProcessingEnded,
    onApiServicesChanged,
  });

  return { session, state, list: () => list, set, onError, onProcessingEnded, onApiServicesChanged };
}

describe('RewSession.mergeMeasurements', () => {
  it('reorders existing measurements to match REW API order', () => {
    const first = new FakeMeasurement({ uuid: 'a', title: 'Front Left' });
    const second = new FakeMeasurement({ uuid: 'b', title: 'Front Right' });
    const { session, list } = createHarness({ initial: [first, second] });

    session.mergeMeasurements(
      apiData(
        { uuid: 'b', title: 'Front Right updated' },
        { uuid: 'a', title: 'Front Left updated' },
      ),
    );

    expect(list()).toEqual([second, first]);
    expect(list()[0]).toBe(second);
    expect(list()[1]).toBe(first);
    expect(second.title).toBe('Front Right updated');
    expect(first.title).toBe('Front Left updated');
  });

  it('removes deleted measurements and clears orphaned associated filters', () => {
    const source = new FakeMeasurement({
      uuid: 'source',
      title: 'Source',
      associatedFilter: 'filter',
    });
    const filter = new FakeMeasurement({ uuid: 'filter', title: 'Filter' });
    const { session, list } = createHarness({ initial: [source, filter] });

    session.mergeMeasurements(apiData({ uuid: 'source', title: 'Source' }));

    expect(list()).toEqual([source]);
    expect(source.associatedFilter).toBeNull();
    expect(filter.disposed).toBe(true);
  });

  it('adds new measurements in API order while preserving existing objects', () => {
    const existing = new FakeMeasurement({ uuid: 'b', title: 'Existing' });
    const { session, list } = createHarness({ initial: [existing] });

    session.mergeMeasurements(
      apiData(
        { uuid: 'a', title: 'New before' },
        { uuid: 'b', title: 'Existing updated' },
        { uuid: 'c', title: 'New after' },
      ),
    );

    const merged = list();
    expect(merged.map(item => item.uuid)).toEqual(['a', 'b', 'c']);
    expect(merged[1]).toBe(existing);
    expect(existing.title).toBe('Existing updated');
    expect(merged[0]).toBeInstanceOf(FakeMeasurement);
    expect(merged[2]).toBeInstanceOf(FakeMeasurement);
  });

  it('does not rewrite the measurement list when API UUID order is unchanged', () => {
    const existing = new FakeMeasurement({ uuid: 'a', title: 'Front Left' });
    const { session, list, set } = createHarness({ initial: [existing] });

    session.mergeMeasurements(apiData({ uuid: 'a', title: 'Front Left updated' }));

    expect(set).not.toHaveBeenCalled();
    expect(list()).toEqual([existing]);
    expect(existing.title).toBe('Front Left updated');
  });
});

describe('RewSession.addMeasurementFromRewOperation', () => {
  it('resolves the created measurement by UUID diff instead of REW index', async () => {
    const { session, list } = createHarness();
    const operation = vi.fn().mockResolvedValue(undefined);
    session.rewMeasurements = {
      list: vi
        .fn()
        .mockResolvedValueOnce(apiData({ uuid: 'old', title: 'Old' }))
        .mockResolvedValueOnce(
          apiData(
            { uuid: 'old', title: 'Old' },
            { uuid: 'other-new', title: 'Other new' },
            { uuid: 'expected-new', title: 'Expected new' },
          ),
        ),
    };

    const created = await session.addMeasurementFromRewOperation(operation, {
      expectedTitle: 'Expected new',
      operationLabel: 'test operation',
      timeoutMs: 10,
      pollIntervalMs: 0,
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(created.uuid).toBe('expected-new');
    expect(list().map(item => item.uuid)).toEqual(['old', 'other-new', 'expected-new']);
  });
});

describe('RewSession.analyseApiResponse', () => {
  it('reports a missing UUID without crashing on a partial response', async () => {
    const { session } = createHarness();

    await expect(session.analyseApiResponse({ message: {} })).rejects.toThrow(
      'No measurement UUID found in command result',
    );
  });

  it('adds the measurement from top-level command results', async () => {
    const { session } = createHarness();
    const measurement = { uuid: 'created' };
    session.addMeasurementApi = vi.fn().mockResolvedValue(measurement);

    await expect(
      session.analyseApiResponse({ results: { 1: { UUID: 'created' } } }),
    ).resolves.toBe(measurement);
    expect(session.addMeasurementApi).toHaveBeenCalledWith('created');
  });
});

describe('RewSession.addMeasurementApi', () => {
  it('routes failures to the error channel and returns false', async () => {
    const { session, onError } = createHarness();
    session.rewMeasurements = {
      get: vi.fn().mockRejectedValue(new Error('rew down')),
    };

    await expect(session.addMeasurementApi('uuid-1')).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(
      'Failed to add measurement: rew down',
      expect.any(Error),
    );
  });

  it('returns the existing measurement without calling REW', async () => {
    const existing = new FakeMeasurement({ uuid: 'a', title: 'A' });
    const { session } = createHarness({ initial: [existing] });
    session.rewMeasurements = { get: vi.fn() };

    await expect(session.addMeasurementApi('a')).resolves.toBe(existing);
    expect(session.rewMeasurements.get).not.toHaveBeenCalled();
  });
});

describe('RewSession.removeMeasurementUuid', () => {
  it('tolerates measurements already deleted on the REW side', async () => {
    const existing = new FakeMeasurement({ uuid: 'a', title: 'A' });
    const { session, list } = createHarness({ initial: [existing] });
    session.rewMeasurements = {
      delete: vi.fn().mockRejectedValue(new Error('There is no measurement at index')),
    };

    await expect(session.removeMeasurementUuid('a')).resolves.toBe(false);
    expect(list()).toEqual([existing]);
  });

  it('deletes from REW then from the list', async () => {
    const existing = new FakeMeasurement({ uuid: 'a', title: 'A' });
    const { session, list } = createHarness({ initial: [existing] });
    session.rewMeasurements = { delete: vi.fn().mockResolvedValue({}) };

    await expect(session.removeMeasurementUuid('a')).resolves.toBe(true);
    expect(session.rewMeasurements.delete).toHaveBeenCalledWith('a');
    expect(list()).toEqual([]);
  });
});

describe('RewSession.setProcessing', () => {
  it('refuses to start processing while disconnected', async () => {
    const { session } = createHarness({ state: { isPolling: false } });

    await expect(session.setProcessing(true)).rejects.toThrow(
      'Please connect to REW before processing',
    );
  });

  it('toggles the lock, inhibits graph updates and persists on release', async () => {
    const { session, state, onProcessingEnded } = createHarness({
      state: { inhibitGraphUpdates: true },
    });
    session.apiService = { setInhibitGraphUpdates: vi.fn().mockResolvedValue({}) };

    await session.setProcessing(true);
    expect(state.isProcessing).toBe(true);
    expect(session.apiService.setInhibitGraphUpdates).toHaveBeenCalledWith(true);
    expect(onProcessingEnded).not.toHaveBeenCalled();

    await session.setProcessing(false);
    expect(state.isProcessing).toBe(false);
    expect(session.apiService.setInhibitGraphUpdates).toHaveBeenCalledWith(false);
    expect(onProcessingEnded).toHaveBeenCalledTimes(1);
  });
});

describe('RewSession.stopBackgroundPolling', () => {
  it('clears the API services and notifies the mirrors', () => {
    const { session, state, onApiServicesChanged } = createHarness();
    session.apiService = {};
    session.rewMeasurements = {};

    session.stopBackgroundPolling();

    expect(state.isPolling).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(session.apiService).toBeNull();
    expect(session.rewMeasurements).toBeNull();
    expect(onApiServicesChanged).toHaveBeenCalledTimes(1);
  });
});

describe('RewSession.renameMeasurements', () => {
  it('renames only positioned, non-average, known-channel measurements', async () => {
    const renamable = new FakeMeasurement({ uuid: 'a', title: 'old name' });
    renamable.position = () => 3;
    renamable.channelName = () => 'FL';
    renamable.isAverage = false;
    renamable.isUnknownChannel = false;
    renamable.setTitle = vi.fn();

    const average = new FakeMeasurement({ uuid: 'b', title: 'FLavg' });
    average.position = () => 1;
    average.isAverage = true;
    average.setTitle = vi.fn();

    const unpositioned = new FakeMeasurement({ uuid: 'c', title: 'misc' });
    unpositioned.position = () => 0;
    unpositioned.setTitle = vi.fn();

    const { session } = createHarness({ initial: [renamable, average, unpositioned] });

    await session.renameMeasurements();

    expect(renamable.setTitle).toHaveBeenCalledWith('FL_P03');
    expect(average.setTitle).not.toHaveBeenCalled();
    expect(unpositioned.setTitle).not.toHaveBeenCalled();
  });
});
