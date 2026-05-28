import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    static cleanFloat32Value(value, precision = 7) {
      const multiplier = 10 ** precision;
      return Math.round(Number(value) * multiplier) / multiplier;
    }

    static getAlignSPLOffsetdBByUUID(responseData, targetUUID) {
      const result = Object.values(responseData.results).find(
        item => item.UUID === targetUUID,
      );
      return Number(result.alignSPLOffsetdB);
    }

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
const { FrequencyResponseAnalyzer } = await import('../../src/analysis/index.js');

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

function createSubMeasurement(uuid) {
  return {
    uuid,
    initialSplOffsetdB: 10,
    removeWorkingSettings: vi.fn().mockResolvedValue(undefined),
    resetTargetSettings: vi.fn().mockResolvedValue(undefined),
    getFrequencyResponse: vi.fn().mockResolvedValue({
      freqs: [10, 20, 40, 80, 160, 500],
      magnitude: [65, 72, 80, 80, 72, 60],
    }),
    displayMeasurementTitle: () => uuid,
    position: () => 1,
    applyWorkingSettings: vi.fn().mockResolvedValue(undefined),
    alignSPLOffsetdB: vi.fn(),
    splOffsetdB: vi.fn(),
    copySplOffsetDeltadBToOther: vi.fn().mockResolvedValue(undefined),
  };
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

describe('MeasurementViewModel.analyseApiResponse', () => {
  it('reports a missing UUID without crashing on a partial response', async () => {
    const viewModel = createViewModel();

    await expect(viewModel.analyseApiResponse({ message: {} })).rejects.toThrow(
      'No measurement UUID found in command result',
    );
  });

  it('adds the measurement from top-level command results', async () => {
    const viewModel = createViewModel();
    const measurement = { uuid: 'created' };
    viewModel.addMeasurementApi = vi.fn().mockResolvedValue(measurement);

    await expect(
      viewModel.analyseApiResponse({ results: { 1: { UUID: 'created' } } }),
    ).resolves.toBe(measurement);
    expect(viewModel.addMeasurementApi).toHaveBeenCalledWith('created');
  });
});

describe('MeasurementViewModel.findAligment', () => {
  it('rejects non-finite alignment delays', async () => {
    const viewModel = createViewModel();
    viewModel.rewAlignmentTool = {
      setRemoveTimeDelay: vi.fn().mockResolvedValue(undefined),
      resetAll: vi.fn().mockResolvedValue(undefined),
      setMaxNegativeDelay: vi.fn().mockResolvedValue(undefined),
      setMaxPositiveDelay: vi.fn().mockResolvedValue(undefined),
      alignIRsBatch: vi.fn().mockResolvedValue({
        results: [{ 'Delay B ms': 'not-a-number', 'Invert B': 'false' }],
      }),
    };

    await expect(
      viewModel.findAligment({ uuid: 'a' }, { uuid: 'b' }, 80),
    ).rejects.toThrow('Invalid AlignResults object or missing Delay B ms');
  });
});

describe('MeasurementViewModel.adjustSubwooferSPLLevels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aligns each sub on its detected bandwidth and returns the aggregate system bandwidth', async () => {
    const viewModel = createViewModel();
    const firstSub = createSubMeasurement('sub-a');
    const secondSub = createSubMeasurement('sub-b');
    const expectedTargetLevel = 80 - 20 * Math.log10(2);

    viewModel.allPredictedLfeMeasurement = () => [];
    viewModel.removeMeasurements = vi.fn().mockResolvedValue(true);
    viewModel.getTargetLevelAtFreq = vi.fn().mockResolvedValue(80);
    viewModel.rewMeasurements = {
      alignSPL: vi.fn(([uuid]) =>
        Promise.resolve({
          results: {
            [uuid]: {
              UUID: uuid,
              alignSPLOffsetdB: uuid === 'sub-a' ? 1.25 : 2.5,
            },
          },
        }),
      ),
    };
    vi.spyOn(FrequencyResponseAnalyzer, 'detectBandwidth')
      .mockReturnValueOnce({
        status: 'ok',
        lowCutoffHz: 20.4,
        highCutoffHz: 180.9,
        centerFrequencyHz: 61,
        bandwidthOctaves: 3,
      })
      .mockReturnValueOnce({
        status: 'ok',
        lowCutoffHz: 35.2,
        highCutoffHz: 120.7,
        centerFrequencyHz: 65,
        bandwidthOctaves: 2,
      });

    await expect(
      viewModel.adjustSubwooferSPLLevels([firstSub, secondSub]),
    ).resolves.toEqual({
      lowFrequency: 21,
      highFrequency: 180,
      targetLevelAtFreq: 80,
    });

    expect(firstSub.getFrequencyResponse).toHaveBeenCalledWith('SPL', 'None', 12);
    expect(secondSub.getFrequencyResponse).toHaveBeenCalledWith('SPL', 'None', 12);
    expect(FrequencyResponseAnalyzer.detectBandwidth).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ measurement: 'sub-a' }),
      {
        rangeHz: [10, 500],
        passbandHz: [30, 80],
        thresholdDb: -9,
        smoothing: '1/3',
      },
    );
    expect(viewModel.rewMeasurements.alignSPL).toHaveBeenNthCalledWith(
      1,
      ['sub-a'],
      expectedTargetLevel,
      61,
      3,
    );
    expect(viewModel.rewMeasurements.alignSPL).toHaveBeenNthCalledWith(
      2,
      ['sub-b'],
      expectedTargetLevel,
      65,
      2,
    );
    expect(firstSub.alignSPLOffsetdB).toHaveBeenCalledWith(1.25);
    expect(firstSub.splOffsetdB).toHaveBeenCalledWith(11.25);
    expect(secondSub.alignSPLOffsetdB).toHaveBeenCalledWith(2.5);
    expect(secondSub.splOffsetdB).toHaveBeenCalledWith(12.5);
  });

  it('keeps the aggregate range when detected bands do not overlap', async () => {
    const viewModel = createViewModel();
    const firstSub = createSubMeasurement('sub-a');
    const secondSub = createSubMeasurement('sub-b');
    const expectedTargetLevel = 80 - 20 * Math.log10(2);

    viewModel.allPredictedLfeMeasurement = () => [];
    viewModel.removeMeasurements = vi.fn().mockResolvedValue(true);
    viewModel.getTargetLevelAtFreq = vi.fn().mockResolvedValue(80);
    viewModel.rewMeasurements = {
      alignSPL: vi.fn(([uuid]) =>
        Promise.resolve({
          results: {
            [uuid]: {
              UUID: uuid,
              alignSPLOffsetdB: uuid === 'sub-a' ? 1.25 : 2.5,
            },
          },
        }),
      ),
    };
    vi.spyOn(FrequencyResponseAnalyzer, 'detectBandwidth')
      .mockReturnValueOnce({
        status: 'ok',
        lowCutoffHz: 20.1,
        highCutoffHz: 80.9,
        centerFrequencyHz: 40,
        bandwidthOctaves: 2,
      })
      .mockReturnValueOnce({
        status: 'ok',
        lowCutoffHz: 100.1,
        highCutoffHz: 150.9,
        centerFrequencyHz: 123,
        bandwidthOctaves: 1,
      });

    await expect(
      viewModel.adjustSubwooferSPLLevels([firstSub, secondSub]),
    ).resolves.toEqual({
      lowFrequency: 21,
      highFrequency: 150,
      targetLevelAtFreq: 80,
    });

    expect(viewModel.removeMeasurements).toHaveBeenCalledTimes(1);
    expect(viewModel.rewMeasurements.alignSPL).toHaveBeenNthCalledWith(
      1,
      ['sub-a'],
      expectedTargetLevel,
      40,
      2,
    );
    expect(viewModel.rewMeasurements.alignSPL).toHaveBeenNthCalledWith(
      2,
      ['sub-b'],
      expectedTargetLevel,
      123,
      1,
    );
    expect(firstSub.alignSPLOffsetdB).toHaveBeenCalledWith(1.25);
    expect(secondSub.alignSPLOffsetdB).toHaveBeenCalledWith(2.5);
    expect(firstSub.applyWorkingSettings).toHaveBeenCalledTimes(1);
    expect(secondSub.applyWorkingSettings).toHaveBeenCalledTimes(1);
  });

  it('rejects indeterminate sub bandwidth instead of assuming the full range', async () => {
    const viewModel = createViewModel();
    const sub = createSubMeasurement('sub-a');

    viewModel.allPredictedLfeMeasurement = () => [];
    viewModel.removeMeasurements = vi.fn().mockResolvedValue(true);
    viewModel.getTargetLevelAtFreq = vi.fn().mockResolvedValue(80);
    viewModel.rewMeasurements = { alignSPL: vi.fn() };
    vi.spyOn(FrequencyResponseAnalyzer, 'detectBandwidth').mockReturnValueOnce({
      status: 'indeterminate',
      reason: 'no response region is above the threshold',
    });

    await expect(viewModel.adjustSubwooferSPLLevels([sub])).rejects.toThrow(
      'Unable to detect subwoofer bandwidth for sub-a: no response region is above the threshold',
    );

    expect(viewModel.rewMeasurements.alignSPL).not.toHaveBeenCalled();
    expect(viewModel.removeMeasurements).not.toHaveBeenCalled();
    expect(sub.applyWorkingSettings).toHaveBeenCalledTimes(1);
  });
});
