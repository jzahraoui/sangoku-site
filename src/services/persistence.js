import RoomCurvesSettings from '../room-curve-settings.js';

/**
 * Persistence service extracted from MeasurementViewModel
 *.
 *
 * [ORCHESTRATION] service: serialises the session (measurements + settings)
 * into the persistent store and restores it. No Knockout, no DOM.
 *
 * The session payload is shared between the two persistence channels:
 * `buildSessionPayload()` / `applySessionPayload(payload)` are consumed by
 * the continuous localStorage auto-save (`saveMeasurements` / `restore`) and
 * by the session file export/import (services/session-file.js).
 *
 * Construction dependencies:
 * - `store`: the PersistentStore (save/load/clear) — conservé tel quel.
 * - `settings`: generic accessor — { get(name), set(name, value) }. Persisted
 *   keys match the viewmodel observable names, except `avrFileContent` which
 *   maps to `jsonAvrData` (handled here).
 * - `measurements`: list accessor { get, set }.
 * - `createMeasurement(saved)`: item factory for restored measurements.
 * - `crossovers`: { toJSON(), restore(groups) } — per-group crossover map.
 * - `autoEq`: { toJSON(), apply(config) } — AutoEQ tuning block.
 * - `applyPolling(shouldPoll)`: start/stop the REW session polling.
 * - `applyBridgeConnection(shouldConnect)`: bridge auto-reconnection.
 * - `banks` (optional): { toJSON(), restore(data) } — the Reference/Flat
 *   filter banks (services/filter-banks.js). Included in the payload; on the
 *   localStorage channel they are best-effort (see quota guard below).
 * - `onMeasurementsRestored(items)`: hook fired with the restored items so
 *   the REW sync can report the ones not found in REW (rew-session.js).
 * - `onAutoSaveBanksDropped()`: hook fired when the auto-save had to leave
 *   the banks out (storage quota) — the UI surfaces a translated warning.
 */

/**
 * Le contrat ADR 002 exclut les données de signal de la persistance : les
 * impulsions du fichier ADY (`detectedChannels[].responseData`) sont vidées
 * après import, mais une sauvegarde déclenchée PENDANT l'import les voit
 * encore et dépasse le quota localStorage (~15 Mo pour 45 mesures — observé
 * en production 1.2.55). Les retirer au point de sauvegarde rend l'ordre des
 * opérations indifférent.
 */
