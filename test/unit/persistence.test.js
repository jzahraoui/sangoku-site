import { describe, expect, it, vi } from 'vitest';
import { createPersistenceService } from '../../src/services/persistence.js';

function createHarness({ stored = null, settings: initial = {}, items = [] } = {}) {
  const store = {
    save: vi.fn(),
    load: vi.fn().mockReturnValue(stored),
    clear: vi.fn(),
  };
  const values = {
    selectedSpeaker: '',
    targetCurve: 'harman',
    rewVersion: '5.40',
    selectedLfeFrequency: 250,
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
    ocaFileFormat: 'odd',
    avrIpAddress: '',
    inhibitGraphUpdates: true,
    selectedRoomCurve: 'None',
    mainTargetLevel: 75,
    SubsFrequencyBands: null,
    selectedMeasurementsFilter: true,
    ...initial,
  };
  let list = [...items];
  const crossovers = {
    toJSON: vi.fn().mockReturnValue({ FL: { crossover: 80 } }),
    restore: vi.fn(),
  };
  const autoEq = {
    toJSON: vi.fn().mockReturnValue({ numFilters: 20 }),
    apply: vi.fn(),
  };
  const applyPolling = vi.fn();
  const createMeasurement = vi.fn(saved => ({ ...saved, restored: true }));

  const service = createPersistenceService({
    store,
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
  });

  return {
    service,
    store,
    values,
    list: () => list,
    crossovers,
    autoEq,
    applyPolling,
    createMeasurement,
  };
}

describe('saveMeasurements', () => {
  it('serialises measurements and every persisted setting', () => {
    const item = { toJSON: () => ({ uuid: 'a', title: 'FL_P01' }) };
    const { service, store } = createHarness({ items: [item] });

    service.saveMeasurements();

    expect(store.save).toHaveBeenCalledOnce();
    const data = store.save.mock.calls[0][0];
    expect(data.measurements).toEqual([{ uuid: 'a', title: 'FL_P01' }]);
    expect(data.avrFileContent).toEqual({ targetModelName: 'X3800H' });
    expect(data.isPolling).toBe(true);
    expect(data.measurementsByGroup).toEqual({ FL: { crossover: 80 } });
    expect(data.autoEqConfig).toEqual({ numFilters: 20 });
    expect(data.selectedRoomCurve).toBe('None');
  });

  it('strips the ADY impulse data from the persisted avrFileContent', () => {
    // Régression prod 1.2.55 : une sauvegarde pendant l'import voyait encore
    // detectedChannels[].responseData (~15 Mo) → quota localStorage dépassé.
    const jsonAvrData = {
      targetModelName: 'AVC-A1H',
      detectedChannels: [
        { commandId: 'FL', responseData: { 0: [0.1, 0.2], 1: [0.3, 0.4] } },
        { commandId: 'SW1', responseData: { 0: [0.5] } },
      ],
    };
    const { service, store } = createHarness({ settings: { jsonAvrData } });

    service.saveMeasurements();

    const saved = store.save.mock.calls[0][0].avrFileContent;
    expect(saved.targetModelName).toBe('AVC-A1H');
    expect(saved.detectedChannels.map(channel => channel.commandId)).toEqual([
      'FL',
      'SW1',
    ]);
    expect(saved.detectedChannels.every(channel =>
      Object.keys(channel.responseData).length === 0,
    )).toBe(true);
    // L'objet en mémoire n'est pas muté : l'import en cours garde ses données.
    expect(jsonAvrData.detectedChannels[0].responseData[0]).toEqual([0.1, 0.2]);
  });
});

describe('restore', () => {
  it('does nothing without stored data', () => {
    const { service, applyPolling } = createHarness({ stored: null });

    service.restore();

    expect(applyPolling).not.toHaveBeenCalled();
  });

  it('restores crossovers, measurements and settings from a save', () => {
    const stored = {
      measurementsByGroup: { FL: { crossover: 80 } },
      avrFileContent: { targetModelName: 'X3800H' },
      measurements: { 0: { uuid: 'a', title: 'FL_P01' } },
      apiBaseUrl: 'http://10.0.0.2:4735',
      selectedSpeaker: 'uuid-speaker',
      targetCurve: 'harman',
      rewVersion: '5.40',
      selectedLfeFrequency: 120,
      selectedAverageMethod: 'RMS',
      isPolling: true,
      individualMaxBoostValue: '6',
      mainTargetLevel: 72,
      selectedRoomCurve: 'not-a-choice',
      autoEqConfig: { numFilters: 12 },
      SubsFrequencyBands: { lowFrequency: 20, highFrequency: 150 },
      inhibitGraphUpdates: false,
    };
    const { service, values, list, crossovers, autoEq, applyPolling, createMeasurement } =
      createHarness({ stored, settings: { selectedRoomCurve: 'None' } });

    service.restore();

    expect(crossovers.restore).toHaveBeenCalledWith({ FL: { crossover: 80 } });
    expect(createMeasurement).toHaveBeenCalledWith({ uuid: 'a', title: 'FL_P01' });
    expect(list()).toEqual([{ uuid: 'a', title: 'FL_P01', restored: true }]);
    expect(values.jsonAvrData).toEqual({ targetModelName: 'X3800H' });
    expect(values.apiBaseUrl).toBe('http://10.0.0.2:4735');
    expect(values.individualMaxBoostValue).toBe(6); // coerced to number
    expect(values.mainTargetLevel).toBe(72);
    // invalid room curve choice is ignored
    expect(values.selectedRoomCurve).toBe('None');
    expect(values.inhibitGraphUpdates).toBe(false);
    expect(autoEq.apply).toHaveBeenCalledWith({ numFilters: 12 });
    expect(values.SubsFrequencyBands).toEqual({ lowFrequency: 20, highFrequency: 150 });
    expect(applyPolling).toHaveBeenCalledWith(true);
  });

  it('stops the polling when the save was made disconnected', () => {
    const { service, applyPolling } = createHarness({
      stored: { measurements: {}, isPolling: false },
    });

    service.restore();

    expect(applyPolling).toHaveBeenCalledWith(false);
  });
});

describe('resetApplicationState', () => {
  it('clears the store, disposes the items and resets the settings', () => {
    const disposed = { dispose: vi.fn() };
    const { service, store, values, list } = createHarness({
      items: [disposed],
      settings: { targetCurve: 'harman', selectedLfeFrequency: 80 },
    });

    service.resetApplicationState();

    expect(store.clear).toHaveBeenCalledOnce();
    expect(disposed.dispose).toHaveBeenCalledOnce();
    expect(list()).toEqual([]);
    expect(values.jsonAvrData).toBeNull();
    expect(values.targetCurve).toBe('');
    expect(values.selectedLfeFrequency).toBe(250);
    expect(values.SubsFrequencyBands).toBeNull();
  });
});
