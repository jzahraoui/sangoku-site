/**
 * REW session service extracted from MeasurementViewModel
 * (décontamination lot V2 — docs/reverse/03-vm-decontamination.md, ADR 002).
 *
 * [ORCHESTRATION] service owning the connection lifecycle (polling), the
 * synchronisation of the measurement list with REW, and the application-wide
 * processing lock. No Knockout, no DOM.
 *
 * Injected dependencies:
 * - `state`: accessor object over the app state (getters/setters) —
 *   isPolling, isProcessing, isLoading, hasError (r), rewVersion (w),
 *   maxMeasurements (w), inhibitGraphUpdates (r), apiBaseUrl (r).
 *   Backed by KO observables today, by a Pinia store on the Vue side.
 * - `measurements`: accessor over the list — { get, set, push, removeWhere }.
 * - `createMeasurement(apiItem)` / `adoptMeasurement(item)`: item factory
 *   (MeasurementItem today, MeasurementRecord after ADR 002).
 * - `createApi(baseUrl)`: REW API factory (RewApi).
 * - hooks: `onConnected` (after the initial load), `onProcessingEnded`
 *   (persistence), `onApiServicesChanged` (mirrors on the viewmodel),
 *   `onError(message, error)` (UI error channel).
 *
 * The `apiService` / `rewEq` / `rewMeasurements` / `rewImport` /
 * `rewAlignmentTool` fields are plain writable properties so callers (and
 * tests) can reach the underlying API services directly.
 */

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const unwrap = value => (typeof value === 'function' ? value() : value);

const labelOf = m => unwrap(m.displayMeasurementTitle) ?? unwrap(m.title);

class RewSession {
  constructor({
    state,
    measurements,
    createMeasurement,
    adoptMeasurement,
    createApi,
    onConnected = async () => {},
    onProcessingEnded = () => {},
    onApiServicesChanged = () => {},
    onError = () => {},
    pollingInterval = 1000,
    log = noopLog,
  }) {
    this.state = state;
    this.measurements = measurements;
    this.createMeasurement = createMeasurement;
    this.adoptMeasurement = adoptMeasurement;
    this.createApi = createApi;
    this.onConnected = onConnected;
    this.onProcessingEnded = onProcessingEnded;
    this.onApiServicesChanged = onApiServicesChanged;
    this.onError = onError;
    this.pollingInterval = pollingInterval;
    this.log = log;

    this.apiService = null;
    this.rewEq = null;
    this.rewMeasurements = null;
    this.rewImport = null;
    this.rewAlignmentTool = null;
    this.pollerId = null;
    this.processingTimeout = null;
  }

  // --- Connection lifecycle --------------------------------------------------

  async startBackgroundPolling() {
    if (this.state.isPolling) return;
    if (this.state.isProcessing) return;
    if (this.state.isLoading) return;
    if (this.state.hasError) return;

    this.log.info('Starting background polling...');

    try {
      // Initial load
      this.apiService = this.createApi(this.state.apiBaseUrl);
      this.rewEq = this.apiService.rewEq;
      this.rewMeasurements = this.apiService.rewMeasurements;
      this.rewImport = this.apiService.rewImport;
      this.rewAlignmentTool = this.apiService.rewAlignmentTool;
      this.onApiServicesChanged();
      await this.apiService.initializeAPI();
      this.state.rewVersion = await this.apiService.checkVersion();
      this.state.maxMeasurements = await this.rewMeasurements.getMaxMeasurements();
      this.state.isPolling = true;
      await this.loadData();
      await this.onConnected();

      // Set up regular polling
      this.pollerId = setInterval(async () => {
        try {
          if (!this.state.isPolling) return;
          if (this.state.isProcessing) return;
          if (this.state.isLoading) return;
          if (this.state.hasError) return;

          await this.loadData();
        } catch (error) {
          this.stopBackgroundPolling();
          this.onError(`Polling failed: ${error.message}`, error);
        }
      }, this.pollingInterval);
    } catch (error) {
      this.stopBackgroundPolling();
      if (
        error.message.includes('Failed to fetch') ||
        error.message.includes('NetworkError')
      ) {
        this.onError(
          `Failed to connect to REW API at ${this.state.apiBaseUrl}. Please ensure the REW API server is running and accessible.`,
          error,
        );
      } else {
        this.onError(`Failed to start background polling: ${error.message}`, error);
      }
    }
  }

  stopBackgroundPolling() {
    this.state.isPolling = false;
    if (this.pollerId) {
      clearInterval(this.pollerId);
      this.pollerId = null;
    }
    this.apiService = null;
    this.rewEq = null;
    this.rewMeasurements = null;
    this.rewImport = null;
    this.rewAlignmentTool = null;
    this.onApiServicesChanged();
    this.state.isLoading = false;
  }

  async toggleBackgroundPolling() {
    if (this.state.isPolling) {
      this.stopBackgroundPolling();
    } else {
      await this.startBackgroundPolling();
    }
  }

  // --- Processing lock ---------------------------------------------------------