function stripSignalData(avrFileContent) {
  if (!avrFileContent?.detectedChannels) {
    return avrFileContent;
  }
  return {
    ...avrFileContent,
    detectedChannels: avrFileContent.detectedChannels.map(channel => ({
      ...channel,
      responseData: {},
    })),
  };
}

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function createPersistenceService({
  store,
  settings,
  measurements,
  createMeasurement,
  crossovers,
  autoEq,
  applyPolling,
  applyBridgeConnection = () => {},
  banks = null,
  onMeasurementsRestored = () => {},
  log = noopLog,
  onAutoSaveBanksDropped = () =>
    log.warn(
      'Filter banks were left out of the auto-save (browser storage quota): ' +
        'export the session to a file to keep them',
    ),
}) {
  // Avoid re-warning on every auto-save while the quota stays exceeded.
  let banksDropWarned = false;

  /**
   * Session payload shared by the localStorage auto-save and the session
   * file. Measurements are `toJSON()` records — never any signal data
   * (impulses/responses), per ADR 002.
   */
  function buildSessionPayload() {
    const payload = {
      measurements: measurements.get().map(item => item.toJSON()),
      selectedSpeaker: settings.get('selectedSpeaker'),
      targetCurve: settings.get('targetCurve'),
      rewVersion: settings.get('rewVersion'),
      selectedLfeFrequency: settings.get('selectedLfeFrequency'),
      selectedAverageMethod: settings.get('selectedAverageMethod'),
      maxBoostIndividualValue: settings.get('maxBoostIndividualValue'),
      maxBoostOverallValue: settings.get('maxBoostOverallValue'),
      avrFileContent: stripSignalData(settings.get('jsonAvrData')),
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
      avrIpAddress: settings.get('avrIpAddress'),
      bridgeBaseUrl: settings.get('bridgeBaseUrl'),
      avrModelName: settings.get('avrModelName'),
      isBridgeConnected: settings.get('bridgeConnected'),
      inhibitGraphUpdates: settings.get('inhibitGraphUpdates'),
      selectedRoomCurve: settings.get('selectedRoomCurve'),
      measurementsByGroup: crossovers.toJSON(),
      mainTargetLevel: settings.get('mainTargetLevel'),
      autoEqConfig: autoEq.toJSON(),
      SubsFrequencyBands: settings.get('SubsFrequencyBands'),
    };
    if (banks) {
      payload.filterBanks = banks.toJSON();
    }
    return payload;
  }

  /**
   * Writes a session payload to the persistent store. The filter banks are
   * best-effort on this channel: two XT32 banks weigh ~2 MB of base64 and can
   * exceed the localStorage quota — in that case the payload is saved again
   * WITHOUT the banks so the rest of the auto-save survives, and a warning
   * tells the user to export the session to a file instead.
   */
  function persistPayload(payload) {
    if (payload.filterBanks == null) {
      // No banks in the payload: the historical single-save path, with the
      // store's own (loud) failure logging.
      return store.save(payload);
    }
    if (store.save(payload, { quiet: true })) {
      banksDropWarned = false;
      return true;
    }
    if (store.lastSaveError?.name !== 'QuotaExceededError') {
      // Not the banks-over-quota case: replay loud so the historical store
      // logging is preserved.
      return store.save(payload);
    }
    const withoutBanks = { ...payload };
    delete withoutBanks.filterBanks;
    const saved = store.save(withoutBanks);
    if (saved && !banksDropWarned) {
      banksDropWarned = true;
      onAutoSaveBanksDropped();
    }
    return saved;
  }

  function saveMeasurements() {
    // Save to persistent store
    persistPayload(buildSessionPayload());
  }

  function restore() {
    const data = store.load();
    if (!data) return;

    applySessionPayload(data);
  }

  /** Applies a session payload to the application (shared restore path). */
  function applySessionPayload(data) {
    if (!data) return;
    restoreMeasurementGroups(data);
    restoreAvrAndMeasurements(data);
    restoreSettings(data);
    restoreBanks(data);
  }

  function restoreMeasurementGroups(data) {
    if (!data.measurementsByGroup) return;
    crossovers.restore(data.measurementsByGroup);
  }

  function restoreAvrAndMeasurements(data) {
    if (!data.avrFileContent) return;
    settings.set('jsonAvrData', data.avrFileContent);
    // A session import can replace an existing list (boot restore starts
    // empty): release the previous items' subscriptions first.
    for (const item of measurements.get()) {
      item.dispose?.();
    }
    const enhancedMeasurements = Object.values(data.measurements ?? {}).map(item =>
      createMeasurement(item),
    );
    measurements.set(enhancedMeasurements);
    onMeasurementsRestored(enhancedMeasurements);
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
    data.avrIpAddress && settings.set('avrIpAddress', data.avrIpAddress);
    restoreBridgeSettings(data);
    data.inhibitGraphUpdates !== undefined &&
      settings.set('inhibitGraphUpdates', data.inhibitGraphUpdates);
    restoreRoomCurveChoice(data);
    data.mainTargetLevel && settings.set('mainTargetLevel', data.mainTargetLevel);
    if (data.autoEqConfig) {
      autoEq.apply(data.autoEqConfig);
    }
    data.SubsFrequencyBands &&
      settings.set('SubsFrequencyBands', data.SubsFrequencyBands);
  }

  function restoreBridgeSettings(data) {
    data.bridgeBaseUrl && settings.set('bridgeBaseUrl', data.bridgeBaseUrl);
    data.avrModelName && settings.set('avrModelName', data.avrModelName);
    applyBridgeConnection(Boolean(data.isBridgeConnected));
  }

  function restoreBanks(data) {
    if (!banks) return;
    // A payload without banks (pre-2.0 auto-save, quota-degraded auto-save)
    // clears them: the restored session state must not mix with leftovers.
    banks.restore(data.filterBanks ?? null);
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
    settings.set('selectedRoomCurve', RoomCurvesSettings.DEFAULT_CHOICE);
    settings.set('SubsFrequencyBands', null);

    // The filter banks are session state too (saved/restored with it).
    if (banks) {
      banks.restore(null);
    }
  }

  return {
    applySessionPayload,
    buildSessionPayload,
    persistPayload,
    resetApplicationState,
    restore,
    saveMeasurements,
  };
}

export { createPersistenceService };
