import RewApi from './rew/rew-api.js';
import MeasurementItem from './MeasurementItem.js';
import PersistentStore from './PersistentStore.js';
import BusinessTools from './BusinessTools.js';
import translations from './translations.js';
import AdyTools from './ady-tools.js';
import MultiSubOptimizer from './multi-sub-optimizer.js';
import AvrCaracteristics from './avr-caracteristics.js';
import ko from 'knockout';
import { saveAs } from 'file-saver';
import lm from './logs.js';
import koLogs from './ko-logs.js';
import { Room3DViewer } from './room-3d-viewer.js';
import RoomCurvesSettings from './room-curve-settings.js';
import {
  findPredictedLfeForPosition,
  filterPredictedLfe,
  groupByChannel,
  groupByPosition,
  positionChoices,
} from './measurement/measurement-selection.js';
import { createRewSession } from './services/rew-session.js';
import {
  MAX_FILE_SIZE_BYTES,
  VALID_FILE_EXTENSIONS,
  createImportSession,
} from './services/import-session.js';
import { createExportsService } from './services/exports.js';
import {
  createAlignmentService,
  getTargetLevelAtFreq,
  setSameDelayToAll,
} from './services/alignment.js';
import { createTargetCurveService } from './services/target-curve.js';
import { createAverages } from './services/averaging.js';
import {
  MAXIMISED_SUM_TITLE,
  createSubOptimizationService,
  getMaxFromArray,
} from './services/sub-optimization.js';
import {
  createFiltersService,
  selectMeasurementsForBulkApply,
} from './services/filters.js';
import { createPersistenceService } from './services/persistence.js';

import { ConfirmDialogManager, confirmMessages } from './js/confirmDialog.js';

const store = new PersistentStore('myAppData');
// Import/export orchestration lives in src/services/.
const importSession = createImportSession({ log: lm });
const exportsService = createExportsService({ log: lm });
const DEFAULT_IR_WINDOW_CHOICE = 'Optimized MTW';
const FALLBACK_IR_WINDOW_CHOICE = 'None';
// ALIGN_OFFSET_TOLERANCE et quantize3dB vivent désormais dans
// src/measurement/measurement-selection.js.
const IR_WINDOW_PRESETS = {
  None: {
    leftWindowType: 'Rectangular',
    rightWindowType: 'Rectangular',
    addFDW: false,
    addMTW: false,
  },
  'Optimized MTW': {
    leftWindowType: 'Rectangular',
    rightWindowType: 'Rectangular',
    addFDW: false,
    addMTW: true,
    mtwTimesms: [9000, 3000, 450, 120, 30, 7.7, 2.6, 0.9, 0.4, 0.15],
  },
};

/**
 * Creates a proxy that exposes the instance's Knockout observables as
 * plain properties (get/set). Reading `proxy.foo` calls `instance.foo()`,
 * writing `proxy.foo = x` calls `instance.foo(x)`. Non-observable
 * properties are passed through unchanged.
 *
 * This replaces the previous `bindState` helper and the `self = this` alias:
 * no per-property listing needed, and arrow functions in the trap capture
 * `instance` lexically.
 *
 * @param {object} instance - The MeasurementViewModel instance
 * @param {string[]} [keys] - Optional allowlist of property names to expose
 * @returns {object} Proxy with get/set traps over the observables
 */
function observableProxy(instance, keys) {
  const allowed = keys ? new Set(keys) : null;
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (allowed && !allowed.has(prop)) return undefined;
      const value = instance[prop];
      return typeof value === 'function' ? value() : value;
    },
    set(_target, prop, value) {
      if (typeof prop !== 'string') return false;
      if (allowed && !allowed.has(prop)) return false;
      const observable = instance[prop];
      if (typeof observable === 'function') {
        observable(value);
      } else {
        instance[prop] = value;
      }
      return true;
    },
  });
}

class MeasurementViewModel {
  static DEFAULT_SHIFT_IN_METERS = 3;
  static MAXIMISED_SUM_TITLE = MAXIMISED_SUM_TITLE;
  static MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_BYTES;
  static VALID_FILE_EXTENSIONS = VALID_FILE_EXTENSIONS;

  blocking = true;
  pollingInterval = 1000; // 1 seconds

