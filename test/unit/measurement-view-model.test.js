import { beforeEach, describe, expect, it, vi } from 'vitest';
import ko from 'knockout';

vi.mock('../../src/logs.js', () => ({
  default: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
  },
}));

vi.mock('../../src/MeasurementItem.js', () => {
  const createObservable = initialValue => {
    let currentValue = initialValue;
    return function observable(nextValue) {
      if (arguments.length) {
        currentValue = nextValue;
        return observable;
      }
      return currentValue;
    };
  };

  class MockMeasurementItem {
    constructor(item) {
      this.uuid = item.uuid;
      this.title = createObservable(item.title);
      this.notes = item.notes;
      this.inverted = createObservable(item.inverted);
      this.splOffsetdB = createObservable(item.splOffsetdB);
      this.alignSPLOffsetdB = createObservable(item.alignSPLOffsetdB);
      this.cumulativeIRShiftSeconds = createObservable(item.cumulativeIRShiftSeconds);
      this.timeOfIRStartSeconds = item.timeOfIRStartSeconds;
      this.timeOfIRPeakSeconds = createObservable(item.timeOfIRPeakSeconds);
      this.associatedFilter = item.associatedFilter;
      this.disposed = false;
    }

    updateFromApi(item) {
      if (Object.hasOwn(item, 'title')) this.title(item.title);
      if (Object.hasOwn(item, 'notes')) this.notes = item.notes;
      if (Object.hasOwn(item, 'inverted')) this.inverted(item.inverted);
      if (Object.hasOwn(item, 'splOffsetdB')) this.splOffsetdB(item.splOffsetdB);
      if (Object.hasOwn(item, 'alignSPLOffsetdB')) {
        this.alignSPLOffsetdB(item.alignSPLOffsetdB);
      }
      if (Object.hasOwn(item, 'cumulativeIRShiftSeconds')) {
        this.cumulativeIRShiftSeconds(item.cumulativeIRShiftSeconds);
      }
      if (Object.hasOwn(item, 'timeOfIRStartSeconds')) {
        this.timeOfIRStartSeconds = item.timeOfIRStartSeconds;
      }
      if (Object.hasOwn(item, 'timeOfIRPeakSeconds')) {
        this.timeOfIRPeakSeconds(item.timeOfIRPeakSeconds);
      }
      return this;
    }

    displayMeasurementTitle() {
      return `${this.uuid}: ${this.title()}`;
    }

    dispose() {
      this.disposed = true;
    }
  }

  return { default: MockMeasurementItem };
});

const { default: MeasurementViewModel } = await import(
  '../../src/MeasurementViewModel.js'
);
const { default: MeasurementItem } = await import('../../src/MeasurementItem.js');

function createViewModel(initialMeasurements = []) {
  const viewModel = Object.create(MeasurementViewModel.prototype);
  viewModel.measurements = ko.observableArray(initialMeasurements);
  return viewModel;
}

function createMeasurement(item) {
  return new MeasurementItem(item);
}

function apiData(...items) {
  return Object.fromEntries(items.map((item, itemIndex) => [String(itemIndex + 1), item]));
}

describe('MeasurementViewModel.mergeMeasurements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reorders existing measurements to match REW API order', () => {
    const first = createMeasurement({ uuid: 'a', title: 'Front Left' });
    const second = createMeasurement({ uuid: 'b', title: 'Front Right' });
    const viewModel = createViewModel([first, second]);

    viewModel.mergeMeasurements(
      apiData(
        { uuid: 'b', title: 'Front Right updated' },
        { uuid: 'a', title: 'Front Left updated' },
      ),
    );

    expect(viewModel.measurements()).toEqual([second, first]);
    expect(viewModel.measurements()[0]).toBe(second);
    expect(viewModel.measurements()[1]).toBe(first);
    expect(second.title()).toBe('Front Right updated');
    expect(first.title()).toBe('Front Left updated');
  });

  it('removes deleted measurements and clears orphaned associated filters', () => {
    const source = createMeasurement({
      uuid: 'source',
      title: 'Source',
      associatedFilter: 'filter',
    });
    const filter = createMeasurement({ uuid: 'filter', title: 'Filter' });
    const viewModel = createViewModel([source, filter]);

    viewModel.mergeMeasurements(apiData({ uuid: 'source', title: 'Source' }));

    expect(viewModel.measurements()).toEqual([source]);
    expect(source.associatedFilter).toBeNull();
    expect(filter.disposed).toBe(true);
  });

  it('adds new measurements in API order while preserving existing objects', () => {
    const existing = createMeasurement({ uuid: 'b', title: 'Existing' });
    const viewModel = createViewModel([existing]);

    viewModel.mergeMeasurements(
      apiData(
        { uuid: 'a', title: 'New before' },
        { uuid: 'b', title: 'Existing updated' },
        { uuid: 'c', title: 'New after' },
      ),
    );

    const merged = viewModel.measurements();
    expect(merged.map(item => item.uuid)).toEqual(['a', 'b', 'c']);
    expect(merged[1]).toBe(existing);
    expect(existing.title()).toBe('Existing updated');
    expect(merged[0]).toBeInstanceOf(MeasurementItem);
    expect(merged[2]).toBeInstanceOf(MeasurementItem);
  });

  it('does not notify the measurements array when API UUID order is unchanged', () => {
    const existing = createMeasurement({ uuid: 'a', title: 'Front Left' });
    const viewModel = createViewModel([existing]);
    const subscriber = vi.fn();
    const subscription = viewModel.measurements.subscribe(subscriber);

    viewModel.mergeMeasurements(apiData({ uuid: 'a', title: 'Front Left updated' }));

    expect(subscriber).not.toHaveBeenCalled();
    expect(viewModel.measurements()).toEqual([existing]);
    expect(existing.title()).toBe('Front Left updated');

    subscription.dispose();
  });
});

describe('MeasurementViewModel.addMeasurementFromRewOperation', () => {
  it('resolves the created measurement by UUID diff instead of REW index', async () => {
    const viewModel = createViewModel();
    const operation = vi.fn().mockResolvedValue(undefined);
    viewModel.rewMeasurements = {
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

    const created = await viewModel.addMeasurementFromRewOperation(operation, {
      expectedTitle: 'Expected new',
      operationLabel: 'test operation',
      timeoutMs: 10,
      pollIntervalMs: 0,
    });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(created.uuid).toBe('expected-new');
    expect(viewModel.measurements().map(item => item.uuid)).toEqual([
      'old',
      'other-new',
      'expected-new',
    ]);
  });
});