  async setProcessing(newValue) {
    if (newValue && !this.state.isPolling) {
      throw new Error('Please connect to REW before processing');
    }

    // Clear existing timeout
    if (this.processingTimeout) {
      clearTimeout(this.processingTimeout);
      this.processingTimeout = null;
    }

    this.state.isProcessing = newValue;

    // inhibit Graph Updates only during processing
    if (this.state.isPolling && this.state.inhibitGraphUpdates && this.apiService) {
      try {
        await this.apiService.setInhibitGraphUpdates(newValue);
      } catch (error) {
        if (newValue) {
          throw error;
        }
        this.log.warn(`Unable to restore graph updates: ${error.message}`);
      }
    }
    // Save to persistent when processing ends
    if (!newValue) {
      try {
        this.onProcessingEnded();
      } catch (error) {
        this.log.warn(`Unable to save measurements: ${error.message}`);
      }
    }
  }

  // --- Measurement list synchronisation ------------------------------------------

  async loadData() {
    if (!this.state.isPolling) {
      this.log.warn('Please connect to REW to load measurements');
      return;
    }

    try {
      this.state.isLoading = true;
      const data = await this.rewMeasurements.list();
      this.mergeMeasurements(data);
    } catch (error) {
      throw new Error(`Failed to load data: ${error.message}`, {
        cause: error,
      });
    } finally {
      this.state.isLoading = false;
    }
  }

  mergeMeasurements(data) {
    const apiItems = Object.values(data).filter(item => item?.uuid);
    const currentMeasurements = this.measurements.get();
    const currentByUuid = new Map(currentMeasurements.map(item => [item.uuid, item]));
    const apiUuids = new Set(apiItems.map(item => item.uuid));
    const currentUuids = new Set(currentMeasurements.map(item => item.uuid));
    const previousOrder = currentMeasurements.map(item => item.uuid).join('|');
    let hasOrphanedFilterChanges = false;

    for (const item of currentMeasurements) {
      if (item.associatedFilter && !apiUuids.has(item.associatedFilter)) {
        item.associatedFilter = null;
        hasOrphanedFilterChanges = true;
        this.log.debug(`Removing filter: ${labelOf(item)}`);
      }
    }

    const deletedMeasurements = currentMeasurements.filter(
      item => !apiUuids.has(item.uuid),
    );
    const addedMeasurements = [];
    const mergedMeasurements = apiItems.map(apiItem => {
      const existingMeasurement = currentByUuid.get(apiItem.uuid);
      if (existingMeasurement) {
        return existingMeasurement;
      }

      const newMeasurement = this.createMeasurement(apiItem);
      addedMeasurements.push(newMeasurement);
      return newMeasurement;
    });
    const nextOrder = mergedMeasurements.map(item => item.uuid).join('|');
    const hasOrderChanges = previousOrder !== nextOrder;
    const hasDeletedMeasurements = deletedMeasurements.length > 0;

    // Commit the new measurement list BEFORE pushing API deltas into existing
    // items. Otherwise, observables like `cumulativeIRShiftSeconds` may fire
    // their subscriptions synchronously and reach into a `otherPositionMeasurements`
    // computed that still includes a measurement we are about to drop, producing
    // REW API calls against UUIDs that no longer exist (404).
    if (hasOrderChanges || hasOrphanedFilterChanges || hasDeletedMeasurements) {
      this.measurements.set(mergedMeasurements);
    }

    for (const apiItem of apiItems) {
      const existingMeasurement = currentByUuid.get(apiItem.uuid);
      if (existingMeasurement) {
        existingMeasurement.updateFromApi(apiItem);
      }
    }

    for (const item of deletedMeasurements) {
      item.dispose?.();
    }

    if (deletedMeasurements.length) {
      this.log.debug(
        `Removed measurements: ${deletedMeasurements.map(item => unwrap(item.title)).join(', ')}`,
      );
    }
    if (addedMeasurements.length) {
      this.log.debug(
        `Added new measurements: ${addedMeasurements.map(item => unwrap(item.title)).join(', ')}`,
      );
    }
    if (currentUuids.size && hasOrderChanges) {
      this.log.debug('Measurements order synced with REW');
    }
  }

  async addMeasurementFromRewOperation(
    operation,
    {
      expectedTitle = null,
      operationLabel = 'measurement creation',
      timeoutMs = 5000,
      pollIntervalMs = 100,
    } = {},
  ) {
    if (typeof operation !== 'function') {
      throw new TypeError('operation must be a function');
    }

    const beforeData = await this.rewMeasurements.list();
    const beforeUuids = new Set(
      Object.values(beforeData)
        .filter(item => item?.uuid)
        .map(item => item.uuid),
    );

    await operation();

    const startedAt = Date.now();
    let latestData = beforeData;

    while (Date.now() - startedAt <= timeoutMs) {
      latestData = await this.rewMeasurements.list();
      const newApiItems = Object.values(latestData).filter(
        item => item?.uuid && !beforeUuids.has(item.uuid),
      );

      if (newApiItems.length) {
        const createdItem = this.selectCreatedMeasurement(newApiItems, expectedTitle);
        this.mergeMeasurements(latestData);
        const measurement = this.findMeasurementByUuid(createdItem.uuid);

        if (!measurement) {
          throw new Error(`Created measurement not found after ${operationLabel}`);
        }

        return measurement;
      }

      await this.waitForRewMeasurement(pollIntervalMs);
    }

    this.mergeMeasurements(latestData);
    throw new Error(`Unable to find created measurement after ${operationLabel}`);
  }

