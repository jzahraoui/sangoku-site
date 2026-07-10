import RoomCurvesSettings from '../room-curve-settings.js';

/**
 * Persistence service extracted from MeasurementViewModel
 * (décontamination lot V6 — docs/reverse/03-vm-decontamination.md).
 *
 * [ORCHESTRATION] service: serialises the session (measurements + settings)
 * into the persistent store and restores it. No Knockout, no DOM.
 *
 * Construction dependencies:
 * - `store`: the PersistentStore (save/load/clear) — D-07: conservé tel quel.
 * - `settings`: generic accessor — { get(name), set(name, value) }. Persisted
 *   keys match the viewmodel observable names, except `avrFileContent` which
 *   maps to `jsonAvrData` (handled here).
 * - `measurements`: list accessor { get, set }.
 * - `createMeasurement(saved)`: item factory for restored measurements.
 * - `crossovers`: { toJSON(), restore(groups) } — per-group crossover map.
 * - `autoEq`: { toJSON(), apply(config) } — AutoEQ tuning block.
 * - `applyPolling(shouldPoll)`: start/stop the REW session polling.
 */

function createPersistenceService({
  store,
  settings,
  measurements,
  createMeasurement,
  crossovers,
  autoEq,
  applyPolling,
}) {
  function saveMeasurements() {
    // Save to persistent store
    const reducedMeasurements = measurements.get().map(item => item.toJSON());
    const data = {
      measurements: reducedMeasurements,
      selectedSpeaker: settings.get('selectedSpeaker'),
      targetCurve: settings.get('targetCurve'),
      rewVersion: settings.get('rewVersion'),
      selectedLfeFrequency: settings.get('selectedLfeFrequency'),
      selectedAverageMethod: settings.get('selectedAverageMethod'),
      maxBoostIndividualValue: settings.get('maxBoostIndividualValue'),
      maxBoostOverallValue: settings.get('maxBoostOverallValue'),
      avrFileContent: settings.get('jsonAvrData'),
      loadedFileName: settings.get('loadedFileName'),
      isPolling: settings.get('isPolling'),
      selectedSmoothingMethod: settings.get('selectedSmoothingMethod'),
      selectedIrWindows: settings.get('selectedIrWindows'),
      individualMaxBoostValue: settings.get('individualMaxBoostValue'),
      overallBoostValue: settings.get('overallBoostValue'),
      upperFrequencyBound: settings.get('upperFrequencyBound'),
      lowerFrequencyBound: settings.get('lowerFrequencyBound'),
      upperFrequencyBoundSub: settings.get('upperFrequencyBoundSub'),
      lowerFrequencyBoundSub: settings.get('lowerFrequencyBoundSub'),
      apiBaseUrl: settings.get('apiBaseUrl'),
      ocaFileFormat: settings.get('ocaFileFormat'),
      avrIpAddress: settings.get('avrIpAddress'),
      inhibitGraphUpdates: settings.get('inhibitGraphUpdates'),
      selectedEqualizationMode: settings.get('selectedEqualizationMode'),
      selectedRoomCurve: settings.get('selectedRoomCurve'),
      measurementsByGroup: crossovers.toJSON(),
      mainTargetLevel: settings.get('mainTargetLevel'),
      autoEqConfig: autoEq.toJSON(),
      SubsFrequencyBands: settings.get('SubsFrequencyBands'),
    };
    store.save(data);
  }

  function restore() {
    const data = store.load();
    if (!data) return;

    restoreMeasurementGroups(data);
    restoreAvrAndMeasurements(data);
    restoreSettings(data);
  }

  function restoreMeasurementGroups(data) {
    if (!data.measurementsByGroup) return;
    crossovers.restore(data.measurementsByGroup);
  }

  function restoreAvrAndMeasurements(data) {
    if (!data.avrFileContent) return;
    settings.set('jsonAvrData', data.avrFileContent);
    const enhancedMeasurements = Object.values(data.measurements).map(item =>
      createMeasurement(item),
    );
    measurements.set(enhancedMeasurements);
  }

  function restoreSettings(data) {
    data.apiBaseUrl && settings.set('apiBaseUrl', data.apiBaseUrl);
    settings.set('selectedSpeaker', data.selectedSpeaker);
    settings.set('targetCurve', data.targetCurve);
    settings.set('rewVersion', data.rewVersion);
    settings.set('selectedLfeFrequency', data.selectedLfeFrequency);
    settings.set('selectedAverageMethod', data.selectedAverageMethod);
    settings.set('maxBoostIndividualValue', data.maxBoostIndividualValue || 0);
    settings.set('maxBoostOverallValue', data.maxBoostOverallValue || 0);
    settings.set('loadedFileName', data.loadedFileName || '');
    applyPolling(Boolean(data.isPolling));
    data.selectedSmoothingMethod &&
      settings.set('selectedSmoothingMethod', data.selectedSmoothingMethod);
    data.selectedIrWindows && settings.set('selectedIrWindows', data.selectedIrWindows);
    data.individualMaxBoostValue &&
      settings.set('individualMaxBoostValue', +data.individualMaxBoostValue);
    data.overallBoostValue && settings.set('overallBoostValue', +data.overallBoostValue);
    data.upperFrequencyBound &&
      settings.set('upperFrequencyBound', data.upperFrequencyBound);
    data.lowerFrequencyBound &&
      settings.set('lowerFrequencyBound', data.lowerFrequencyBound);
    data.upperFrequencyBoundSub &&
      settings.set('upperFrequencyBoundSub', data.upperFrequencyBoundSub);
    data.lowerFrequencyBoundSub &&
      settings.set('lowerFrequencyBoundSub', data.lowerFrequencyBoundSub);
    data.ocaFileFormat && settings.set('ocaFileFormat', data.ocaFileFormat);
    data.avrIpAddress && settings.set('avrIpAddress', data.avrIpAddress);
    data.inhibitGraphUpdates !== undefined &&
      settings.set('inhibitGraphUpdates', data.inhibitGraphUpdates);
    restoreEqualizationMode(data);
    restoreRoomCurveChoice(data);
    data.mainTargetLevel && settings.set('mainTargetLevel', data.mainTargetLevel);
    if (data.autoEqConfig) {
      autoEq.apply(data.autoEqConfig);
    }
    data.SubsFrequencyBands &&
      settings.set('SubsFrequencyBands', data.SubsFrequencyBands);
  }

  function restoreEqualizationMode(data) {
    // selectedSpeakerFilterMode: legacy key of older saves
    const selectedEqualizationMode =
      data.selectedEqualizationMode || data.selectedSpeakerFilterMode;
    if (selectedEqualizationMode) {
      settings.set('selectedEqualizationMode', selectedEqualizationMode);
    }
  }

  function restoreRoomCurveChoice(data) {
    if (RoomCurvesSettings.hasChoice(data.selectedRoomCurve)) {
      settings.set('selectedRoomCurve', data.selectedRoomCurve);
    }
  }

  function resetApplicationState() {
    store.clear();

    // Reset all application state
    for (const item of measurements.get()) {
      item.dispose();
    }
    measurements.set([]);
    settings.set('jsonAvrData', null);

    settings.set('targetCurve', '');
    settings.set('rewVersion', '');
    settings.set('maxBoostIndividualValue', 0);
    settings.set('maxBoostOverallValue', 0);
    settings.set('loadedFileName', '');

    // Reset selectors to default values
    settings.set('selectedSpeaker', '');
    settings.set('selectedLfeFrequency', 250);
    settings.set('selectedAverageMethod', '');
    settings.set('selectedMeasurementsFilter', true);
    settings.set('selectedEqualizationMode', 'rew');
    settings.set('selectedRoomCurve', RoomCurvesSettings.DEFAULT_CHOICE);
    settings.set('SubsFrequencyBands', null);
  }

  return {
    resetApplicationState,
    restore,
    saveMeasurements,
  };
}

export { createPersistenceService };
