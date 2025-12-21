import RewApi from './rew/rew-api.js';
import MeasurementItem from './MeasurementItem.js';
import PersistentStore from './PersistentStore.js';
import BusinessTools from './BusinessTools.js';
import OCAFileGenerator from './oca-file.js';
import translations from './translations.js';
import AdyTools from './ady-tools.js';
import MqxTools from './mqx-tools.js';
import MultiSubOptimizer from './multi-sub-optimizer.js';
import AvrCaracteristics from './avr-caracteristics.js';
import ko from 'knockout';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import ampAssignType from './amp-type.js';
import { CHANNEL_TYPES } from './audyssey.js';
import lm from './logs.js';
import { Room3DViewer } from './room-3d-viewer.js';

import { ConfirmDialogManager, confirmMessages } from './js/confirmDialog.js';

const store = new PersistentStore('myAppData');

class MeasurementViewModel {
  static DEFAULT_SHIFT_IN_METERS = 3;
  static MAXIMISED_SUM_TITLE = 'LFE Max Sum';
  static MAX_FILE_SIZE_BYTES = 104857600; // 100 MB
  static VALID_FILE_EXTENSIONS = ['.avr', '.ady', '.mqx'];

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
    this.isPolling = ko.observable(false);
    this.pollerId = null;
    // Add translation support
    this.translations = ko.observable(
      translations[localStorage.getItem('userLanguage') || 'en']
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

    this.lm = lm;

    // Observables
    this.measurements = ko.observableArray([]);
    this.isLoading = ko.observable(false);
    this.error = ko.observable('');
    this.status = ko.observable('');
    this.selectedItem = ko.observable(null);
    this.upperFrequencyBound = ko.observable(16000);
    this.lowerFrequencyBound = ko.observable(15);

    // Computed
    this.hasStatus = ko.computed(() => !this.error() && this.status() !== '');
    this.hasError = ko.computed(() => this.error() !== '');
    this.hasItems = ko.computed(() => this.measurements().length > 0);

    this.handleError = (message, error) => {
      lm.error(message);
      this.error(message);
      this.status('');
      if (error) throw error;
      if (message) throw new Error(message);
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

    this.irWindowsChoices = [
      {
        value: 'None',
        text: 'None',
        config: {
          leftWindowType: 'Rectangular',
          rightWindowType: 'Rectangular',
          addFDW: false,
          addMTW: false,
        },
      },
      {
        value: 'Optimized MTW',
        text: 'Optimized MTW',
        config: {
          leftWindowType: 'Rectangular',
          rightWindowType: 'Rectangular',
          addFDW: false,
          addMTW: true,
          mtwTimesms: [9000, 3000, 450, 120, 30, 7.7, 2.6, 0.9, 0.4, 0.15],
        },
      },
    ];

    this.selectedIrWindows = ko.observable('Optimized MTW');

    // get seletced IR window config
    this.selectedIrWindowsConfig = ko.computed(() => {
      const selected = this.selectedIrWindows();
      const found = this.irWindowsChoices.find(choice => choice.value === selected);
      return found ? found.config : null;
    });

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
      }
    });

    this.hasChannel = channelId => {
      if (!this.jsonAvrData()?.detectedChannels) {
        return false;
      }
      return this.jsonAvrData().detectedChannels.some(
        channel => channel.commandId === channelId
      );
    };

    // Array of frequency options with fallback values
    this.alingFrequencies = ko.computed(() => {
      const indexes = this.jsonAvrData()?.avr?.frequencyIndexes;
      return indexes || AvrCaracteristics.DEFAULT_FREQUENCIES;
    });

    this.LfeFrequencies = ko.computed(() => {
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

    this.measurementsByGroup = ko.computed(() => {
      if (!this.jsonAvrData()?.detectedChannels) return {};

      const groupMap = {};
      for (const item of this.jsonAvrData().detectedChannels) {
        const group = CHANNEL_TYPES.getGroupByChannelIndex(item.enChannelType);
        if (group === null) {
          throw new Error(
            `Unknown channel type: ${item.commandId} (id:${item.enChannelType})`
          );
        }
        if (!groupMap[group]) {
          const isSub = group === 'Subwoofer';
          const crossover = ko.observable(
            isSub ? 0 : MeasurementItem.DEFAULT_CROSSOVER_VALUE
          );
          groupMap[group] = {
            crossover,
            isSub,
            speakerType: ko.computed(() => {
              if (isSub) return 'E';
              return crossover() === 0 ? 'L' : 'S';
            }),
          };
        }
      }
      return groupMap;
    });

    this.validateFile = file => {
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      if (!MeasurementViewModel.VALID_FILE_EXTENSIONS.includes(ext)) {
        throw new Error('Please select a .avr, .ady, or .mqx file');
      }
      if (file.size > MeasurementViewModel.MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `File size exceeds ${
            MeasurementViewModel.MAX_FILE_SIZE_BYTES / 1024 / 1024
          } MB limit`
        );
      }
    };

    this.processMqxFile = async data => {
      if (!this.jsonAvrData()) {
        throw new Error('Please load AVR data first');
      }
      const mqxTools = new MqxTools(data, this.jsonAvrData());
      await mqxTools.parse();
      return mqxTools.jsonAvrData;
    };

    // TODO check if this is needed
    this.normalizeChannelMapping = data => {
      const StandardChannelMapping = {
        59: 54,
        60: 55,
        62: 56,
        63: 57,
        58: 54,
        61: 55,
        64: 56,
        47: 54,
        49: 55,
      };

      // TODO: ampassign can be directionnal must be converted to standard
      // convert directionnal bass to standard
      data.detectedChannels = data.detectedChannels.map(channel => ({
        ...channel,
        enChannelType:
          StandardChannelMapping[channel.enChannelType] || channel.enChannelType,
      }));
    };

    this.processImpulseResponse = async (processedResponse, adyTools) => {
      const identifier = processedResponse.name;
      const response = processedResponse.data;
      const max = Math.max(...response.map(x => Math.abs(x)));
      const lastMeasurementIndex = this.measurements().length;

      const options = {
        identifier,
        startTime: 0,
        sampleRate: adyTools.samplingRate,
        splOffset: this.jsonAvrData().avr?.splOffset ?? 80,
        applyCal: false,
        data: response,
      };
      await this.rewImport.importImpulseResponseData(options);

      const item = await this.rewMeasurements.get(lastMeasurementIndex + 1, 0);
      const measurementItem = await this.addMeasurement(item);
      measurementItem.IRPeakValue = max;
      if (max >= 1) {
        lm.warn(
          `${identifier} IR is above 1(${max.toFixed(
            2
          )}), it will not be used for processing`
        );
      }
    };

    this.processAdyMeasurements = async (data, filename, adyTools, zipContent) => {
      if (filename.endsWith('.ady')) {
        adyTools.isDirectionalWhenMultiSubs();
      }

      // Create download buttons
      const results = document.getElementById('resultsAvr');
      const button = document.createElement('button');
      button.textContent = `Download measurements zip`;
      button.onclick = () => saveAs(zipContent, `${data.title}.zip`);
      results.appendChild(button);

      // if not connected, do not import measurements in REW
      if (!this.isPolling()) {
        lm.warn('Not connected to REW, skipping measurements import');
        return;
      }

      try {
        // set processing state to speed up REW operations
        await this.setProcessing(true);
        // sort impulses by name to have all related positions together
        adyTools.impulses.sort((a, b) => a.name.localeCompare(b.name));
        for (const processedResponse of adyTools.impulses) {
          await this.processImpulseResponse(processedResponse, adyTools);
        }
      } finally {
        await this.setProcessing(false);
      }
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
        throw new Error(`File processing failed: ${error.message}`);
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

    // Handle file reading
    this.readFile = async file => {
      if (this.isProcessing()) return;

      try {
        if (!file) {
          throw new Error('No file selected');
        }

        this.validateFile(file);

        let fileContent = await file.text();

        // if mqx file contain garbage after closing json, truncate after the closing brake corresponding to the fisrt open bracket
        if (file.name.endsWith('.mqx')) {
          fileContent = this.cleanJSON(fileContent);
        }

        const data = JSON.parse(fileContent);
        this.loadedFileName(file.name);
        // Handle successful load
        await this.onFileLoaded(data, file.name);
      } catch (error) {
        this.handleError(`Error parsing file: ${error.message}`, error);
      }
    };

    this.cleanJSON = fileContent => {
      // Early return if the input is empty or not a string
      if (!fileContent || typeof fileContent !== 'string') {
        throw new Error('Invalid input: fileContent must be a non-empty string');
      }

      const firstOpen = fileContent.indexOf('{');
      if (firstOpen === -1) {
        throw new Error('Invalid file format: no JSON object found');
      }

      const closingIndex = this.findClosingBrace(fileContent, firstOpen);
      if (closingIndex === -1) {
        throw new Error('Invalid JSON structure: unmatched braces');
      }

      return fileContent.slice(firstOpen, closingIndex + 1);
    };

    this.findClosingBrace = (content, startIndex) => {
      let openCount = 0;
      let inString = false;
      let escapeNext = false;

      for (let i = startIndex; i < content.length; i++) {
        const char = content[i];

        if (char === '"' && !escapeNext) {
          inString = !inString;
        } else if (char === '\\' && !escapeNext) {
          escapeNext = true;
          continue;
        } else if (!inString) {
          if (char === '{') openCount++;
          else if (char === '}' && --openCount === 0) return i;
        }
        escapeNext = false;
      }

      return -1;
    };

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

    this.setProcessing = async newValue => {
      if (newValue && !this.isPolling()) {
        throw new Error('Please connect to REW before processing');
      }

      // Clear existing timeout
      if (this.processingTimeout) {
        clearTimeout(this.processingTimeout);
        this.processingTimeout = null;
      }

      this.isProcessing(newValue);

      // setup a timeout to avoid blocking forever
      if (newValue) {
        this.processingTimeout = setTimeout(() => {
          if (this.isProcessing()) {
            lm.warn('Processing is taking more than 60 seconds, unlocking controls');
            this.isProcessing(false);
          }
        }, 60000);
      }
      // inhibit Graph Updates only during processing
      if (this.isPolling() && this.inhibitGraphUpdates()) {
        await this.apiService.setInhibitGraphUpdates(newValue);
      }
      // Save to persistent when processing ends
      if (!newValue) {
        this.saveMeasurements();
      }
    };

    this.currentSelectedPosition = ko.observable();

    this.importMsoConfigInRew = async REWconfigs => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('Importing MSO config...');

        for (const [position, subResponses] of Object.entries(
          this.byPositionsGroupedSubsMeasurements()
        )) {
          if (!subResponses?.length) continue;

          const subResponsesTitles = subResponses.map(response =>
            response.displayMeasurementTitle()
          );
          lm.info(
            `Importing to position: ${position}\n${subResponsesTitles.join('\r\n')}`
          );

          await this.businessTools.importFilterInREW(REWconfigs, subResponses);
          this.handleSuccess(`REW import successful for position: ${position}`);
        }

        lm.info(`Importing finished`);
      } catch (error) {
        this.handleError(`REW import failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonDownloadAvr = async () => {
      if (this.isProcessing()) return;
      try {
        if (!this.jsonAvrData()) throw new Error('please load file before');

        const ipAddress = this.avrIpAddress().trim();
        if (!ipAddress) throw new Error('please enter AVR IP address');
        if (!RewApi.isValidIpAddress(ipAddress)) {
          throw new Error('please enter a valid AVR IP address');
        }

        const avrData = this.jsonAvrData();
        const newAvrData = {
          targetModelName: avrData.targetModelName,
          ipAddress,
          enMultEQType: avrData.enMultEQType,
          subwooferNum: avrData.subwooferNum,
          ampAssign: ampAssignType.getByIndex(avrData.enAmpAssignType),
          ampAssignInfo: avrData.ampAssignInfo,
          detectedChannels: avrData.detectedChannels.map(channel => ({
            commandId: channel.commandId,
          })),
        };

        // download new file receiver_config.avr with newAvrData content
        const blob = new Blob([JSON.stringify(newAvrData, null, 2)], {
          type: 'application/json',
        });
        saveAs(blob, 'receiver_config.avr');
        this.handleSuccess('Download successful');
      } catch (error) {
        this.handleError(`.avr file failed: ${error.message}`, error);
      }
    };

    this.buttoncheckREWButton = async () => {
      if (this.isProcessing()) return;
      try {
        this.error('');
        this.toggleBackgroundPolling();
      } catch (error) {
        this.handleError(`Pulling failed: ${error.message}`, error);
      }
    };

    this.renameMeasurement = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('Renaming started');
        for (const item of this.measurements()) {
          if (item.position() === 0) {
            continue;
          }
          // do not rename averaged measurements
          if (item.isAverage) {
            continue;
          }

          if (item.isUnknownChannel) {
            continue;
          }

          const newName = `${item.channelName()}_P${item
            .position()
            .toString()
            .padStart(2, '0')}`;

          item.setTitle(newName);
        }
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

      if (this.isPolling()) await this.apiService.clearCommands();
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

        // Get valid measurements to average
        const filteredMeasurements = this.validMeasurements().filter(
          item => !item.isAverage && item.IRPeakValue <= 1
        );

        // Check if we have enough measurements
        if (filteredMeasurements.length < 2) {
          throw new Error('Need at least 2 valid positions to calculate average');
        }

        // Single pass to collect offsets and count occurrences
        let firstAlignOffset = null;
        const inconsistentAlignOffsets = [];
        const inconsistentInvertedMeasurements = [];
        const offsetCount = {};
        const offsetDetails = [];

        for (const item of filteredMeasurements) {
          const title = item.displayMeasurementTitle();
          const alignOffset = item.alignSPLOffsetdB().toFixed(2);
          const offset = ((Math.round((item.splOffsetdB() * 10) / 3) * 3) / 10).toFixed(
            1
          );

          // Check align offset consistency
          if (firstAlignOffset === null) {
            firstAlignOffset = alignOffset;
          } else if (alignOffset !== firstAlignOffset && alignOffset !== '0.00') {
            inconsistentAlignOffsets.push(`${title}: ${alignOffset}dB`);
          }

          // Count offset occurrences and store details
          offsetCount[offset] = (offsetCount[offset] || 0) + 1;
          offsetDetails.push({ title, offset });

          // check if measurements have not been inverted

          if (item.inverted()) {
            inconsistentInvertedMeasurements.push(title);
          }
        }

        if (inconsistentAlignOffsets.length > 0) {
          throw new Error(
            `Some measurements have inconsistent SPL alignment offsets: ${inconsistentAlignOffsets.join(
              ', '
            )}`
          );
        }

        if (inconsistentInvertedMeasurements.length > 0) {
          throw new Error(
            `Some measurements appear to be inverted: ${inconsistentInvertedMeasurements.join(
              ', '
            )}`
          );
        }

        // Check SPL offset consistency
        const offsetKeys = Object.keys(offsetCount);
        if (offsetKeys.length > 1) {
          const mostCommonOffset = offsetKeys.reduce(
            (a, b) => (offsetCount[a] > offsetCount[b] ? a : b),
            offsetKeys[0]
          );
          const inconsistentOffsets = offsetDetails
            .filter(x => x.offset !== mostCommonOffset)
            .map(x => `${x.title}: ${x.offset}dB`)
            .join(', ');
          throw new Error(
            `Some measurements have inconsistent SPL offsets: ${inconsistentOffsets} expected ${mostCommonOffset}dB`
          );
        }

        // creates array of uuid attributes for each code into groupedResponse
        await this.businessTools.processGroupedResponses(
          this.groupedMeasurements(),
          this.selectedAverageMethod(),
          this.DeleteOriginalForAverage()
        );
        const averagePosition = this.measurementsPositionList().find(
          pos => pos.text === 'Average'
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
          true
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

        for (const measurement of this.uniqueSpeakersMeasurements()) {
          await measurement.setZeroAtIrPeak();
        }

        if (this.uniqueSubsMeasurements().length > 0) {
          const sub = this.uniqueSubsMeasurements()[0];
          await sub.setZeroAtIrPeak();
          await this.setSameDelayToAll(this.uniqueSubsMeasurements());
        }

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
        const workingMeasurements = this.uniqueSpeakersMeasurements();
        if (workingMeasurements.length === 0) {
          throw new Error('No measurements found for SPL alignment');
        } else if (workingMeasurements.length === 1) {
          throw new Error('Only one measurement found for SPL alignment');
        }
        const firstWorkingMeasurement = workingMeasurements[0];

        await firstWorkingMeasurement.resetTargetSettings();
        // working settings must match filter settings
        for (const work of this.uniqueMeasurements()) {
          await work.resetIrWindows();
        }
        const uuids = this.uniqueMeasurements().map(m => m.uuid);
        await this.rewMeasurements.smoothMeasurements(uuids, '1/1');

        await this.rewMeasurements.alignSPL(
          workingMeasurements.map(m => m.uuid),
          'average',
          2500,
          5
        );

        // take the new aligned measurements into account
        await this.loadData();

        // must be calculated before removing working settings
        await firstWorkingMeasurement.setTargetSettings({
          shape: 'Bass limited',
          bassManagementSlopedBPerOctave: 24,
          bassManagementCutoffHz: 150,
        });
        // TODO check target level calculation sometime is too high
        await this.rewMeasurements.calculateTargetLevel(firstWorkingMeasurement.uuid);
        await firstWorkingMeasurement.resetTargetSettings();

        // working settings must match filter settings
        for (const work of workingMeasurements) {
          await work.applyWorkingSettings();
        }

        // set target level to all measurements including subs
        await this.setTargetLevelFromMeasurement(firstWorkingMeasurement);

        // copy SPL alignment level to other measurements positions
        for (const measurement of this.uniqueMeasurements()) {
          await measurement.copySplOffsetDeltadBToOther();
        }

        // ajust subwoofer levels
        this.SubsFrequencyBands = await this.adjustSubwooferSPLLevels(
          this.uniqueSubsMeasurements()
        );

        for (const sub of this.uniqueSubsMeasurements()) {
          await sub.applyWorkingSettings();
        }

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
        const positionGroups = this.byPositionsGroupedSubsMeasurements();
        for (const [position, subResponses] of Object.entries(positionGroups)) {
          lm.info(`Processing position ${position}`);

          // Handle based on number of subwoofers
          if (subResponses.length === 0) continue;

          // Multiple subwoofers case - produce sum
          await this.produceSumProcess(subResponses);
        }
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

        await this.businessTools.produceAligned(
          speakerItem,
          this.uniqueSubsMeasurements()
        );

        this.syncAllPredictedLfeMeasurement();

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

        for (const speakerItem of this.uniqueSpeakersMeasurements()) {
          await this.checkAlignment(speakerItem);
        }
      } catch (error) {
        this.handleError(`Auto adjust inversion failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.checkAlignment = async speakerItem => {
      const mustBeDeleted = [];
      const allreadyProcessing = this.isProcessing();
      try {
        if (!allreadyProcessing) await this.setProcessing(true);
        const cuttOffFrequency = speakerItem.crossover();
        const PredictedLfe = speakerItem.relatedLfeMeasurement();

        if (!PredictedLfe) {
          throw new Error(`No LFE found, please use sum subs button`);
        }

        const predictedFrontLeft = await speakerItem.producePredictedMeasurement();
        mustBeDeleted.push(predictedFrontLeft);

        const { PredictedLfeFiltered, predictedSpeakerFiltered } =
          await this.businessTools.applyCutOffFilter(
            PredictedLfe,
            predictedFrontLeft,
            cuttOffFrequency
          );
        mustBeDeleted.push(PredictedLfeFiltered, predictedSpeakerFiltered);

        const { shiftDelay, isBInverted } = await this.findAligment(
          PredictedLfeFiltered,
          predictedSpeakerFiltered,
          cuttOffFrequency,
          1,
          false,
          null,
          -1
        );

        speakerItem.shiftDelay(shiftDelay);

        if (isBInverted) {
          await speakerItem.toggleInversion();
          lm.info(`Inversion toggled for ${speakerItem.displayMeasurementTitle()}`);
        } else {
          lm.info(`No inversion needed for ${speakerItem.displayMeasurementTitle()}`);
        }
      } catch {
        lm.warn(
          `Unable to determine inversion for ${speakerItem.displayMeasurementTitle()}`
        );
        speakerItem.shiftDelay(Infinity);
      } finally {
        await this.removeMeasurements(mustBeDeleted);
        if (!allreadyProcessing) await this.setProcessing(false);
      }
    };

    this.syncAllPredictedLfeMeasurement = async () => {
      const selectedLfe = this.predictedLfeMeasurement();

      if (!selectedLfe) {
        throw new Error(`No LFE found, please use sum subs button`);
      }

      const selectedLfeIRShift = selectedLfe.cumulativeIRShiftSeconds();
      const selectedLfeInverted = selectedLfe.inverted();

      for (const predictedLfe of this.allPredictedLfeMeasurement()) {
        if (predictedLfe.uuid === selectedLfe.uuid) continue;
        await predictedLfe.setcumulativeIRShiftSeconds(selectedLfeIRShift);
        await predictedLfe.setInverted(selectedLfeInverted);
        lm.debug(
          `Syncing LFE ${predictedLfe.displayMeasurementTitle()} to selected LFE settings`
        );
      }

      // TODO each related subwoofer measurement should follow the same settings as predicted LFE (applyTimeOffsetToSubs)
    };

    this.buttongenratesPreview = async () => {
      for (const item of this.uniqueSpeakersMeasurements()) {
        // display progression in the status
        lm.info(`Generating preview for ${item.displayMeasurementTitle()}`);
        await item.previewMeasurement();
      }

      this.handleSuccess(`Preview generated successfully`);
    };

    this.buttongeneratesFilters = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);

        for (const item of this.uniqueSpeakersMeasurements()) {
          // display progression in the status
          lm.info(`Generating filter for channel ${item.channelName()}`);
          await item.createStandardFilter();
        }

        this.handleSuccess(`Filters generated successfully`);
      } catch (error) {
        this.handleError(`Filter generation failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonInvertAll = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        for (const item of this.uniqueSpeakersMeasurements()) {
          // display progression in the status
          lm.info(`Inverting channel ${item.channelName()}`);
          await item.toggleInversion();
        }

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
      { value: 'L+M', text: 'L+M' },
    ];

    this.buttoncreateOCAButton = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('OCA file generation...');
        const measurementsinError = this.uniqueMeasurements().filter(item =>
          item.hasErrors()
        );

        if (measurementsinError.length > 0) {
          lm.warn(
            `There are ${measurementsinError.length} measurements with errors. Please fix them before generating the OCA file.`
          );
        }
        const avrData = this.jsonAvrData();
        if (!avrData?.targetModelName) {
          throw new Error(`Please load avr file first`);
        }
        const OCAFile = new OCAFileGenerator(avrData);

        await this.setTargetLevelFromMeasurement();
        if (!this.targetCurve()) {
          throw new Error(
            `Target curve not found. Please upload your preferred target curve under "REW/EQ/Target settings/House curve"`
          );
        }
        OCAFile.fileFormat = this.ocaFileFormat();
        OCAFile.tcName = ko.unwrap(this.tcName);
        OCAFile.softRoll = this.softRoll();
        OCAFile.enableDynamicEq = this.enableDynamicEq();
        OCAFile.dynamicEqRefLevel = this.dynamicEqRefLevel();
        OCAFile.enableDynamicVolume = this.enableDynamicVolume();
        OCAFile.dynamicVolumeSetting = this.dynamicVolumeSetting();
        OCAFile.enableLowFrequencyContainment = this.enableLowFrequencyContainment();
        OCAFile.lowFrequencyContainmentLevel = this.lowFrequencyContainmentLevel();
        OCAFile.subwooferOutput = this.subwooferOutput();
        OCAFile.lpfForLFE = this.lpfForLFE();
        OCAFile.numberOfSubwoofers = this.uniqueSubsMeasurements().length;
        OCAFile.versionEvo = `RCH ${this.currentVersion}`;

        const jsonData = await OCAFile.createOCAFile(this.uniqueMeasurements());

        // Validate input
        if (!jsonData) {
          throw new Error('No data to save');
        }

        const timestamp = new Date()
          .toISOString()
          .slice(0, 16)
          .replace('T', '-')
          .replaceAll(':', '-');
        const model = avrData.targetModelName.replaceAll(' ', '-');
        const filename = `${timestamp}_${this.ocaFileFormat()}_${this.targetCurve()}_${model}.oca`;

        // Create blob
        const blob = new Blob([jsonData], {
          type: 'application/json',
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
        if (!this.targetCurve()) {
          throw new Error(
            `Target curve not found. Please upload your preferred target curve under "REW/EQ/Target settings/House curve"`
          );
        }
        const selectedSpeaker = this.findMeasurementByUuid(this.selectedSpeaker());
        const selectedSpeakerText = selectedSpeaker?.displayMeasurementTitle() || 'None';
        const selectedSpeakerCrossover = selectedSpeaker?.crossover();
        // find if we have revert LFE frequency
        const subWithFreq = this.uniqueSubsMeasurements().find(
          item => item.revertLfeFrequency !== 0
        );
        const revertLfeFrequency = subWithFreq?.revertLfeFrequency;

        // function to add "Hz" suffix to frequency values
        const addHzSuffix = freq => (freq ? `${freq} Hz` : 'None');

        // Generate a text file containing all the settings and parameters
        let textData = '';

        // Title and timestamp
        const now = new Date();
        textData += `=======================================================\n`;
        textData += `  ROOM CORRECTION HELPER - ${now.toLocaleDateString()} ${now.toLocaleTimeString()}\n`;
        textData += `=======================================================\n\n`;

        // Basic settings section
        textData += `BASIC SETTINGS\n`;
        textData += `-------------\n`;
        textData += `Loaded File:       ${this.loadedFileName()}\n`;
        textData += `Target Curve:      ${this.targetCurve()}\n`;
        textData += `Target Level:      ${this.mainTargetLevel()} dB\n`;
        textData += `Average Method:    ${this.selectedAverageMethod()}\n\n`;

        // AVR Info section
        textData += `AVR INFORMATION\n`;
        textData += `--------------\n`;
        textData += `Model:                    ${avrData.targetModelName}\n`;
        textData += `MultEQ Type:              ${avrData.avr.multEQType}\n`;
        textData += `Has Cirrus Logic DSP:     ${
          avrData.avr.hasCirrusLogicDsp ? 'Yes' : 'No'
        }\n`;
        textData += `Speed of Sound:           ${avrData.avr.speedOfSound} m/s\n\n`;

        // Speaker settings section
        textData += `SPEAKER SETTINGS\n`;
        textData += `----------------\n`;
        textData += `Smoothing Method:         ${this.selectedSmoothingMethod()}\n`;
        textData += `Windowing:                ${this.selectedIrWindows()}\n`;
        textData += `Individual Max Boost:     ${this.individualMaxBoostValue()} dB\n`;
        textData += `Overall Max Boost:        ${this.overallBoostValue()} dB\n\n`;

        // Subwoofer settings section
        textData += `SUBWOOFER SETTINGS\n`;
        textData += `------------------\n`;
        textData += `Number of Subs:           ${this.uniqueSubsMeasurements().length}\n`;
        textData += `Revert LFE Filter Freq:   ${addHzSuffix(revertLfeFrequency)}\n`;

        textData += `Max Boost Individual:     ${this.maxBoostIndividualValue()} dB\n`;
        textData += `Max Boost Overall:        ${this.maxBoostOverallValue()} dB\n`;

        textData += `Align Frequency:          ${addHzSuffix(
          selectedSpeakerCrossover
        )}\n`;
        textData += `Selected Speaker:         ${selectedSpeakerText}\n`;

        textData += `LPF for LFE:              ${this.lpfForLFE()} Hz\n`;
        textData += `Subwoofer Output:         ${this.subwooferOutput()}\n\n`;

        // Dynamic settings section
        textData += `DYNAMIC SETTINGS\n`;
        textData += `----------------\n`;
        textData += `Dynamic EQ:        ${
          this.enableDynamicEq() ? 'Enabled' : 'Disabled'
        }\n`;
        if (this.enableDynamicEq()) {
          textData += `  Reference Level:  ${this.dynamicEqRefLevel()} dB\n`;
        }
        textData += `Dynamic Volume:    ${
          this.enableDynamicVolume() ? 'Enabled' : 'Disabled'
        }\n`;
        if (this.enableDynamicVolume()) {
          textData += `  Volume Setting:   ${this.dynamicVolumeSetting()}\n`;
        }
        textData += `LF Containment:    ${
          this.enableLowFrequencyContainment() ? 'Enabled' : 'Disabled'
        }\n`;
        if (this.enableLowFrequencyContainment()) {
          textData += `  LFC Level:        ${this.lowFrequencyContainmentLevel()}\n`;
        }
        textData += `\n`;

        // Version information
        textData += `VERSION INFORMATION\n`;
        textData += `-------------------\n`;
        textData += `REW Version:       ${this.rewVersion()}\n`;
        textData += `RCH Version:       ${this.currentVersion}\n\n`;

        // Save to persistent store
        const reducedMeasurements = this.uniqueMeasurements().map(item => item.toJSON());

        // Create table header
        textData +=
          '\n+------------------------+---------------+----------+-------------+---------------------+----------+\n';
        textData +=
          '| Measurement            | Channel       | Distance | SPL Offset  | Crossover Frequency | Inverted |\n';
        textData +=
          '+------------------------+---------------+----------+-------------+---------------------+----------+\n';

        // Add table rows
        for (const measurement of reducedMeasurements) {
          const title = measurement.displayMeasurementTitle.padEnd(22);
          const channel = measurement.channelName.padEnd(13);
          const distance = measurement.distance.toFixed(2).padStart(8);
          const splOffset = measurement.splForAvr.toString().padStart(11);
          const crossover = measurement.crossover.toString().padStart(19);
          const inverted = (measurement.inverted ? 'Yes' : '').padEnd(8);

          textData += `| ${title} | ${channel} | ${distance} | ${splOffset} | ${crossover} | ${inverted} |\n`;
        }

        // Add table footer
        textData +=
          '+------------------------+---------------+----------+-------------+---------------------+----------+\n';

        // Create timestamp
        const timestamp = new Date()
          .toISOString()
          .slice(0, 16)
          .replace('T', '-')
          .replaceAll(':', '-');
        const model = avrData.targetModelName.replaceAll(' ', '-');
        const filename = `${timestamp}_${this.targetCurve()}_${model}.txt`;

        // Create blob
        const blob = new Blob([textData], {
          type: 'application/text',
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

    this.processMsoMeasurement = async (measurement, jszip, minFreq, maxFreq) => {
      await measurement.resetAll(this.mainTargetLevel());
      const frequencyResponse = await measurement.getFrequencyResponse();
      await measurement.applyWorkingSettings();
      const subName = measurement.channelName().replace('SW', 'SUB');
      const localFilename = `POS${measurement.position()}-${subName}.txt`;

      const lines = [];
      for (let i = 0; i < frequencyResponse.freqs.length; i++) {
        const freq = frequencyResponse.freqs[i];
        if (freq >= minFreq && freq <= maxFreq) {
          lines.push(
            `${freq.toFixed(6)} ${frequencyResponse.magnitude[i].toFixed(
              3
            )} ${frequencyResponse.phase[i].toFixed(4)}`
          );
        }
      }

      if (!lines.length) {
        throw new Error(`no file content for ${localFilename}`);
      }

      jszip.file(localFilename, lines.join('\n'));
    };

    this.buttonCreatesMsoExports = async () => {
      if (this.isProcessing()) return;
      try {
        if (!this.isPolling()) {
          throw new Error('Please start connetion first');
        }

        await this.setProcessing(true);
        lm.info('Exports Subs...');

        const jszip = new JSZip();
        const zipFilename = `MSO-${this.jsonAvrData().model}.zip`;
        const minFreq = 5; // minimum frequency in Hz
        const maxFreq = 400; // maximum frequency in Hz

        const measurements = this.subsMeasurements();
        const chunkSize = 5;

        for (let i = 0; i < measurements.length; i += chunkSize) {
          const chunk = measurements.slice(i, i + chunkSize);
          for (const measurement of chunk) {
            await this.processMsoMeasurement(measurement, jszip, minFreq, maxFreq);
          }
        }

        // Generate the zip file once and save it
        const zipContent = await jszip.generateAsync({ type: 'blob' });
        saveAs(zipContent, zipFilename);
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
        if (this.uniqueSubsMeasurements().length === 1) {
          await this.buttonSingleSubOptimizer();
        } else if (this.uniqueSubsMeasurements().length > 1) {
          await this.buttonMutipleSubOptimizer();
        }

        this.handleSuccess('Equalize Subs successful');
      } catch (error) {
        this.handleError(`Equalize Subs failed: ${error.message}`, error);
      } finally {
        await this.setProcessing(false);
      }
    };

    this.buttonMutipleSubOptimizer = async () => {
      lm.info('Equalize multiple subs...');

      const maximisedSum = this.measurements().find(
        item => item.title() === MeasurementViewModel.MAXIMISED_SUM_TITLE
      );
      if (!maximisedSum) {
        throw new Error('No maximised sum found');
      }
      await this.equalizeSubProcess(maximisedSum);
      await this.applyFiltersToSubs(maximisedSum);
      await this.copySubFiltersToOtherPositions();
    };

    this.applyFiltersToSubs = async sourceSub => {
      lm.info(`Apply calculated filters to each sub`);
      const filters = await sourceSub.getFilters();
      const subsMeasurements = this.uniqueSubsMeasurements();
      for (const sub of subsMeasurements) {
        // do not overwrite the all pass filter if set
        await sub.setFilters(filters, false);
      }
    };

    this.equalizeSubProcess = async subMeasurement => {
      lm.info(`Equalizing ${await subMeasurement.displayMeasurementTitle()}`);
      await this.equalizeSub(subMeasurement);
    };

    this.copySubFiltersToOtherPositions = async () => {
      const subsMeasurements = this.uniqueSubsMeasurements();
      for (const sub of subsMeasurements) {
        await sub.copyFiltersToOther();
      }
    };

    this.buttonSingleSubOptimizer = async () => {
      lm.info('Equalize single sub...');
      const subMeasurement = this.uniqueSubsMeasurements()[0];
      await this.equalizeSubProcess(subMeasurement);
      await this.copySubFiltersToOtherPositions();
    };

    this.createOptimizerConfig = (lowFrequency, highFrequency) => {
      if (!this.jsonAvrData()?.avr) {
        throw new Error('Please load AVR data first');
      }

      const subMeasurement = this.uniqueSubsMeasurements()[0];
      const headroomSeconds = MeasurementItem.cleanFloat32Value(
        subMeasurement._computeInSeconds(this.distanceLeftBeforeError()),
        4
      );
      if (headroomSeconds <= 0.002) {
        lm.warn(
          `Low distance left before error (${(headroomSeconds * 1000).toFixed(
            1
          )} ms). Optimization may fail. Consider increasing the distance left before error in settings.`
        );
      }
      if (headroomSeconds <= 0) {
        throw new Error(
          `Distance left before error (${(headroomSeconds * 1000).toFixed(
            1
          )} ms) is too low. Please increase the distance left before error in settings.`
        );
      }
      return {
        frequency: { min: lowFrequency, max: highFrequency },
        gain: { min: 0, max: 0, step: 0.1 },
        delay: {
          min: -headroomSeconds,
          max: headroomSeconds,
          step: this.jsonAvrData().avr.minDistAccuracy || 0.00001,
        },
        allPass: {
          enabled: this.useAllPassFiltersForSubs(),
          frequency: { min: 10, max: 500, step: 10 },
          q: { min: 0.1, max: 0.5, step: 0.1 },
        },
      };
    };

    this.applySubPolarity = async (subMeasurement, polarity) => {
      if (polarity === -1) {
        await subMeasurement.setInverted(true);
      } else if (polarity === 1) {
        await subMeasurement.setInverted(false);
      } else {
        throw new Error(
          `Invalid invert value for ${await subMeasurement.displayMeasurementTitle()}`
        );
      }
    };

    this.applySubAllPassFilter = async (subMeasurement, allPassParam) => {
      const allPassFilter = allPassParam.enabled
        ? {
            index: 20,
            enabled: true,
            isAuto: false,
            frequency: allPassParam.frequency,
            q: allPassParam.q,
            type: 'All pass',
          }
        : { index: 20, enabled: true, isAuto: true, type: 'None' };
      await subMeasurement.setSingleFilter(allPassFilter);
    };

    this.applyOptimizedSubSettings = async sub => {
      const subMeasurement = this.findMeasurementByUuid(sub.measurement);
      if (!subMeasurement) {
        throw new Error(`Measurement not found for ${sub.measurement}`);
      }
      await this.applySubPolarity(subMeasurement, sub.param.polarity);
      await subMeasurement.addIROffsetSeconds(sub.param.delay);
      await subMeasurement.addSPLOffsetDB(sub.param.gain);
      await subMeasurement.copySplOffsetDeltadBToOther();
      await this.applySubAllPassFilter(subMeasurement, sub.param.allPass);
    };

    this.buttonMultiSubOptimizer = async () => {
      if (this.isProcessing()) return;
      try {
        await this.setProcessing(true);
        lm.info('MultiSubOptimizer...');

        const subsMeasurements = this.uniqueSubsMeasurements();

        if (subsMeasurements.length === 0) {
          throw new Error('No subwoofers found');
        }
        if (subsMeasurements.length === 1) {
          throw new Error(
            'Only one subwoofer found, please use single sub optimizer button'
          );
        }

        if (
          !this.SubsFrequencyBands?.lowFrequency ||
          !this.SubsFrequencyBands?.highFrequency
        ) {
          throw new Error(
            'Subwoofer frequency bands not defined, please use Align SPL button first'
          );
        }

        //delete previous LFE predicted measurements
        await this.removeMeasurements(this.allPredictedLfeMeasurement());

        // set the same delay for all subwoofers
        await this.setSameDelayToAll(subsMeasurements);

        const optimizerConfig = this.createOptimizerConfig(
          this.SubsFrequencyBands.lowFrequency,
          this.SubsFrequencyBands.highFrequency
        );
        lm.info(
          `frequency range: ${optimizerConfig.frequency.min}Hz - ${optimizerConfig.frequency.max}Hz`
        );
        lm.info(
          `delay range: ${optimizerConfig.delay.min * 1000}ms - ${
            optimizerConfig.delay.max * 1000
          }ms`
        );

        lm.info(`Deleting previous settings...`);

        // remove previous maximised sum and maximised sum theoretical
        const previousMaxSum = this.measurements().filter(item =>
          item.title().startsWith(MeasurementViewModel.MAXIMISED_SUM_TITLE)
        );

        await this.removeMeasurements(previousMaxSum);

        const frequencyResponses = [];
        for (const measurement of subsMeasurements) {
          await measurement.setInverted(false);
          await measurement.applyWorkingSettings();
          const frequencyResponse = await measurement.getFrequencyResponse();
          frequencyResponse.measurement = measurement.uuid;
          frequencyResponse.name = measurement.displayMeasurementTitle();
          frequencyResponse.position = measurement.position();
          frequencyResponses.push(frequencyResponse);
        }

        lm.info(`Sarting lookup...`);
        const optimizer = new MultiSubOptimizer(frequencyResponses, optimizerConfig, lm);
        const optimizerResults = optimizer.optimizeSubwoofers();

        for (const sub of optimizerResults.optimizedSubs) {
          await this.applyOptimizedSubSettings(sub);
        }

        lm.info(`Creating sub sumation...`);
        // DEBUG use REW api way to generate the sum for compare
        // const maximisedSum = await this.produceSumProcess(subsMeasurements);

        const optimizedSubsSum = optimizer.getFinalSubSum();

        const maximisedSum = await this.sendToREW(
          optimizedSubsSum,
          MeasurementViewModel.MAXIMISED_SUM_TITLE
        );

        const maximisedSumTheo = await this.sendToREW(
          optimizer.theoreticalMaxResponse,
          MeasurementViewModel.MAXIMISED_SUM_TITLE + ' Theo'
        );

        maximisedSum.isSubOperationResult = true;
        maximisedSumTheo.isSubOperationResult = true;
        // DEBUG to check if this is the same
        // await this.sendToREW(optimizerResults.bestSum, 'test');

        // reserve filter emplacement 20 for all pass
        if (optimizerConfig.allPass.enabled) {
          const maximisedSumFilter = {
            index: 20,
            enabled: true,
            isAuto: false,
            type: 'None',
          };
          await maximisedSum.setSingleFilter(maximisedSumFilter);
        }

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
    this.subsMeasurements = ko.computed(() =>
      this.measurements().filter(item => item.isSub())
    );

    this.subsLikeMeasurements = ko.computed(() =>
      this.measurements().filter(item => item.isSub() || item.isSubOperationResult)
    );

    this.validMeasurements = ko.computed(() =>
      this.measurements().filter(item => item.isValid)
    );

    this.groupedMeasurements = ko.computed(() => {
      const groups = {};
      for (const item of this.measurements()) {
        if (item.isUnknownChannel) continue;

        const channelName = item.channelName();
        let group = groups[channelName];
        if (!group) {
          group = { items: [], count: 0 };
          groups[channelName] = group;
        }
        group.items.push(item);
        group.count++;
      }
      return groups;
    });
    // creates a map from groupedMeasurements with items grouped by the same position attribute
    this.byPositionsGroupedSubsMeasurements = ko.computed(() => {
      const groups = {};
      for (const item of this.subsMeasurements()) {
        const key = item.position();
        (groups[key] ??= []).push(item);
      }
      return groups;
    });

    this.measurementsPositionList = ko.computed(() => {
      try {
        const allMeasurementPositions = this.measurements()
          .map(item => item.position())
          .filter(Boolean);

        const uniquePositions = [...new Set(allMeasurementPositions)];

        const positionsSet = uniquePositions
          .map(pos => {
            const item = this.measurements().find(m => m.position() === pos);
            return { value: pos, text: item.displayPositionText() };
          })
          .sort((a, b) => a.text.localeCompare(b.text));

        return positionsSet;
      } catch (error) {
        this.handleError('Error computing measurements position list:', error);
        return [];
      }
    });

    // Filtered measurements
    this.uniqueMeasurements = ko.computed(() => {
      const measurements = this.measurements();
      // Early return for empty collection
      if (!measurements || measurements.length === 0) {
        return [];
      }
      return measurements.filter(item => item.isSelected());
    }, this);

    // Filtered measurements
    this.notUniqueMeasurements = ko.computed(() => {
      const measurements = this.measurements();
      // Early return for empty collection
      if (!measurements || measurements.length === 0) {
        return [];
      }
      return measurements.filter(item => !item.isSelected());
    }, this);

    // Filtered measurements
    this.uniqueMeasurementsView = ko.computed(() => {
      if (this.selectedMeasurementsFilter()) {
        return this.uniqueMeasurements();
      }
      return this.measurements();
    });

    this.mainTargetLevel = ko.observable(MeasurementItem.DEFAULT_TARGET_LEVEL);

    this.tcName = ko.pureComputed(() => {
      return `${this.targetCurve()} ${this.mainTargetLevel()}dB`;
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
        2
      )
    );

    this.maxDistanceInMetersError = ko.pureComputed(() =>
      MeasurementItem.cleanFloat32Value(
        this.minDistanceInMeters() + MeasurementItem.MODEL_DISTANCE_CRITICAL_LIMIT,
        2
      )
    );

    this.distanceLeftBeforeError = ko.pureComputed(() => {
      const distanceLeft = this.maxDistanceInMetersError() - this.maxDistanceInMeters();
      return distanceLeft > 0 ? MeasurementItem.cleanFloat32Value(distanceLeft, 2) : 0;
    });

    this.shiftInMeters = ko.computed(() => {
      const distances = this.uniqueMeasurements().map(item =>
        item._computeInMeters(item.absoluteIRPeakSeconds())
      );
      if (Math.min(...distances) < 1) {
        return MeasurementViewModel.DEFAULT_SHIFT_IN_METERS;
      }
      return 0;
    });

    this.uniqueSubsMeasurements = ko.computed(() => {
      return this.uniqueMeasurements().filter(item => item.isSub());
    });

    this.predictedLfeMeasurementTitle = ko.computed(() => {
      const position = this.currentSelectedPosition();
      if (position === undefined || position === null) return undefined;

      return `${MeasurementItem.DEFAULT_LFE_PREDICTED}${position}`;
    });

    this.allPredictedLfeMeasurement = ko.computed(() => {
      return this.measurements().filter(response =>
        response?.title().startsWith(MeasurementItem.DEFAULT_LFE_PREDICTED)
      );
    });

    this.predictedLfeMeasurement = ko.computed(() => {
      return this.allPredictedLfeMeasurement().find(
        response => response?.title() === this.predictedLfeMeasurementTitle()
      );
    });

    this.uniqueSpeakersMeasurements = ko.computed(() => {
      return this.uniqueMeasurements().filter(item => !item.isSub());
    });

    this.minSpeakersDistanceInMeters = ko.pureComputed(() => {
      const distances = this.uniqueSpeakersMeasurements().map(item =>
        item.distanceInMeters()
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
        this.minSpeakersDistanceInMeters() - this.minSubDistanceInMeters()
      );

      return this.maxDistanceInMetersError() - this.maxSubDistanceInMeters() + shift;
    });
  }

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
    store.clear();

    // Reset all application state
    for (const item of this.measurements()) {
      item.dispose();
    }
    this.measurements([]);
    this.jsonAvrData(null);

    this.targetCurve('');
    this.rewVersion('');
    this.maxBoostIndividualValue(0);
    this.maxBoostOverallValue(0);
    this.loadedFileName('');

    // Reset selectors to default values
    this.selectedSpeaker('');
    this.selectedLfeFrequency(250);
    this.selectedAverageMethod('');
    this.selectedMeasurementsFilter(true);
    this.SubsFrequencyBands = null;
  }

  async updateTargetCurve(referenceMeasurement) {
    const previousTargetcurveTitle = 'Target';
    const title = `${previousTargetcurveTitle} ${this.tcName()}`;

    if (this.measurements().some(item => item.title() === title)) {
      lm.debug(`Current target curve ${title} is valid, skipping creation.`);
      return false;
    }

    lm.debug(`Current target curve needs to be uodated to ${title}.`);
    if (!referenceMeasurement) {
      lm.warn('No reference measurement provided for target curve generation.');
      return false;
    }

    // delete previous targets curve
    const previousTargetcurves = this.measurements().filter(item =>
      item.title().startsWith(previousTargetcurveTitle)
    );

    await this.removeMeasurements(previousTargetcurves);

    const apiResponse = await this.rewMeasurements.generateTargetMeasurement(
      referenceMeasurement.uuid
    );
    const targetMeasurement = await this.analyseApiResponse(apiResponse);
    await targetMeasurement.setTitle(title, `from ${referenceMeasurement.title()}`);

    lm.info(`Created target curve: ${title}`);
    return true;
  }

  async equalizeSub(subMeasurement) {
    await subMeasurement.setTargetLevel(this.mainTargetLevel());
    await subMeasurement.applyWorkingSettings();
    await subMeasurement.resetTargetSettings();
    await subMeasurement.detectFallOff(-3);

    const customStartFrequency = Math.max(
      this.lowerFrequencyBound(),
      subMeasurement.dectedFallOffLow
    );
    // do not use min because dectedFallOffHigh can be -1 if not detected
    const customEndFrequency = Math.min(
      this.upperFrequencyBound(),
      subMeasurement.dectedFallOffHigh
    );

    lm.info(
      `Creating EQ filters for sub sumation ${customStartFrequency}Hz - ${customEndFrequency}Hz`
    );

    await this.rewEq.setMatchTargetSettings({
      startFrequency: customStartFrequency,
      endFrequency: customEndFrequency,
      individualMaxBoostdB: this.maxBoostIndividualValue(),
      overallMaxBoostdB: this.maxBoostOverallValue(),
      flatnessTargetdB: 1,
      allowNarrowFiltersBelow200Hz: false,
      varyQAbove200Hz: false,
      allowLowShelf: false,
      allowHighShelf: false,
    });

    await this.rewMeasurements.matchTarget(subMeasurement.uuid);

    await subMeasurement.checkFilterGain();

    return true;
  }

  async setSameDelayToAll(measurements) {
    if (measurements.length <= 1) {
      return;
    }
    // align the others sub to first measurement delay
    const mainDelay = measurements[0].cumulativeIRShiftSeconds();
    for (const measurement of measurements) {
      await measurement.setcumulativeIRShiftSeconds(mainDelay);
    }
  }

  async adjustSubwooferSPLLevels(subsMeasurements, targetLevelFreq = 40) {
    if (subsMeasurements.length === 0) {
      return;
    }

    //delete previous LFE predicted measurements
    await this.removeMeasurements(this.allPredictedLfeMeasurement());

    const minFrequency = 10;
    const maxFrequency = 10000;

    // Find the level of target curve at 40Hz
    const targetLevelAtFreq = await this.getTargetLevelAtFreq(
      subsMeasurements[0],
      targetLevelFreq
    );

    // adjut target level according to the number of subs
    // Using 20 for voltage addition (coherent/in-phase summation)
    const numbersOfSubs = subsMeasurements.length;
    const overhead = 20 * Math.log10(numbersOfSubs);
    const targetLevel = targetLevelAtFreq - overhead;

    let lowFrequency = Infinity;
    let highFrequency = 0;

    for (const measurement of subsMeasurements) {
      await measurement.removeWorkingSettings();
      await measurement.resetTargetSettings();

      // TODO switch to 1/1 smoothing when tests done
      const frequencyResponse = await measurement.getFrequencyResponse('SPL', '1/2', 6);
      frequencyResponse.measurement = measurement.uuid;
      frequencyResponse.name = measurement.displayMeasurementTitle();
      frequencyResponse.position = measurement.position();
      await measurement.applyWorkingSettings();

      const detect = this.detectSubwooferCutoff(
        frequencyResponse.freqs,
        frequencyResponse.magnitude,
        -18
      );

      lowFrequency = Math.min(lowFrequency, Math.round(detect.lowCutoff));
      highFrequency = Math.max(highFrequency, Math.round(detect.highCutoff));

      let logMessage = `\nAdjust ${measurement.displayMeasurementTitle()} SPL levels to ${targetLevel.toFixed(
        1
      )}dB`;
      logMessage += `(center: ${detect.centerFrequency}Hz, ${detect.octaves} octaves, ${detect.lowCutoff}Hz - ${detect.highCutoff}Hz)`;

      const alignResult = await this.rewMeasurements.alignSPL(
        [measurement.uuid],
        targetLevel,
        detect.centerFrequency,
        detect.octaves
      );

      await measurement.refresh();

      const alignOffset = MeasurementItem.getAlignSPLOffsetdBByUUID(
        alignResult,
        measurement.uuid
      );

      logMessage += ` => ${alignOffset}dB`;
      lm.info(`${logMessage}`);

      await measurement.copySplOffsetDeltadBToOther();
    }

    lowFrequency = Math.max(lowFrequency, minFrequency);
    highFrequency = Math.min(highFrequency, maxFrequency);

    return { lowFrequency, highFrequency, targetLevelAtFreq };
  }

  async getTargetLevelAtFreq(measurement, targetFreq = 40) {
    // Input validation
    if (!Number.isFinite(targetFreq) || targetFreq <= 0) {
      throw new Error('Target frequency must be a positive number');
    }

    if (!measurement) {
      measurement = this.uniqueMeasurements()[0];
    }

    if (!measurement) {
      throw new Error('No measurements available');
    }

    // Find the level of target curve at 40Hz

    const targetCurveResponse = await measurement.getTargetResponse('SPL', 6);
    if (!targetCurveResponse) {
      throw new Error('Failed to get target curve response');
    }

    const freqIndex = targetCurveResponse.freqs.reduce((closestIdx, curr, idx) => {
      const closestFreq = targetCurveResponse.freqs[closestIdx];
      return Math.abs(curr - targetFreq) < Math.abs(closestFreq - targetFreq)
        ? idx
        : closestIdx;
    }, 0);
    return targetCurveResponse.magnitude[freqIndex];
  }

  setTargetLevelFromMeasurement = async measurement => {
    if (!measurement || !(measurement instanceof MeasurementItem)) {
      // use first measurement as default
      measurement = this.firstMeasurement();
      if (!measurement) {
        lm.warn('No measurements available to set target level from');
      }
    }
    const initialProcessing = this.isProcessing();
    try {
      if (!initialProcessing) await this.setProcessing(true);
      lm.debug(`Setting target level from measurement: ${measurement?.title()}`);
      const targetLevel = measurement
        ? await measurement.getTargetLevel()
        : await this.rewEq.getDefaultTargetLevel();
      const newValue = targetLevel || MeasurementItem.DEFAULT_TARGET_LEVEL;

      const currentTc = await this.rewEq.checkTargetCurve();
      if (currentTc === 'None') {
        lm.warn('No target curve set in REW, please set a target curve first');
      }

      this.targetCurve(currentTc);

      const newTcName = `${this.targetCurve()} ${newValue}dB`;

      // check if target curve or target level changed, if not, skip
      if (newTcName === this.tcName()) {
        // sometimes target not exist, this creates it
        await this.updateTargetCurve(measurement);
        return;
      }

      // update target level
      this.mainTargetLevel(newValue);

      lm.info(`Current target curve: ${this.tcName()}`);

      // update all measurements target level
      const targets = this.validMeasurements();
      for (const otherItem of targets) {
        // Filters will be deleted if target level is changed
        lm.info(`Updating target level for measurement: ${otherItem.title()}`);
        await otherItem.setTargetLevel(newValue);
      }

      // set default target level for future measurements
      await this.rewEq.setDefaultTargetLevel(newValue);

      //delete previous LFE predicted measurements
      await this.removeMeasurements(this.allPredictedLfeMeasurement());
      // update tcName when main target level changes
      this.tcName.notifySubscribers();
      // if main target level change, we need to update target curve measurement
      const updated = await this.updateTargetCurve(this.firstMeasurement());
      if (!updated) {
        lm.warn(`Target curve update failed`);
      }

      return newValue;
    } finally {
      if (!initialProcessing) await this.setProcessing(false);
    }
  };

  getMaxFromArray(array) {
    if (!Array.isArray(array)) {
      throw new TypeError('Input is not an array');
    }

    let maxPeak = -Infinity;
    for (const value of array) {
      if (value > maxPeak) {
        maxPeak = value;
      }
    }
    return maxPeak;
  }

  /**
   * Detect subwoofer frequency cutoff points
   * @param {number[]} frequencies - Array of frequency points
   * @param {number[]} magnitude - Array of magnitude values in dB
   * @param {number} thresholdDb - Cutoff threshold in dB (default -6dB)
   * @param {number} low - Lower frequency bound (default 10Hz)
   * @param {number} high - Upper frequency bound (default 500Hz)
   * @returns {Object} Object containing low and high cutoff frequencies and peak magnitude
   */
  detectSubwooferCutoff(
    fullFrequencies,
    fullMagnitude,
    thresholdDb = -6,
    low = 10,
    high = 500
  ) {
    // Input validation
    if (
      !fullFrequencies?.length ||
      !fullMagnitude?.length ||
      fullFrequencies.length !== fullMagnitude.length
    ) {
      throw new Error('Invalid input arrays');
    }

    if (thresholdDb >= 0) {
      throw new Error('Threshold must be negative');
    }

    // Create new arrays to store filtered values
    const frequencies = [];
    const magnitude = [];

    // Iterate through frequencies and keep only those within range
    for (let index = 0; index < fullFrequencies.length; index++) {
      const freq = fullFrequencies[index];
      if (freq >= low && freq <= high) {
        frequencies.push(freq);
        magnitude.push(fullMagnitude[index]);
      }
    }

    // Find peak magnitude using array methods instead of loop
    const peakMagnitude = this.getMaxFromArray(
      magnitude.filter((_, i) => frequencies[i] >= low && frequencies[i] <= high)
    );

    // Calculate threshold level once
    const thresholdLevel = peakMagnitude + thresholdDb;

    // Find low frequency cutoff using find method
    const lowIndex = frequencies.findIndex((_, i) => magnitude[i] >= thresholdLevel);

    // Find high frequency cutoff using findLast method
    const highIndex = frequencies.findLastIndex((_, i) => magnitude[i] >= thresholdLevel);

    // Calculate cutoff frequencies with interpolation
    let lowCutoff =
      lowIndex > 0
        ? this.interpolateFrequency(
            frequencies[lowIndex - 1],
            frequencies[lowIndex],
            magnitude[lowIndex - 1],
            magnitude[lowIndex],
            thresholdLevel
          )
        : frequencies[lowIndex];

    let highCutoff =
      highIndex < frequencies.length - 1
        ? this.interpolateFrequency(
            frequencies[highIndex],
            frequencies[highIndex + 1],
            magnitude[highIndex],
            magnitude[highIndex + 1],
            thresholdLevel
          )
        : frequencies[highIndex];

    lowCutoff = Math.round(lowCutoff);
    highCutoff = Math.floor(highCutoff);

    // find the center frequency by octaves bettween lowCutoff and highCutoff
    const centerFrequency = Math.round(Math.sqrt(lowCutoff * highCutoff));

    // count the number of octaves between low and high cutoff from center frequency and round to lowest integer
    const octaves = Math.round(Math.log2(highCutoff / centerFrequency) * 2);

    return {
      lowCutoff,
      highCutoff,
      centerFrequency,
      octaves,
      peakMagnitude,
    };
  }

  /**
   * Linear interpolation for frequency
   */
  interpolateFrequency(freq1, freq2, mag1, mag2, targetMag) {
    const ratio = (targetMag - mag1) / (mag2 - mag1);
    return freq1 + (freq2 - freq1) * ratio;
  }

  /**
   * Round number to specified decimal places
   */
  roundToPrecision(number, precision = 1) {
    const factor = Math.pow(10, precision);
    return Math.round(number * factor) / factor;
  }

  async createsSumFromFR(measurementList) {
    try {
      if (!Array.isArray(measurementList) || measurementList.length === 0) {
        throw new Error('Invalid measurement list');
      }
      const frequencyResponses = [];
      for (const measurement of measurementList) {
        await measurement.removeWorkingSettings();
        const frequencyResponse = await measurement.getFrequencyResponse();
        frequencyResponse.uuid = measurement.uuid;
        frequencyResponses.push(frequencyResponse);
        await measurement.applyWorkingSettings();
      }

      const optimizer = new MultiSubOptimizer(
        frequencyResponses,
        MultiSubOptimizer.DEFAULT_CONFIG,
        lm
      );
      const optimizedSubsSum = optimizer.calculateCombinedResponse(frequencyResponses);
      const data = optimizer.displayResponse(optimizedSubsSum);

      // Create blob with data content
      const blob = new Blob([data], { type: 'text/plain;charset=utf-8' });

      // Save file using FileSaver
      await saveAs(blob, `sum.txt`);
    } catch (error) {
      throw new Error(`Failed to create sum: ${error.message}`, {
        cause: error,
      });
    }
  }

  async sendToREW(optimizedSubsSum, maximisedSumTitle) {
    const options = {
      identifier: maximisedSumTitle.slice(0, 24),
      isImpedance: false,
      startFreq: optimizedSubsSum.freqs[0],
      freqStep: optimizedSubsSum.freqStep,
      magnitude: optimizedSubsSum.magnitude,
      phase: optimizedSubsSum.phase,
      ppo: optimizedSubsSum.ppo,
    };
    await this.rewImport.importFrequencyResponseData(options);

    const lastMeasurementIndex = this.measurements().length;
    const item = await this.rewMeasurements.get(lastMeasurementIndex + 1, 0);
    const maximisedSum = await this.addMeasurement(item);

    if (!maximisedSum) {
      throw new Error('Error creating maximised sum');
    }

    await maximisedSum.applyWorkingSettings();
    await maximisedSum.setTargetLevel(this.mainTargetLevel());
    await maximisedSum.resetTargetSettings();

    return maximisedSum;
  }

  async copyMeasurementCommonAttributes() {
    console.time('copyMeasurements');

    for (const item of this.uniqueMeasurements()) {
      await item.copyAllToOther();
    }

    console.timeEnd('copyMeasurements');
  }

  updateTranslations(language) {
    this.translations(translations[language]);
    // Update any observable text that needs translation
    // Force Knockout to re-evaluate bindings
    ko.tasks.runEarly();
  }

  async produceSumProcess(subsList) {
    if (!subsList?.length) {
      throw new Error(`No subs found`);
    }
    if (subsList.length < 1) {
      throw new Error(`Not enough subs found to compute sum`);
    }
    const subResponsesTitles = subsList.map(response => response.title());
    lm.info(`Using: ${subResponsesTitles.join(', ')} to create subwoofer sum`);
    // get first subsList element position
    const position = subsList[0].position();
    const resultTitle = `${MeasurementItem.DEFAULT_LFE_PREDICTED}${position}`;

    const previousSubSum = this.measurements().find(item => item.title() === resultTitle);
    // remove previous
    await this.removeMeasurement(previousSubSum);
    // create sum of all subwoofer measurements
    const newDefaultLfePredicted = await this.businessTools.createsSum(
      subsList,
      resultTitle,
      true
    );
    newDefaultLfePredicted.isSubOperationResult = true;

    lm.info(`Subwoofer sum created successfully: ${newDefaultLfePredicted.title()}`);
    return newDefaultLfePredicted;
  }

  async loadData() {
    try {
      this.isLoading(true);
      if (!this.isPolling()) {
        // do not throw error, just log warning to allow offline ady loading
        lm.warn('Please connect to REW to load measurements');
        return;
      }

      const data = await this.rewMeasurements.list();

      const measurementsCount = Object.keys(data).length;
      if (measurementsCount > 0 && !this.jsonAvrData()?.avr) {
        // clear measurements to avoid inconsistency
        this.measurements([]);
        throw new Error(
          `${measurementsCount} Measurements detected in REW but no AVR information. please remove all measurements or load AVR information`
        );
      }

      this.mergeMeasurements(data);
    } catch (error) {
      throw new Error(`Failed to load data: ${error.message}`, {
        cause: error,
      });
    } finally {
      this.isLoading(false);
    }
  }

  mergeMeasurements(data) {
    const currentMeasurements = this.measurements();
    const newKeys = new Set(Object.values(data).map(m => m.uuid));

    // Update existing or create new measurements
    const mergedMeasurements = Object.entries(data).map(([key, item]) => {
      const existing = currentMeasurements.find(m => m.uuid === item.uuid);
      if (existing) return this.updateObservableObject(existing, item);

      lm.debug(`Create new measurement: ${key}: ${item.title}`);
      return new MeasurementItem(item, this);
    });

    this.measurements(mergedMeasurements);

    // Log deleted measurements
    for (const m of currentMeasurements) {
      if (!newKeys.has(m.uuid)) {
        lm.debug(`removed: ${m.uuid}`);
      }
    }

    // Clear orphaned associated filters
    for (const item of mergedMeasurements) {
      if (item.associatedFilter && !newKeys.has(item.associatedFilter)) {
        item.associatedFilter = null;
        lm.debug(`Removing filter: ${item.displayMeasurementTitle()}`);
      }
    }
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
    return this.measurements().find(m => m.uuid === uuid);
  }

  // add measurement
  async addMeasurementApi(itemUuid) {
    if (!itemUuid) {
      throw new Error('Add Measurement: Invalid measurement item');
    }
    const existingItem = this.findMeasurementByUuid(itemUuid);
    if (existingItem) {
      lm.warn(`measurement ${itemUuid} already exists, not added`);
      return existingItem;
    }
    try {
      const item = await this.rewMeasurements.get(itemUuid);
      // Transform data using the MeasurementItem class
      const measurementItem = new MeasurementItem(item, this);
      this.measurements.push(measurementItem);
      lm.debug(`measurement ${measurementItem.title()} added`);
      return measurementItem;
    } catch (error) {
      this.handleError(`Failed to add measurement: ${error.message}`, error);
      return false;
    }
  }

  // add measurement
  async addMeasurement(item) {
    if (!item) {
      throw new Error('Add Measurement: Invalid measurement item');
    }
    const existingItem = this.findMeasurementByUuid(item.uuid);
    if (existingItem) {
      lm.warn(
        `measurement ${existingItem.displayMeasurementTitle()} already exists, not added`
      );
      return existingItem;
    }
    const measurementItem =
      item instanceof MeasurementItem ? item : new MeasurementItem(item, this);
    this.measurements.push(measurementItem);
    lm.debug(`measurement ${measurementItem.title()} added`);
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

    lm.debug(`measurement ${item.displayMeasurementTitle()} removed`);

    return true;
  }

  async removeMeasurementUuid(itemUuid) {
    if (!itemUuid) {
      return false;
    }

    if (!this.findMeasurementByUuid(itemUuid)) {
      lm.debug('nothing to delete');
      return false;
    }

    try {
      // First attempt to delete from API to ensure consistency
      await this.rewMeasurements.delete(itemUuid);

      this.measurements.remove(item => item.uuid === itemUuid);

      lm.debug(`measurement ${itemUuid} removed`);

      return true; // Indicate successful deletion
    } catch (error) {
      if (error.message.includes('There is no measurement')) {
        lm.warn(`measurement ${itemUuid} not found, not removed`);
        return false;
      }
      throw new Error(`Failed to remove measurement: ${error.message}`, { cause: error });
    }
  }

  async findAligment(
    channelA,
    channelB,
    frequency,
    maxSearchRange = 3,
    createSum = false,
    sumTitle = null,
    minSearchRange = -0.5
  ) {
    if (createSum && !sumTitle) {
      throw new Error('sumTitle is required when createSum is true');
    }

    try {
      await this.rewAlignmentTool.setRemoveTimeDelay(false);
      await this.rewAlignmentTool.resetAll();
      await this.rewAlignmentTool.setMaxNegativeDelay(minSearchRange);
      await this.rewAlignmentTool.setMaxPositiveDelay(maxSearchRange);

      const AlignResults = await this.rewAlignmentTool.alignIRsBatch(
        channelA.uuid,
        channelB.uuid,
        frequency
      );

      if (!AlignResults.results) {
        throw new Error('alignment-tool: Invalid AlignResults object or missing results');
      }

      const AlignResultsDetails = AlignResults.results[0];

      if (AlignResultsDetails.Error?.length > 0) {
        throw new Error(AlignResultsDetails.Error);
      }

      const shiftDelayMs = Number(AlignResultsDetails['Delay B ms']);
      if (shiftDelayMs === undefined) {
        throw new Error(
          'alignment-tool: Invalid AlignResults object or missing Delay B ms'
        );
      }
      if (shiftDelayMs === maxSearchRange || shiftDelayMs === minSearchRange) {
        lm.warn('alignment-tool: Shift is maxed out to the limit: ' + shiftDelayMs);
      }
      const isBInverted = AlignResultsDetails['Invert B'] === 'true';

      if (isBInverted) {
        lm.warn('alignment-tool: Results provided were with toggled polarity');
      }
      if (createSum) {
        const alignedSum = await this.rewAlignmentTool.alignedSum();
        const alignedSumObject = await this.analyseApiResponse(alignedSum);
        await alignedSumObject.setTitle(sumTitle);
      }
      return { shiftDelay: shiftDelayMs / 1000, isBInverted };
    } catch (error) {
      throw new Error(`Alignment tool failed: ${error.message}`, { cause: error });
    }
  }

  async analyseApiResponse(commandResult) {
    if (!commandResult) {
      throw new Error('Invalid command result');
    }
    if (typeof commandResult !== 'object') {
      throw new TypeError('Command result must be an object');
    }

    // new measurement created
    const operationResultUuid = Object.values(
      commandResult.results || commandResult.message.results || {}
    )[0]?.UUID;
    if (!operationResultUuid) {
      throw new Error('No measurement UUID found in command result');
    }

    return this.addMeasurementApi(operationResultUuid);
  }

  //TODO: remove old findAligment when sure new one works fine
  async findAligmentNew(
    channelA,
    channelB,
    frequency,
    maxSearchRange = 2,
    createSum = false,
    sumTitle = null,
    minSearchRange = -0.5
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

  restore() {
    const data = store.load();
    if (!data) return;

    this.restoreAvrAndMeasurements(data);
    this.restoreSettings(data);
    this.restoreMeasurementGroups(data);
  }

  restoreAvrAndMeasurements(data) {
    if (!data.avrFileContent) return;
    this.jsonAvrData(data.avrFileContent);
    const enhancedMeasurements = Object.values(data.measurements).map(
      item => new MeasurementItem(item, this)
    );
    this.measurements(enhancedMeasurements);
  }

  restoreSettings(data) {
    data.apiBaseUrl && this.apiBaseUrl(data.apiBaseUrl);
    this.selectedSpeaker(data.selectedSpeaker);
    this.targetCurve(data.targetCurve);
    this.rewVersion(data.rewVersion);
    this.selectedLfeFrequency(data.selectedLfeFrequency);
    this.selectedAverageMethod(data.selectedAverageMethod);
    this.maxBoostIndividualValue(data.maxBoostIndividualValue || 0);
    this.maxBoostOverallValue(data.maxBoostOverallValue || 0);
    this.loadedFileName(data.loadedFileName || '');
    data.isPolling ? this.startBackgroundPolling() : this.stopBackgroundPolling();
    data.selectedSmoothingMethod &&
      this.selectedSmoothingMethod(data.selectedSmoothingMethod);
    data.selectedIrWindows && this.selectedIrWindows(data.selectedIrWindows);
    data.individualMaxBoostValue &&
      this.individualMaxBoostValue(+data.individualMaxBoostValue);
    data.overallBoostValue && this.overallBoostValue(+data.overallBoostValue);
    data.upperFrequencyBound && this.upperFrequencyBound(data.upperFrequencyBound);
    data.lowerFrequencyBound && this.lowerFrequencyBound(data.lowerFrequencyBound);
    data.ocaFileFormat && this.ocaFileFormat(data.ocaFileFormat);
    data.avrIpAddress && this.avrIpAddress(data.avrIpAddress);
    data.inhibitGraphUpdates !== undefined &&
      this.inhibitGraphUpdates(data.inhibitGraphUpdates);
    data.mainTargetLevel && this.mainTargetLevel(data.mainTargetLevel);
    data.SubsFrequencyBands && (this.SubsFrequencyBands = data.SubsFrequencyBands);
  }

  restoreMeasurementGroups(data) {
    if (!data.measurementsByGroup) return;
    for (const [key, saved] of Object.entries(data.measurementsByGroup)) {
      this.measurementsByGroup()[key]?.crossover(saved.crossover);
    }
  }

  saveMeasurements() {
    // Save to persistent store
    const reducedMeasurements = this.measurements().map(item => item.toJSON());
    const data = {
      measurements: reducedMeasurements,
      selectedSpeaker: this.selectedSpeaker(),
      targetCurve: this.targetCurve(),
      rewVersion: this.rewVersion(),
      selectedLfeFrequency: this.selectedLfeFrequency(),
      selectedAverageMethod: this.selectedAverageMethod(),
      maxBoostIndividualValue: this.maxBoostIndividualValue(),
      maxBoostOverallValue: this.maxBoostOverallValue(),
      avrFileContent: this.jsonAvrData(),
      loadedFileName: this.loadedFileName(),
      isPolling: this.isPolling(),
      selectedSmoothingMethod: this.selectedSmoothingMethod(),
      selectedIrWindows: this.selectedIrWindows(),
      individualMaxBoostValue: this.individualMaxBoostValue(),
      overallBoostValue: this.overallBoostValue(),
      upperFrequencyBound: this.upperFrequencyBound(),
      lowerFrequencyBound: this.lowerFrequencyBound(),
      apiBaseUrl: this.apiBaseUrl(),
      ocaFileFormat: this.ocaFileFormat(),
      avrIpAddress: this.avrIpAddress(),
      inhibitGraphUpdates: this.inhibitGraphUpdates(),
      measurementsByGroup: Object.fromEntries(
        Object.entries(this.measurementsByGroup()).map(([key, group]) => [
          key,
          { crossover: group.crossover() },
        ])
      ),
      mainTargetLevel: this.mainTargetLevel(),
      SubsFrequencyBands: this.SubsFrequencyBands,
    };
    // Convert observables to plain objects
    // const plainData = ko.toJS(data);
    store.save(data);
  }

  async startBackgroundPolling() {
    if (this.isPolling()) return;
    if (this.isProcessing()) return;
    if (this.isLoading()) return;
    if (this.hasError()) return;

    lm.info('Starting background polling...');

    try {
      // Initial load
      this.apiService = new RewApi(this.apiBaseUrl(), false, this.blocking);
      this.rewEq = this.apiService.rewEq;
      this.rewMeasurements = this.apiService.rewMeasurements;
      this.rewImport = this.apiService.rewImport;
      this.rewAlignmentTool = this.apiService.rewAlignmentTool;
      await this.apiService.initializeAPI();
      this.rewVersion(await this.apiService.checkVersion());
      this.maxMeasurements(await this.rewMeasurements.getMaxMeasurements());
      this.isPolling(true);
      await this.loadData();
      await this.setTargetLevelFromMeasurement();

      // Set up regular polling
      this.pollerId = setInterval(async () => {
        if (this.isPolling()) {
          if (this.isProcessing()) return;
          if (this.isLoading()) return;
          if (this.hasError()) return;
          await this.loadData();
        }
      }, this.pollingInterval);
    } catch (error) {
      this.stopBackgroundPolling();
      if (
        error.message.includes('Failed to fetch') ||
        error.message.includes('NetworkError')
      ) {
        this.handleError(
          `Failed to connect to REW API at ${this.apiBaseUrl()}. Please ensure the REW API server is running and accessible.`,
          error
        );
      } else {
        this.handleError(`Failed to start background polling: ${error.message}`, error);
      }
    }
  }

  stopBackgroundPolling() {
    this.isPolling(false);
    if (this.pollerId) {
      clearInterval(this.pollerId);
      this.pollerId = null;
    }
    this.apiService = null;
    this.rewEq = null;
    this.rewMeasurements = null;
    this.rewImport = null;
    this.rewAlignmentTool = null;
  }

  toggleBackgroundPolling() {
    if (this.isPolling()) {
      this.stopBackgroundPolling();
    } else {
      this.startBackgroundPolling();
    }
  }
}

export default MeasurementViewModel;