  constructor() {
    // Gestionnaire de confirmation
    this.confirmManager = new ConfirmDialogManager();

    // Exposer les observables pour Knockout
    this.showConfirmDialog = this.confirmManager.showConfirmDialog;
    this.confirmDialogTitle = this.confirmManager.confirmDialogTitle;
    this.confirmDialogMessage = this.confirmManager.confirmDialogMessage;

    this.inhibitGraphUpdates = ko.observable(true);
    this.autoEqConfig = {
      numFilters: ko.observable(20),
      maxCutDb: ko.observable(15),
      flatnessTarget: ko.observable(0.3),
      numOptimizationPasses: ko.observable(20),
      gainSignLockThreshold: ko.observable(0.5),
      notchExclusionThreshold: ko.observable(6),
      minFilterGain: ko.observable(0.4),
      enableBeatRewOptimization: ko.observable(true),
      enableCandidatePlacement: ko.observable(true),
      enableReduceRepair: ko.observable(true),
      enableCriticalBandRefinement: ko.observable(true),
      enableRefinement: ko.observable(false),
      refinementIterations: ko.observable(100),
      varyQAbove200Hz: ko.observable(false),
      allowNarrowFiltersBelow200Hz: ko.observable(true),
      allowBoosts: ko.observable(true),
    };
    this.isPolling = ko.observable(false);
    // Add translation support
    this.translations = ko.observable(
      translations[localStorage.getItem('userLanguage') || 'en'],
    );

    this.ocaFileFormat = ko.observable('odd');
    this.avrIpAddress = ko.observable('');

    this.SubsFrequencyBands = null;

    // retreive version from index.html
    this.currentVersion = document
      .querySelector('footer .version')
      .textContent.replace('Version ', '');

    // API Service
    this.apiBaseUrl = ko.observable('http://localhost:4735');
    // subscribe to changes in apiBaseUrl to update apiService
    this.apiBaseUrl.subscribe(newValue => {
      if (this.apiService) {
        this.apiService.setBaseURL(newValue);
      }
    });
    this.apiService = null;
    this.rewEq = null;
    this.rewMeasurements = null;
    this.rewImport = null;
    this.rewAlignmentTool = null;
    this.maxMeasurements = ko.observable(0);

    this.businessTools = new BusinessTools(this);

    // index.html binds the log panel (lm.autoScroll / logLevel / filteredLogs /
    // exportLogs) to the Knockout display adapter over the agnostic log service.
    this.lm = koLogs;

    // Observables
    this.measurements = ko.observableArray([]);
    this.isLoading = ko.observable(false);
    this.error = ko.observable('');
    this.status = ko.observable('');
    this.selectedItem = ko.observable(null);
    this.upperFrequencyBound = ko.observable(16000);
    this.lowerFrequencyBound = ko.observable(20);

    this.upperFrequencyBoundSub = ko.observable(500);
    this.lowerFrequencyBoundSub = ko.observable(10);

    // Computed
    this.hasStatus = ko.pureComputed(() => !this.error() && this.status() !== '');
    this.hasError = ko.pureComputed(() => this.error() !== '');
    this.hasItems = ko.pureComputed(() => this.measurements().length > 0);

    this.handleError = (message, error) => {
      if (!message) message = 'An unknown error occurred';
      lm.error(message);
      this.error(message);
      this.status('');
      if (error) {
        console.error(error.stack ?? error);
      } else {
        console.error(message);
      }
    };

    this.handleSuccess = message => {
      lm.success(message);
      this.error('');
      this.status(message);
    };

    // Observable for selected speaker
    this.selectedSpeaker = ko.observable('');

    // Observable for target curve
    this.targetCurve = ko.observable('None');
    this.rewVersion = ko.observable('');

    // Observable for the selected value
    this.selectedLfeFrequency = ko.observable(250);

    // Observable for the selected value
    this.gobalCrossover = ko.observable();

    // Filter observables
    this.selectedMeasurementsFilter = ko.observable(true);
    this.selectedEqualizationMode = ko.observable('rew');

    this.selectedEqualizationTooltip = ko.pureComputed(() => {
      if (this.selectedEqualizationMode() === 'rch') {
        return this.translations().create_rch_speaker_filter_tooltip;
      }
      return this.translations().create_speaker_filter_tooltip;
    });

    // Available filter options
    this.selectedMeasurements = [
      { value: true, text: 'Selected' },
      { value: false, text: 'All' },
    ];

    this.selectedAverageMethod = ko.observable('');

    // Array of frequency options
    this.averageMethod = [
      { value: 'Vector average', text: 'Vector average' },
      { value: 'Magn plus phase average', text: 'RMS + phase avg.' },
      { value: 'dB plus phase average', text: 'dB + phase avg.' },
    ];

    // Array of smoothing options
    this.smoothingChoices = [
      { value: '1/1', text: '1/1 Octave' },
      { value: '1/2', text: '1/2 Octave' },
      { value: '1/3', text: '1/3 Octave' },
      { value: '1/6', text: '1/6 Octave' },
      { value: '1/12', text: '1/12 Octave' },
      { value: '1/24', text: '1/24 Octave' },
      { value: '1/48', text: '1/48 Octave' },
      { value: 'Var', text: 'Variable' },
      { value: 'Psy', text: 'Psychoacoustic' },
      { value: 'ERB', text: 'ERB' },
      { value: 'None', text: 'None' },
    ];

    this.selectedSmoothingMethod = ko.observable('None');

    this.irWindowsChoices = Object.keys(IR_WINDOW_PRESETS).map(value => ({
      value,
      text: value,
    }));

    this.selectedIrWindows = ko.observable(DEFAULT_IR_WINDOW_CHOICE);

    this.selectedIrWindowsConfig = ko.pureComputed(() => this.getIrWindowConfig());

    this.roomCurveChoices = RoomCurvesSettings.getChoices();
    this.selectedRoomCurve = ko.observable(RoomCurvesSettings.DEFAULT_CHOICE);

    // Subscribe to changes in global crossover
    this.gobalCrossover.subscribe(newValue => {
      if (newValue === undefined) return;
      for (const group of Object.values(this.measurementsByGroup())) {
        if (!group.isSub) {
          group.crossover(newValue);
        }
      }
    });

    // Observable to track drag state
    this.isDragging = ko.observable(false);

    // Observable array to store JSON data
    this.jsonAvrData = ko.observable();
    this.room3DViewer = null;

    this.jsonAvrData.subscribe(data => {
      if (data?.detectedChannels) {
        setTimeout(() => {
          if (this.room3DViewer) this.room3DViewer.destroy();
          this.room3DViewer = new Room3DViewer('room-canvas');
          this.room3DViewer.init(data.detectedChannels);
        }, 100);
      } else if (this.room3DViewer) {
        this.room3DViewer.destroy();
        this.room3DViewer = null;
      }
    });

    this.hasChannel = channelId => {
      if (!this.jsonAvrData()?.detectedChannels) {
        return false;
      }
      return this.jsonAvrData().detectedChannels.some(
        channel => channel.commandId === channelId,
      );
    };

    // Array of frequency options with fallback values
    this.alingFrequencies = ko.pureComputed(() => {
      const indexes = this.jsonAvrData()?.avr?.frequencyIndexes;
      return indexes || AvrCaracteristics.DEFAULT_FREQUENCIES;
    });

    this.LfeFrequencies = ko.pureComputed(() => {
      const freqs = this.jsonAvrData()?.avr?.lfeFrequencies;
      return freqs || AvrCaracteristics.DEFAULT_LFE_FREQUENCIES;
    });

    // subwoofer filter options
    this.maxBoostIndividualValue = ko.observable(0);
    this.minIndividualValue = 0;
    this.maxIndividualValue = 6;
    this.maxBoostOverallValue = ko.observable(0);
    this.minOverallValue = 0;
    this.maxOverallValue = 3;
    this.loadedFileName = ko.observable('');
    this.distanceUnit = ko.observable('M');
    this.visibleColumns = ko.observable({
      delay: false,
      peak: false,
      distance: false,
      shiftDelay: false,
    });

    // speaker filter options
    this.individualMaxBoostValue = ko.observable(3);
    this.individualMaxBoostValueMin = 0;
    this.individualMaxBoostValueMax = 6;
    this.overallBoostValue = ko.observable(3);
    this.overallBoostValueMin = 0;
    this.overallBoostValueMax = 6;
    this.areSpeakerBoostControlsDisabled = ko.pureComputed(
      () => !this.autoEqConfig.allowBoosts(),
    );

    this.autoEqConfig.allowBoosts.subscribe(allowBoosts => {
      if (!allowBoosts) {
        this.individualMaxBoostValue(0);
        this.overallBoostValue(0);
      }

      this.saveMeasurements();
    });

    this._crossoverMap = {};
    this.measurementsByGroup = ko.pureComputed(() =>
      this.measurements().reduce((map, item) => {
        const g = item.groupName();
        if (!map[g]) {
          if (!this._crossoverMap[g])
            this._crossoverMap[g] = ko.observable(
              item.isSub() ? 0 : MeasurementItem.DEFAULT_CROSSOVER_VALUE,
            );
          map[g] = { crossover: this._crossoverMap[g], isSub: item.isSub() };
        }
        return map;
      }, {}),
    );

    // File import — validation/parsing/REW import in services/import-session.js
    //; only the DOM parts (File reading, download buttons) stay here.
    this.validateFile = file => importSession.validateFile(file);

    this.processMqxFile = async data =>
      importSession.processMqxFile(data, this.jsonAvrData());

    this.normalizeChannelMapping = data => importSession.normalizeChannelMapping(data);

    this.processImpulseResponse = async (processedResponse, adyTools) =>
      importSession.importImpulseResponse(this.rewSession, processedResponse, {
        sampleRate: adyTools.samplingRate,
        splOffset: this.jsonAvrData().avr?.splOffset ?? 80,
      });

    this.processAdyMeasurements = async (data, filename, adyTools, zipContent) => {
      // Create download buttons
      const results = document.getElementById('resultsAvr');
      const button = document.createElement('button');
      button.textContent = `Download measurements zip`;
      button.onclick = () => saveAs(zipContent, `${data.title}.zip`);
      results.appendChild(button);

      await importSession.importAdyImpulses(this.rewSession, adyTools, {
        filename,
        splOffset: this.jsonAvrData().avr?.splOffset ?? 80,
      });
    };

    this.onFileLoaded = async (data, filename) => {
      lm.info('Loading file: ' + filename);

      try {
        if (filename.endsWith('.mqx')) {
          // convert mqx to ady like structure
          data = await this.processMqxFile(data, filename);
        }

        const results = document.getElementById('resultsAvr');
        if (!results) {
          throw new Error('Results element not found');
        }
        results.innerHTML = '';

        if (!data.detectedChannels?.[0]) {
          throw new Error('No channels detected');
        }

        this.normalizeChannelMapping(data);

        const avr = new AvrCaracteristics(data.targetModelName, data.enMultEQType);
        data.avr = avr.toJSON();

        // if has cirrus logic dsp select a1 format otherwise odd format
        if (avr.hasCirrusLogicDsp) {
          this.ocaFileFormat('a1');
        } else {
          this.ocaFileFormat('odd');
        }
        // reset application
        this.resetApplicationState();

        // load jsonAvrData to prevent bug when avr data is not loaded
        this.jsonAvrData(data);

        // Check if we have any measurements meaning we have a ady file
        if (!data.detectedChannels?.[0].responseData?.[0]) {
          lm.warn('No measurement data found in file');
          return;
        }

        const needCal = data.avr.hasCirrusLogicDsp || filename.endsWith('.mqx');
        const adyTools = new AdyTools(data);
        // create zip containing all measurements
        const zipContent = await adyTools.parseContent(needCal);
        await this.processAdyMeasurements(data, filename, adyTools, zipContent);

        this.handleSuccess('File loaded successfully');
      } catch (error) {
        throw new Error(`File processing failed: ${error.message}`, {
          cause: error,
        });
      } finally {
        // Clean up response data regardless of file type
        if (data?.detectedChannels && Array.isArray(data.detectedChannels)) {
          for (const channel of data.detectedChannels) {
            channel.responseData = {};
          }
          this.jsonAvrData(data);
        }
      }
    };

    // Handle file reading — DOM File access stays here, parsing is service-side
    this.readFile = async file => {
      if (this.isProcessing()) return;

      try {
        if (!file) {
          throw new Error('No file selected');
        }

        this.validateFile(file);

        const fileContent = await file.text();
        const data = importSession.parseSessionFile(fileContent, file.name);
        this.loadedFileName(file.name);
        // Handle successful load
        await this.onFileLoaded(data, file.name);
      } catch (error) {
        this.handleError(`Error parsing file: ${error.message}`, error);
      }
    };

    this.cleanJSON = fileContent => importSession.cleanJSON(fileContent);

    this.findClosingBrace = (content, startIndex) =>
      importSession.findClosingBrace(content, startIndex);

    // Drop handlers
    this.handleDrop = (_, e) => {
      e.preventDefault();
      this.isDragging(false);

      const file = e.dataTransfer.files[0];
      this.readFile(file);
    };

    this.handleDragOver = (_, e) => {
      e.preventDefault();
    };

    this.handleDragEnter = (_, e) => {
      e.preventDefault();
      this.isDragging(true);
    };

    this.handleDragLeave = (_, e) => {
      e.preventDefault();
      this.isDragging(false);
    };

    // File input handler
    this.handleFileSelect = (_, e) => {
      const file = e.target.files[0];
      this.readFile(file);
    };

    this.DeleteOriginalForAverage = ko.observable('all');

    this.useAllPassFiltersForSubs = ko.observable(false);

    this.DeleteOriginalForLfeRevert = ko.observable(true);

    this.isProcessing = ko.observable(false);

    // Application-wide processing lock — logic in services/rew-session.js.
    this.setProcessing = async newValue => this.rewSession.setProcessing(newValue);

    this.currentSelectedPosition = ko.observable();

    this.importMsoConfigInRew = async REWconfigs => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        await exportsService.importMsoConfig(
          REWconfigs,
          this.byPositionsGroupedSubsMeasurements(),
          (configs, subResponses) =>
            this.businessTools.importFilterInREW(configs, subResponses),
          {
            onPositionImported: position =>
              this.handleSuccess(`REW import successful for position: ${position}`),
          },
        );
      } catch (error) {
        this.handleError(`REW import failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonDownloadAvr = async () => {
      if (this.isProcessing()) return;
      try {
        const { filename, blob } = exportsService.buildAvrExport(
          this.jsonAvrData(),
          this.avrIpAddress(),
        );
        saveAs(blob, filename);
        this.handleSuccess('Download successful');
      } catch (error) {
        this.handleError(`.avr file failed: ${error.message}`, error);
      }
    };

    this.buttoncheckREWButton = async () => {
      if (this.isProcessing()) return;
      try {
        this.error('');
        await this.toggleBackgroundPolling();
      } catch (error) {
        this.handleError(`Pulling failed: ${error.message}`, error);
      }
    };

    this.renameMeasurement = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('Renaming started');
        await this.rewSession.renameMeasurements();
        this.handleSuccess('Renaming succeful');
      } catch (error) {
        this.handleError(`Rename failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonresetREWButton = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);

        lm.info('Reseting...');

        lm.info('Reseting default equalizer to Generic EQ');
        await this.rewEq.setDefaultEqualiser();

        lm.info('Clear current API commands');
        await this.apiService.clearCommands();

        lm.info('Reseting measurements to main target level');
        await this.setTargetLevelFromMeasurement(this.firstMeasurement());
        for (const item of this.measurements()) {
          await item.resetAll(this.mainTargetLevel());
        }

        this.handleSuccess('Reset successful');
      } catch (error) {
        this.handleError(`Reset failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonClearErrors = async () => {
      this.error('');
      this.status('');

      try {
        if (this.isPolling() && this.apiService) await this.apiService.clearCommands();
      } catch (error) {
        this.handleError(`Clear error failed: ${error.message}`, error);
      }
    };

    this.buttonResetApplication = async () => {
      if (this.isProcessing()) return;
      try {
        lm.info('Reseting...');

        if (this.isPolling()) {
          await this.apiService.setInhibitGraphUpdates(false);
          this.stopBackgroundPolling();
        }

        this.error('');

        this.resetApplicationState();

        this.handleSuccess(`Reset successful`);
      } catch (error) {
        this.handleError(`Reset failed: ${error.message}`, error);
      }
    };

    this.buttoncreatesAverages = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('Average calculation started...');

        await createAverages({
          validMeasurements: this.validMeasurements(),
          groupedMeasurements: this.groupedMeasurements(),
          averageMethod: this.selectedAverageMethod(),
          deleteOriginal: this.DeleteOriginalForAverage(),
          processGroupedResponses: (grouped, method, deleteOriginal) =>
            this.businessTools.processGroupedResponses(grouped, method, deleteOriginal),
        });

        const averagePosition = this.measurementsPositionList().find(
          pos => pos.text === 'Average',
        );
        this.currentSelectedPosition(averagePosition.value);
        this.handleSuccess('Average calculations completed successfully');
      } catch (error) {
        this.handleError(`Averages failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonrevertLfeFilter = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('Reverting LFE filter...');

        await this.businessTools.revertLfeFilterProccess(
          this.selectedLfeFrequency(),
          this.DeleteOriginalForLfeRevert(),
          true,
        );

        this.handleSuccess('LFE filter reverted successfully');
      } catch (error) {
        this.handleError(`Reverting LFE filter failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonAlignPeaks = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('Align peaks...');

        await this.alignmentService.alignPeaks(
          this.uniqueSpeakersMeasurements(),
          this.uniqueSubsMeasurements(),
        );

        this.handleSuccess('Align peaks successful');
      } catch (error) {
        this.handleError(`Time align failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonAlignSPL = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('Computing SPL alignment...');

        this.SubsFrequencyBands = await this.alignmentService.alignSPL({
          speakerMeasurements: this.uniqueSpeakersMeasurements(),
          uniqueMeasurements: this.uniqueMeasurements(),
          subMeasurements: this.uniqueSubsMeasurements(),
        });

        this.handleSuccess(`SPL alignment successful `);
      } catch (error) {
        this.handleError(`SPL alignment: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.increaseSubTrimGain = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);

        for (const sub of this.subsLikeMeasurements()) {
          await sub.addSPLOffsetDB(0.5);
        }
      } catch (error) {
        this.handleError(`Increasing sub trim gain failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.decreaseSubTrimGain = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        for (const sub of this.subsLikeMeasurements()) {
          await sub.addSPLOffsetDB(-0.5);
        }
      } catch (error) {
        this.handleError(`Decreasing sub trim gain failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonproduceSubSum = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('Computing sum...');

        // Ensure accurate predicted measurements with correct target level
        await this.setTargetLevelFromMeasurement(this.firstMeasurement());

        // Process each position's subwoofer measurements
        await this.subOptimizationService.produceSubSums(
          this.byPositionsGroupedSubsMeasurements(),
        );
      } catch (error) {
        this.handleError(`Sum failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonproduceAlignedButton = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('Searching for alignement...');

        const speakerItem = this.findMeasurementByUuid(this.selectedSpeaker());
        if (!speakerItem) {
          throw new Error(`Speaker not found`);
        }

        await this.subOptimizationService.produceAligned(speakerItem);

        // set lpf for lfe according to speaker crossover or 120Hz minimum
        this.lpfForLFE(Math.max(120, speakerItem.crossover()));
        lm.info(`Setting LFE low pass filter to ${this.lpfForLFE()} Hz`);
      } catch (error) {
        this.handleError(`Alignement search failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonAutoAdjustInversion = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('Auto adjusting inversion...');

        await this.alignmentService.autoAdjustInversion(
          this.uniqueSpeakersMeasurements(),
        );
      } catch (error) {
        this.handleError(`Auto adjust inversion failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.checkAlignment = async speakerItem => {
      // processing lock is a UI concern — the sequence lives in the service
      const allreadyProcessing = this.isProcessing();
      try {
        if (!allreadyProcessing) await this.setProcessing(true);
        await this.alignmentService.checkAlignment(speakerItem);
      } finally {
        if (!allreadyProcessing) await this.setProcessing(false);
      }
    };

    this.syncAllPredictedLfeMeasurement = async () =>
      this.subOptimizationService.syncAllPredictedLfeMeasurement();

    this.buttongenratesPreview = async () => {
      const completed = await this.filtersService.generatePreviews(
        this.uniqueSpeakersMeasurements(),
      );
      if (completed === false) return;

      this.handleSuccess(`Preview generated successfully`);
    };

    this.createSpeakerFilterForSelectedMode = item =>
      this.filtersService.createSpeakerFilterForSelectedMode(item);

    this.buttongeneratesSelectedFilters = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);

        const filterModeLabel = await this.filtersService.generateSelectedFilters(
          this.uniqueSpeakersMeasurements(),
        );

        this.handleSuccess(`${filterModeLabel} filters generated successfully`);
      } catch (error) {
        this.handleError(`Filter generation failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttongeneratesFilters = async () => {
      this.selectedEqualizationMode('rew');
      await this.buttongeneratesSelectedFilters();
    };

    this.buttongeneratesRchFilters = async () => {
      this.selectedEqualizationMode('rch');
      await this.buttongeneratesSelectedFilters();
    };

    this.buttonInvertAll = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        await this.filtersService.invertAll(this.uniqueSpeakersMeasurements());

        // toggle inversion icon of element in UI invert-icon
        const invertIcon = document.getElementById('invert-icon');
        if (invertIcon) {
          invertIcon.classList.toggle('fa-arrow-up');
          invertIcon.classList.toggle('fa-arrow-down');
        }

        this.handleSuccess(`Preview generated successfully`);
      } catch (error) {
        this.handleError(`Inversion failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.softRoll = ko.observable(false);
    this.enableDynamicEq = ko.observable(false);
    this.dynamicEqRefLevel = ko.observable(0);
    this.enableDynamicVolume = ko.observable(false);
    this.dynamicVolumeSetting = ko.observable(0);
    this.enableLowFrequencyContainment = ko.observable(false);
    this.lowFrequencyContainmentLevel = ko.observable(3);
    this.subwooferOutput = ko.observable('LFE');
    this.lpfForLFE = ko.observable(120);

    // Available filter options
    this.subwooferOutputChoice = [
      { value: 'LFE', text: 'LFE' },
      { value: 'L+M', text: 'LFE + Main' },
    ];

    this.buttoncreateOCAButton = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('OCA file generation...');

        const avrData = this.jsonAvrData();
        if (!avrData?.targetModelName) {
          throw new Error(`Please load avr file first`);
        }
        await this.setTargetLevelFromMeasurement();

        const { filename, blob } = await exportsService.generateOcaExport({
          avrData,
          measurements: this.uniqueMeasurements(),
          config: {
            targetCurve: this.targetCurve(),
            fileFormat: this.ocaFileFormat(),
            tcName: ko.unwrap(this.tcName),
            softRoll: this.softRoll(),
            enableDynamicEq: this.enableDynamicEq(),
            dynamicEqRefLevel: this.dynamicEqRefLevel(),
            enableDynamicVolume: this.enableDynamicVolume(),
            dynamicVolumeSetting: this.dynamicVolumeSetting(),
            enableLowFrequencyContainment: this.enableLowFrequencyContainment(),
            lowFrequencyContainmentLevel: this.lowFrequencyContainmentLevel(),
            subwooferOutput: this.subwooferOutput(),
            lpfForLFE: this.lpfForLFE(),
            numberOfSubwoofers: this.uniqueSubsMeasurements().length,
            currentVersion: this.currentVersion,
          },
        });

        // Save file
        saveAs(blob, filename);

        this.handleSuccess('OCA file created successfully');
      } catch (error) {
        this.handleError(`OCA file failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttoncreateSetting = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('text generation...');

        const avrData = this.jsonAvrData();
        if (!avrData?.targetModelName) {
          throw new Error(`Please load avr file first`);
        }
        await this.setTargetLevelFromMeasurement();

        const selectedSpeaker = this.findMeasurementByUuid(this.selectedSpeaker());
        // find if we have revert LFE frequency
        const subWithFreq = this.uniqueSubsMeasurements().find(
          item => item.revertLfeFrequency !== 0,
        );

        const { filename, blob } = exportsService.generateSettingsReport({
          avrData,
          reducedMeasurements: this.uniqueMeasurements().map(item => item.toJSON()),
          settings: {
            loadedFileName: this.loadedFileName(),
            targetCurve: this.targetCurve(),
            mainTargetLevel: this.mainTargetLevel(),
            selectedAverageMethod: this.selectedAverageMethod(),
            selectedSmoothingMethod: this.selectedSmoothingMethod(),
            selectedIrWindows: this.selectedIrWindows(),
            selectedRoomCurve: this.selectedRoomCurve(),
            individualMaxBoostValue: this.individualMaxBoostValue(),
            overallBoostValue: this.overallBoostValue(),
            selectedEqualizationMode: this.selectedEqualizationMode(),
            numberOfSubwoofers: this.uniqueSubsMeasurements().length,
            revertLfeFrequency: subWithFreq?.revertLfeFrequency,
            maxBoostIndividualValue: this.maxBoostIndividualValue(),
            maxBoostOverallValue: this.maxBoostOverallValue(),
            selectedSpeakerCrossover: selectedSpeaker?.crossover(),
            selectedSpeakerText: selectedSpeaker?.displayMeasurementTitle() || 'None',
            lpfForLFE: this.lpfForLFE(),
            subwooferOutput: this.subwooferOutput(),
            enableDynamicEq: this.enableDynamicEq(),
            dynamicEqRefLevel: this.dynamicEqRefLevel(),
            enableDynamicVolume: this.enableDynamicVolume(),
            dynamicVolumeSetting: this.dynamicVolumeSetting(),
            enableLowFrequencyContainment: this.enableLowFrequencyContainment(),
            lowFrequencyContainmentLevel: this.lowFrequencyContainmentLevel(),
            rewVersion: this.rewVersion(),
            currentVersion: this.currentVersion,
          },
        });

        // Save file
        saveAs(blob, filename);

        this.handleSuccess('Settings file created successfully');
      } catch (error) {
        this.handleError(`Settings file failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.processMsoMeasurement = async (measurement, jszip, minFreq, maxFreq) =>
      exportsService.appendMsoMeasurement(jszip, measurement, {
        minFreq,
        maxFreq,
        targetLevel: this.mainTargetLevel(),
      });

    this.buttonCreatesMsoExports = async () => {
      if (this.isProcessing()) return;
      try {
        if (!this.isPolling()) {
          throw new Error('Please start connetion first');
        }

        await this.setProcessing(true);
        lm.info('Exports Subs...');

        const { filename, blob } = await exportsService.buildMsoExportZip(
          this.subsMeasurements(),
          {
            model: this.jsonAvrData().model,
            targetLevel: this.mainTargetLevel(),
          },
        );

        saveAs(blob, filename);
        this.handleSuccess('Exports Subs successful');
      } catch (error) {
        this.handleError(`Exports Subs failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonEqualizeSub = async () => {
      if (this.isProcessing()) return;
      try {
        if (this.uniqueSubsMeasurements().length === 0) {
          throw new Error('No subwoofers found');
        }
        await this.setProcessing(true);
        await this.subOptimizationService.equalizeSubs();

        this.handleSuccess('Equalize Subs successful');
      } catch (error) {
        this.handleError(`Equalize Subs failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonMutipleSubOptimizer = async () =>
      this.subOptimizationService.multipleSubOptimizer();

    this.applyFiltersToSubs = async sourceSub =>
      this.subOptimizationService.applyFiltersToSubs(sourceSub);

    this.equalizeSubProcess = async subMeasurement =>
      this.subOptimizationService.equalizeSubProcess(subMeasurement);

    this.copySubFiltersToOtherPositions = async () =>
      this.subOptimizationService.copySubFiltersToOtherPositions();

    this.buttonSingleSubOptimizer = async () =>
      this.subOptimizationService.singleSubOptimizer();

    this.createOptimizerConfig = (lowFrequency, highFrequency) =>
      this.subOptimizationService.createOptimizerConfig(lowFrequency, highFrequency);

    this.applySubPolarity = async (subMeasurement, polarity) =>
      this.subOptimizationService.applySubPolarity(subMeasurement, polarity);

    this.applySubAllPassFilter = async (subMeasurement, allPassParam) =>
      this.subOptimizationService.applySubAllPassFilter(subMeasurement, allPassParam);

    this.applyOptimizedSubSettings = async sub =>
      this.subOptimizationService.applyOptimizedSubSettings(sub);

    this.buttonMultiSubOptimizer = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('MultiSubOptimizer...');

        await this.subOptimizationService.multiSubOptimizer(this.SubsFrequencyBands);

        this.handleSuccess(`MultiSubOptimizer successfull`);
      } catch (error) {
        this.handleError(`MultiSubOptimizer failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    // TODO implement interface action to copy parameters to all positions
    this.copyParametersToAllPosition = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('Copy started');
        await this.copyMeasurementCommonAttributes();
        this.handleSuccess('Copy succeful');
      } catch (error) {
        this.handleError(`Copy failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    // Computed for filtered measurements
    this.subsMeasurements = ko.pureComputed(() =>
      this.measurements().filter(item => item.isSub()),
    );

    this.subsLikeMeasurements = ko.pureComputed(() =>
      this.measurements().filter(item => item.isSub() || item.isSubOperationResult),
    );

    this.validMeasurements = ko.pureComputed(() =>
      this.measurements().filter(item => item.isValid),
    );

    this.groupedMeasurements = ko.pureComputed(() => groupByChannel(this.measurements()));
    // creates a map from groupedMeasurements with items grouped by the same position attribute
    this.byPositionsGroupedSubsMeasurements = ko.pureComputed(() =>
      groupByPosition(this.subsMeasurements()),
    );

    this.measurementsPositionList = ko.computed(() => {
      try {
        return positionChoices(this.measurements());
      } catch (error) {
        this.handleError('Error computing measurements position list:', error);
        return [];
      }
    });

    // Filtered measurements
    this.uniqueMeasurements = ko.pureComputed(
      () => this.measurements().filter(item => item.isSelected()),
      this,
    );

    // Filtered measurements
    this.notUniqueMeasurements = ko.pureComputed(
      () => this.measurements().filter(item => !item.isSelected()),
      this,
    );

    // Filtered measurements
    this.uniqueMeasurementsView = ko.pureComputed(() => {
      if (this.selectedMeasurementsFilter()) {
        return this.uniqueMeasurements();
      }
      return this.measurements();
    });

    this.mainTargetLevel = ko.observable(MeasurementItem.DEFAULT_TARGET_LEVEL);

    this.tcName = ko.pureComputed(() => {
      const targetCurve = this.targetCurve() === 'None' ? '' : this.targetCurve();
      const roomCurve =
        this.selectedRoomCurve() === 'none' ? '' : this.selectedRoomCurve();
      const curveName = [targetCurve, roomCurve].filter(Boolean).join(' - ') || 'flat';
      return `${curveName} ${this.mainTargetLevel()}dB`;
    });

    this.firstMeasurement = ko.pureComputed(() => {
      const measurements = this.uniqueSpeakersMeasurements();
      return measurements.length > 0 ? measurements[0] : null;
    });

    this.minDistanceInMeters = ko.pureComputed(() => {
      const distances = this.uniqueMeasurements().map(item => item.distanceInMeters());
      return distances.length ? Math.min(...distances) : 0;
    });

    this.maxDistanceInMeters = ko.pureComputed(() => {
      const distances = this.uniqueMeasurements().map(item => item.distanceInMeters());
      return distances.length ? Math.max(...distances) : 0;
    });

    this.maxDistanceInMetersWarning = ko.pureComputed(() =>
      MeasurementItem.cleanFloat32Value(
        this.minDistanceInMeters() + MeasurementItem.MODEL_DISTANCE_LIMIT,
        2,
      ),
    );

    this.maxDistanceInMetersError = ko.pureComputed(() =>
      MeasurementItem.cleanFloat32Value(
        this.minDistanceInMeters() + MeasurementItem.MODEL_DISTANCE_CRITICAL_LIMIT,
        2,
      ),
    );

    this.distanceLeftBeforeError = ko.pureComputed(() => {
      const distanceLeft = this.maxDistanceInMetersError() - this.maxDistanceInMeters();
      return distanceLeft > 0 ? MeasurementItem.cleanFloat32Value(distanceLeft, 2) : 0;
    });

    this.shiftInMeters = ko.pureComputed(() => {
      const distances = this.uniqueMeasurements().map(item =>
        item._computeInMeters(item.absoluteIRPeakSeconds()),
      );
      if (Math.min(...distances) < 1) {
        return MeasurementViewModel.DEFAULT_SHIFT_IN_METERS;
      }
      return 0;
    });

    this.uniqueSubsMeasurements = ko.pureComputed(() => {
      return this.uniqueMeasurements().filter(item => item.isSub());
    });

    this.predictedLfeMeasurementTitle = ko.pureComputed(() => {
      const position = this.currentSelectedPosition();
      if (position === undefined || position === null) return undefined;

      return `${MeasurementItem.DEFAULT_LFE_PREDICTED}${position}`;
    });

    this.allPredictedLfeMeasurement = ko.pureComputed(() =>
      filterPredictedLfe(this.measurements()),
    );

    this.predictedLfeMeasurement = ko.pureComputed(() =>
      findPredictedLfeForPosition(this.measurements(), this.currentSelectedPosition()),
    );

    this.uniqueSpeakersMeasurements = ko.pureComputed(() => {
      return this.uniqueMeasurements().filter(item => !item.isSub());
    });

    this.minSpeakersDistanceInMeters = ko.pureComputed(() => {
      const distances = this.uniqueSpeakersMeasurements().map(item =>
        item.distanceInMeters(),
      );
      return distances.length ? Math.min(...distances) : 0;
    });

    this.maxSubDistanceInMeters = ko.pureComputed(() => {
      const distances = this.uniqueSubsMeasurements().map(sub => sub.distanceInMeters());
      return distances.length ? Math.max(...distances) : 0;
    });

    this.minSubDistanceInMeters = ko.pureComputed(() => {
      const distances = this.uniqueSubsMeasurements().map(sub => sub.distanceInMeters());
      return distances.length ? Math.min(...distances) : 0;
    });

    this.subDistanceLeftBeforeError = ko.pureComputed(() => {
      const shift = Math.max(
        0,
        this.minSpeakersDistanceInMeters() - this.minSubDistanceInMeters(),
      );

      return this.maxDistanceInMetersError() - this.maxSubDistanceInMeters() + shift;
    });

    // REW session service — owns polling, list sync and the
    // processing lock; the viewmodel keeps mirror fields for its consumers.
    this.rewSession = createRewSession({
      state: observableProxy(this, [
        'isPolling',
        'isProcessing',
        'isLoading',
        'hasError',
        'rewVersion',
        'maxMeasurements',
        'inhibitGraphUpdates',
        'apiBaseUrl',
      ]),
      measurements: {
        get: () => this.measurements(),
        set: list => this.measurements(list),
        push: item => this.measurements.push(item),
        removeWhere: predicate => this.measurements.remove(predicate),
      },
      createMeasurement: apiItem => new MeasurementItem(apiItem, this),
      adoptMeasurement: item =>
        item instanceof MeasurementItem ? item : new MeasurementItem(item, this),
      createApi: baseUrl => new RewApi(baseUrl, false, this.blocking),
      onConnected: () => this.setTargetLevelFromMeasurement(),
      onProcessingEnded: () => this.saveMeasurements(),
      onApiServicesChanged: () => {
        this.apiService = this.rewSession.apiService;
        this.rewEq = this.rewSession.rewEq;
        this.rewMeasurements = this.rewSession.rewMeasurements;
        this.rewImport = this.rewSession.rewImport;
        this.rewAlignmentTool = this.rewSession.rewAlignmentTool;
      },
      onError: (message, error) => this.handleError(message, error),
      pollingInterval: this.pollingInterval,
      log: lm,
    });

    // Target curve / alignment services.
    this.targetCurveService = createTargetCurveService({
      session: this.rewSession,
      state: observableProxy(this, [
        'tcName',
        'targetCurve',
        'mainTargetLevel',
      ]),
      lists: {
        firstMeasurement: () => this.firstMeasurement(),
        validMeasurements: () => this.validMeasurements(),
        predictedLfeMeasurements: () => this.allPredictedLfeMeasurement(),
      },
      isMeasurement: value => value instanceof MeasurementItem,
      log: lm,
    });

    this.alignmentService = createAlignmentService({
      session: this.rewSession,
      applyCutOffFilter: (lfe, speaker, frequency) =>
        this.businessTools.applyCutOffFilter(lfe, speaker, frequency),
      setTargetLevelFromMeasurement: measurement =>
        this.setTargetLevelFromMeasurement(measurement),
      getPredictedLfeMeasurements: () => this.allPredictedLfeMeasurement(),
      log: lm,
    });

    // Subwoofer optimization / filter generation services.
    this.subOptimizationService = createSubOptimizationService({
      session: this.rewSession,
      businessTools: {
        produceAligned: (speakerItem, subs) =>
          this.businessTools.produceAligned(speakerItem, subs),
        createsSum: (subsList, title, deleteOriginals) =>
          this.businessTools.createsSum(subsList, title, deleteOriginals),
      },
      config: observableProxy(this, [
        'mainTargetLevel',
        'selectedEqualizationMode',
        'lowerFrequencyBoundSub',
        'upperFrequencyBoundSub',
        'maxBoostIndividualValue',
        'maxBoostOverallValue',
        'useAllPassFiltersForSubs',
        'distanceLeftBeforeError',
        'jsonAvrData',
      ]),
      lists: {
        uniqueSubsMeasurements: () => this.uniqueSubsMeasurements(),
        predictedLfeMeasurements: () => this.allPredictedLfeMeasurement(),
        selectedPredictedLfeMeasurement: () => this.predictedLfeMeasurement(),
      },
      log: lm,
    });

    this.filtersService = createFiltersService({
      config: observableProxy(this, ['selectedEqualizationMode']),
      log: lm,
    });

    // Persistence service — the persisted keys match the observable
    // names, so the settings adapter resolves them generically.
    this.persistenceService = createPersistenceService({
      store,
      settings: {
        get: name => ko.unwrap(this[name]),
        set: (name, value) => {
          if (ko.isObservable(this[name])) {
            this[name](value);
          } else {
            this[name] = value;
          }
        },
      },
      measurements: {
        get: () => this.measurements(),
        set: list => this.measurements(list),
      },
      createMeasurement: item => new MeasurementItem(item, this),
      crossovers: {
        toJSON: () =>
          Object.fromEntries(
            Object.entries(this._crossoverMap).map(([key, obs]) => [
              key,
              { crossover: obs() },
            ]),
          ),
        restore: groups => {
          for (const [key, value] of Object.entries(groups)) {
            this._crossoverMap[key] = ko.observable(value.crossover);
          }
        },
      },
      autoEq: {
        toJSON: () => ko.toJS(this.autoEqConfig),
        apply: config => {
          for (const [key, val] of Object.entries(config)) {
            this.autoEqConfig[key]?.(val);
          }
        },
      },
      applyPolling: shouldPoll =>
        shouldPoll ? this.startBackgroundPolling() : this.stopBackgroundPolling(),
    });
  }

  getIrWindowConfig(presetName = this.selectedIrWindows()) {
    const preset =
      IR_WINDOW_PRESETS[presetName] ?? IR_WINDOW_PRESETS[FALLBACK_IR_WINDOW_CHOICE];

    return {
      ...preset,
      ...(preset.mtwTimesms ? { mtwTimesms: [...preset.mtwTimesms] } : {}),
    };
  }

  getRoomCurveConfig(presetName = this.selectedRoomCurve()) {
    return RoomCurvesSettings.getCurveConfig(presetName);
  }

  updateObservableFromEvent = (observable, event) => {
    const newValue = event?.target?.value;
    if (newValue && newValue !== observable()) {
      observable(newValue);
    }
  };

  applyToSelectedMeasurements = async ({
    successLabel,
    errorLabel,
    filter = () => true,
    apply,
    includePredictedLfeMeasurement = false,
  }) => {
    if (!this.isPolling()) return;

    if (this.isProcessing()) {
      lm.warn(`Unable to apply ${successLabel.toLowerCase()} while processing`);
      return;
    }

    // selection logic in services/filters.js
    const selectedMeasurements = selectMeasurementsForBulkApply({
      validMeasurements: this.validMeasurements(),
      predicted: includePredictedLfeMeasurement && this.predictedLfeMeasurement(),
      filter,
      includePredicted: includePredictedLfeMeasurement,
    });

    if (!selectedMeasurements.length) return;

    try {
      await this.setProcessing(true);

      for (const measurement of selectedMeasurements) {
        await apply(measurement);
      }

      this.handleSuccess(
        `${successLabel} applied to ${selectedMeasurements.length} selected measurement${
          selectedMeasurements.length > 1 ? 's' : ''
        }`,
      );
    } catch (error) {
      this.handleError(`${errorLabel} failed: ${error.message}`, error);
    } finally {
      await this.setProcessing(false);
    }
  };

  onIrWindowsChanged = async (_, event) => {
    this.updateObservableFromEvent(this.selectedIrWindows, event);

    await this.applyToSelectedMeasurements({
      successLabel: 'IR windows',
      errorLabel: 'IR window update',
      filter: item => !item.isFilter && item.haveImpulseResponse,
      apply: measurement => measurement.setIrWindows(this.selectedIrWindowsConfig()),
      includePredictedLfeMeasurement: true,
    });
  };

  onSmoothingChanged = async (_, event) => {
    this.updateObservableFromEvent(this.selectedSmoothingMethod, event);

    await this.applyToSelectedMeasurements({
      successLabel: 'Smoothing',
      errorLabel: 'Smoothing update',
      filter: item => !item.isFilter,
      apply: measurement =>
        this.selectedSmoothingMethod() === 'None'
          ? measurement.resetSmoothing()
          : measurement.setSmoothing(this.selectedSmoothingMethod()),
      includePredictedLfeMeasurement: true,
    });
  };

  onRoomCurveChanged = async (_, event) => {
    this.updateObservableFromEvent(this.selectedRoomCurve, event);
    const selectedRoomCurve = this.selectedRoomCurve();

    await this.applyToSelectedMeasurements({
      successLabel: 'Room curve',
      errorLabel: 'Room curve update',
      filter: item => !item.isFilter,
      apply: measurement =>
        measurement.setRoomCurveSettings(this.getRoomCurveConfig(selectedRoomCurve)),
      includePredictedLfeMeasurement: true,
    });

    if (this.rewEq) {
      try {
        // also update default room curve for future measurements
        await this.rewEq.setDefaultRoomCurveSettings(
          this.getRoomCurveConfig(selectedRoomCurve),
        );
      } catch (error) {
        this.handleError(`Room curve update failed: ${error.message}`, error);
      }
    }
  };

  // Méthodes de confirmation pour les actions sensibles

  confirmResetApplication = () => {
    this.confirmManager.show({
      ...confirmMessages.resetApplication,
      onConfirm: () => this.buttonResetApplication(),
    });
  };

  confirmResetMeasurements = () => {
    this.confirmManager.show({
      ...confirmMessages.resetMeasurements,
      onConfirm: () => this.buttonresetREWButton(),
    });
  };

  // Callbacks pour le dialogue
  cancelConfirmDialog = () => {
    this.confirmManager.cancel();
  };

  executeConfirmDialog = () => {
    this.confirmManager.execute();
  };

  resetApplicationState() {
    return this.persistenceService.resetApplicationState();
  }

  async updateTargetCurve(referenceMeasurement) {
    return this.targetCurveService.updateTargetCurve(referenceMeasurement);
  }

  async equalizeSub(subMeasurement) {
    return this.subOptimizationService.equalizeSub(subMeasurement);
  }

  async setSameDelayToAll(measurements) {
    return setSameDelayToAll(measurements);
  }

  async adjustSubwooferSPLLevels(subsMeasurements, targetLevelFreq = 40) {
    return this.alignmentService.adjustSubwooferSPLLevels(
      subsMeasurements,
      targetLevelFreq,
    );
  }

  async analyzeSubwooferSPLAlignment(measurement, options) {
    return options
      ? this.alignmentService.analyzeSubwooferSPLAlignment(measurement, options)
      : this.alignmentService.analyzeSubwooferSPLAlignment(measurement);
  }

  async getTargetLevelAtFreq(measurement, targetFreq = 40) {
    return getTargetLevelAtFreq(measurement || this.uniqueMeasurements()[0], targetFreq);
  }

  /**
   * Synchronises the target level across all measurements from a reference measurement.
   *
   * 1. Resolves the reference measurement (falls back to the first speaker measurement
   *    if none is provided or if the argument is not a MeasurementItem).
   * 2. Reads the target level from that measurement (or from the REW default if no
   *    measurement is available).
   * 3. Checks the active target curve in REW.
   * 4. If neither the target curve nor the target level changed, only ensures the
   *    target curve measurement exists in REW and returns early.
   * 5. Otherwise, updates `mainTargetLevel`, sets the same target level on every valid
   *    measurement (which also resets their filters), updates the REW default target
   *    level, removes stale LFE-predicted measurements, and regenerates the target
   *    curve measurement.
   *
   * The method acquires the "processing" lock if it is not already held, and always
   * releases it in the `finally` block.
   *
   * @param {MeasurementItem} [measurement] - Optional reference measurement. When
   *   omitted or invalid, the first unique speaker measurement is used as fallback.
   * @returns {Promise<number|undefined>} The new target level in dB, or `undefined`
   *   when no update was needed.
   */
  // Target level sync — logic in services/target-curve.js; the
  // processing lock stays here.
  setTargetLevelFromMeasurement = async measurement => {
    const initialProcessing = this.isProcessing();
    try {
      if (!initialProcessing) await this.setProcessing(true);
      return await this.targetCurveService.setTargetLevelFromMeasurement(measurement);
    } finally {
      if (!initialProcessing) await this.setProcessing(false);
    }
  };

  getMaxFromArray(array) {
    return getMaxFromArray(array);
  }

  async createsSumFromFR(measurementList) {
    const { filename, blob } =
      await this.subOptimizationService.createsSumFromFR(measurementList);
    // Save file using FileSaver
    await saveAs(blob, filename);
  }

  async sendToREW(optimizedSubsSum, maximisedSumTitle) {
    return this.subOptimizationService.sendToREW(optimizedSubsSum, maximisedSumTitle);
  }

  async copyMeasurementCommonAttributes() {
    return this.filtersService.copyMeasurementCommonAttributes(this.uniqueMeasurements());
  }

  updateTranslations(language) {
    this.translations(translations[language]);
    // Update any observable text that needs translation
    // Force Knockout to re-evaluate bindings
    ko.tasks.runEarly();
  }

  async produceSumProcess(subsList) {
    return this.subOptimizationService.produceSumProcess(subsList);
  }

  // REW session sync — logic in services/rew-session.js; thin
  // delegates keep the public API stable for BusinessTools and the items.
  async loadData() {
    return this.rewSession.loadData();
  }

  mergeMeasurements(data) {
    return this.rewSession.mergeMeasurements(data);
  }

  async addMeasurementFromRewOperation(operation, options = {}) {
    return this.rewSession.addMeasurementFromRewOperation(operation, options);
  }

  selectCreatedMeasurement(apiItems, expectedTitle) {
    return this.rewSession.selectCreatedMeasurement(apiItems, expectedTitle);
  }

  // Helper function to handle observable properties
  updateObservableObject(target, source) {
    for (const key of Object.keys(source)) {
      if (ko.isObservable(target[key])) {
        // If the property is an observable, update its value
        target[key](source[key]);
      } else if (typeof source[key] === 'object' && source[key] !== null && target[key]) {
        // Handle nested objects
        this.updateObservableObject(target[key], source[key]);
      } else {
        // For non-observable properties, directly assign
        target[key] = source[key];
      }
    }
    return target;
  }

  findMeasurementByUuid(uuid) {
    return this.rewSession.findMeasurementByUuid(uuid);
  }

  async addMeasurementApi(itemUuid) {
    return this.rewSession.addMeasurementApi(itemUuid);
  }

  async addMeasurement(item) {
    return this.rewSession.addMeasurement(item);
  }

  async removeMeasurements(items) {
    return this.rewSession.removeMeasurements(items);
  }

  async removeMeasurement(item) {
    return this.rewSession.removeMeasurement(item);
  }

  async removeMeasurementUuid(itemUuid) {
    return this.rewSession.removeMeasurementUuid(itemUuid);
  }

  async findAligment(
    channelA,
    channelB,
    frequency,
    maxSearchRange = 3,
    createSum = false,
    sumTitle = null,
    minSearchRange = -0.5,
  ) {
    return this.alignmentService.findAligment(
      channelA,
      channelB,
      frequency,
      maxSearchRange,
      createSum,
      sumTitle,
      minSearchRange,
    );
  }

  async analyseApiResponse(commandResult) {
    return this.rewSession.analyseApiResponse(commandResult);
  }

  //TODO: remove old findAligment when sure new one works fine
  async findAligmentNew(
    channelA,
    channelB,
    frequency,
    maxSearchRange = 2,
    createSum = false,
    sumTitle = null,
    minSearchRange = -0.5,
  ) {
    if (createSum && !sumTitle) {
      throw new Error('sumTitle is required when createSum is true');
    }
    if (!this.jsonAvrData()?.avr) {
      throw new Error('Please load AVR data first');
    }

    try {
      // Use a standard octave range (1 octave = factor of 2)
      const octaveRange = 1; // Number of octaves to span in each direction
      // one octave below frequency
      const lowFrequency = Math.max(frequency / Math.pow(2, octaveRange), 20);

      // one octave above frequency
      const highFrequency = Math.min(frequency * Math.pow(2, octaveRange), 500);

      const optimizerConfig = {
        frequency: {
          min: lowFrequency, // Hz
          max: highFrequency, // Hz
        },
        gain: {
          min: 0, // dB
          max: 0, // dB
          step: 0.1, // dB
        },
        delay: {
          min: -maxSearchRange / 1000,
          max: -minSearchRange / 1000,
          step: this.jsonAvrData().avr.minDistAccuracy || 0.00001, // 0.01ms
        },
        allPass: {
          enabled: false,
          frequency: {
            min: 10, // Hz
            max: 500, // Hz
            step: 10, // Hz
          },
          q: {
            min: 0.1,
            max: 0.5,
            step: 0.1,
          },
        },
      };

      const channelAFrequencyResponse = await channelA.getFrequencyResponse();
      channelAFrequencyResponse.measurement = channelA.uuid;
      channelAFrequencyResponse.name = channelA.displayMeasurementTitle();
      const channelBFrequencyResponse = await channelB.getFrequencyResponse();
      channelBFrequencyResponse.measurement = channelB.uuid;
      channelBFrequencyResponse.name = channelB.displayMeasurementTitle();

      const frequencyResponses = [channelAFrequencyResponse, channelBFrequencyResponse];

      const optimizer = new MultiSubOptimizer(frequencyResponses, optimizerConfig, lm);
      const optimizerResults = optimizer.optimizeSubwoofers();

      const optimizedResults = optimizerResults.optimizedSubs[0].param;
      if (!optimizedResults) {
        throw new Error('No results found');
      }

      const isBInverted = optimizedResults.polarity === -1;
      const shiftDelay = -optimizedResults.delay;

      if (createSum) {
        const bestSumFullRange = optimizer.getFinalSubSum();
        await this.sendToREW(bestSumFullRange, sumTitle + 'N');
      }

      return { shiftDelay, isBInverted };
    } catch (error) {
      throw new Error(`Alignment tool failed: ${error.message}`, { cause: error });
    }
  }

  // Persistence — logic in services/persistence.js.
  restore() {
    return this.persistenceService.restore();
  }

  saveMeasurements() {
    return this.persistenceService.saveMeasurements();
  }

  async startBackgroundPolling() {
    return this.rewSession.startBackgroundPolling();
  }

  stopBackgroundPolling() {
    return this.rewSession.stopBackgroundPolling();
  }

  async toggleBackgroundPolling() {
    return this.rewSession.toggleBackgroundPolling();
  }

  resetAutoEqConfig() {
    this.autoEqConfig.numFilters(20);
    this.autoEqConfig.maxCutDb(25);
    this.autoEqConfig.flatnessTarget(0.3);
    this.autoEqConfig.numOptimizationPasses(20);
    this.autoEqConfig.gainSignLockThreshold(0.5);
    this.autoEqConfig.notchExclusionThreshold(6);
    this.autoEqConfig.minFilterGain(0.4);
    this.autoEqConfig.enableBeatRewOptimization(false);
    this.autoEqConfig.enableCandidatePlacement(true);
    this.autoEqConfig.enableReduceRepair(true);
    this.autoEqConfig.enableCriticalBandRefinement(true);
    this.autoEqConfig.enableRefinement(false);
    this.autoEqConfig.refinementIterations(100);
    this.autoEqConfig.varyQAbove200Hz(false);
    this.autoEqConfig.allowNarrowFiltersBelow200Hz(true);
    this.autoEqConfig.allowBoosts(true);
  }
}

export default MeasurementViewModel;