  selectCreatedMeasurement(apiItems, expectedTitle) {
    if (!apiItems.length) {
      return null;
    }

    const normalizedExpectedTitle = expectedTitle?.trim();
    if (normalizedExpectedTitle) {
      const exactMatch = apiItems.find(item => item.title === normalizedExpectedTitle);
      if (exactMatch) {
        return exactMatch;
      }

      const prefixMatch = apiItems.find(
        item =>
          item.title?.startsWith(normalizedExpectedTitle) ||
          normalizedExpectedTitle.startsWith(item.title),
      );
      if (prefixMatch) {
        return prefixMatch;
      }
    }

    return apiItems.at(-1);
  }

  waitForRewMeasurement(delayMs) {
    return new Promise(resolve => setTimeout(resolve, delayMs));
  }

  findMeasurementByUuid(uuid) {
    return this.measurements.get().find(m => m.uuid === uuid);
  }

  async analyseApiResponse(commandResult) {
    if (!commandResult) {
      throw new Error('Invalid command result');
    }
    if (typeof commandResult !== 'object') {
      throw new TypeError('Command result must be an object');
    }
    // test if object is empty
    if (Object.keys(commandResult).length === 0) {
      throw new Error('Command result is empty');
    }

    // new measurement created
    const operationResults = commandResult.results || commandResult.message?.results;
    const operationResultUuid = Object.values(operationResults || {})[0]?.UUID;
    if (!operationResultUuid) {
      throw new Error('No measurement UUID found in command result');
    }

    return this.addMeasurementApi(operationResultUuid);
  }

  async addMeasurementApi(itemUuid) {
    try {
      if (!itemUuid) {
        throw new Error('Add Measurement: Invalid measurement item');
      }
      const existingItem = this.findMeasurementByUuid(itemUuid);
      if (existingItem) {
        this.log.warn(`measurement ${itemUuid} already exists, not added`);
        return existingItem;
      }
      const item = await this.rewMeasurements.get(itemUuid);
      const measurementItem = this.createMeasurement(item);
      this.measurements.push(measurementItem);
      this.log.debug(`measurement ${unwrap(measurementItem.title)} added`);
      return measurementItem;
    } catch (error) {
      this.onError(`Failed to add measurement: ${error.message}`, error);
      return false;
    }
  }

  async addMeasurement(item) {
    if (!item) {
      throw new Error('Add Measurement: Invalid measurement item');
    }
    const existingItem = this.findMeasurementByUuid(item.uuid);
    if (existingItem) {
      this.log.warn(`measurement ${labelOf(existingItem)} already exists, not added`);
      return existingItem;
    }
    const measurementItem = this.adoptMeasurement(item);
    this.measurements.push(measurementItem);
    this.log.debug(`measurement ${unwrap(measurementItem.title)} added`);
    return measurementItem;
  }

  async removeMeasurements(items) {
    if (!items || items.length === 0) {
      return false;
    }

    for (const item of items) {
      await this.removeMeasurement(item);
    }
    return true;
  }

  async removeMeasurement(item) {
    if (!item) {
      return false;
    }

    await this.removeMeasurementUuid(item.uuid);
    // remove associatedFilter
    await this.removeMeasurementUuid(item.associatedFilter);

    this.log.debug(`measurement ${labelOf(item)} removed`);

    return true;
  }

  async removeMeasurementUuid(itemUuid) {
    if (!itemUuid) {
      return false;
    }

    if (!this.findMeasurementByUuid(itemUuid)) {
      this.log.debug('nothing to delete');
      return false;
    }

    try {
      // First attempt to delete from API to ensure consistency
      await this.rewMeasurements.delete(itemUuid);

      this.measurements.removeWhere(item => item.uuid === itemUuid);

      this.log.debug(`measurement ${itemUuid} removed`);

      return true; // Indicate successful deletion
    } catch (error) {
      if (error.message.includes('There is no measurement')) {
        this.log.warn(`measurement ${itemUuid} not found, not removed`);
        return false;
      }
      throw new Error(`Failed to remove measurement: ${error.message}`, { cause: error });
    }
  }

  // --- Bulk maintenance ---------------------------------------------------------

  async renameMeasurements() {
    for (const item of this.measurements.get()) {
      if (unwrap(item.position) === 0) {
        continue;
      }
      // do not rename averaged measurements
      if (item.isAverage) {
        continue;
      }

      if (item.isUnknownChannel) {
        continue;
      }

      const newName = `${unwrap(item.channelName)}_P${unwrap(item.position)
        .toString()
        .padStart(2, '0')}`;

      item.setTitle(newName);
    }
  }
}

function createRewSession(deps) {
  return new RewSession(deps);
}

export { RewSession, createRewSession };
